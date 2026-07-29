import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { emitLog } from '../events.js';
import { store } from '../store/index.js';
import { recordGatewayUsage, usageTotals, usageSeries, usageByModel, usageByAccount, usageRows, quotaSeries, quotaForAccount, quotaHistoryCount, pruneQuotaHistory } from '../store/db.js';
import {
  pool,
  syncFromStore,
  savePersist,
  ensureReady,
  dispatcherFor,
  refreshQuota,
  geminiPct,
  NoAccountError,
  type PoolAccount,
  type Strategy,
} from './pool.js';
import {
  generate,
  generateStream,
  refreshAccessToken,
  checkModelsLive,
  MODELS,
  isImageModel,
  type ChatMessage,
  type GenResult,
} from './antigravity.js';

/**
 * Routes gateway: OpenAI-compatible (/proxy/v1) cho tool ngoài + quản lý (/api/gateway) cho tab UI.
 */

function log(email: string, level: string, msg: string) {
  emitLog({ runId: 0, email, flow: 'gateway', level, msg });
}

/** Log giàu cho live call→response. */
function emitGw(e: {
  kind: 'req' | 'res' | 'err';
  account: string;
  model: string;
  level?: string;
  msg: string;
  ms?: number;
  tokens?: number;
  proxy?: string;
  endpoint?: string;
  status?: number;
  attempt?: number;
}) {
  emitLog({
    runId: 0,
    email: e.account,
    flow: 'gateway',
    level: e.level ?? (e.kind === 'err' ? 'error' : 'info'),
    msg: e.msg,
    kind: e.kind,
    model: e.model,
    account: e.account,
    ms: e.ms,
    tokens: e.tokens,
    proxy: e.proxy,
    endpoint: e.endpoint,
    status: e.status,
    attempt: e.attempt,
  });
}

/** Ghi usage + (tuỳ chọn) cập nhật quota kèm mỗi lần gọi. */
function afterCall(account: PoolAccount, model: string, r: { ok: boolean; promptTokens?: number; completionTokens?: number; ms: number }) {
  recordGatewayUsage({
    ts: Date.now(),
    email: account.email,
    model,
    promptTokens: r.promptTokens ?? 0,
    completionTokens: r.completionTokens ?? 0,
    ok: r.ok,
    ms: r.ms,
  });
  if (r.ok && config.gateway.quota?.onCall) {
    refreshQuota(account).catch(() => {}); // nền, không chặn
  }
}

function proxyLabelOf(account: PoolAccount, override?: string): string {
  return override || account.proxyLabel || (config.gateway.outboundProxy ? 'global' : 'direct');
}

function strategy(): Strategy {
  return (config.gateway.rotation as Strategy) || 'round-robin';
}

/** Kiểm API key nếu có cấu hình. Trả true nếu hợp lệ (hoặc không yêu cầu). */
function authOk(req: FastifyRequest): boolean {
  const key = config.gateway.apiKey;
  if (!key) return true;
  const h = (req.headers['authorization'] || '') as string;
  return h === `Bearer ${key}` || h === key;
}

/** Chọn account (ép email nếu có) + lấy access_token/project sẵn sàng. */
async function pickReady(
  forcedEmail: string | undefined,
  proxyOverride: string | undefined,
): Promise<{ account: PoolAccount; accessToken: string; projectId: string; dispatcher: any }> {
  let account: PoolAccount;
  if (forcedEmail) {
    const a = pool.accounts.get(forcedEmail);
    if (!a) throw new NoAccountError(`Account ${forcedEmail} không có trong pool`);
    if (!a.enabled) throw new NoAccountError(`Account ${forcedEmail} đang tắt`);
    account = a;
    account.inflight++; // đối xứng với pool.release() ở finally
  } else {
    account = pool.pick(strategy()); // pick đã inflight++
  }
  try {
    const dispatcher = dispatcherFor(account, proxyOverride);
    const { accessToken, projectId } = await ensureReady(account, dispatcher);
    return { account, accessToken, projectId, dispatcher };
  } catch (e) {
    pool.release(account.email); // chuẩn bị token/project lỗi → trả lại inflight
    throw e;
  }
}

function toMessages(body: any): ChatMessage[] {
  if (Array.isArray(body?.messages)) return body.messages as ChatMessage[];
  if (typeof body?.content === 'string') return [{ role: 'user', content: body.content }];
  if (typeof body?.prompt === 'string') return [{ role: 'user', content: body.prompt }];
  return [{ role: 'user', content: '' }];
}

function openaiCompletion(model: string, r: GenResult) {
  let content = r.text;
  for (const img of r.images) content += (content ? '\n\n' : '') + `![image](${img})`;
  return {
    id: 'chatcmpl-' + randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: r.finishReason || 'stop' }],
    usage: {
      prompt_tokens: r.usage.promptTokens,
      completion_tokens: r.usage.completionTokens,
      total_tokens: r.usage.totalTokens,
    },
  };
}

function sseInit(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function sseChunk(reply: FastifyReply, model: string, id: string, delta: any, finish: string | null) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export async function registerGatewayRoutes(app: FastifyInstance): Promise<void> {
  syncFromStore();

  // ---------------- OpenAI-compatible ----------------
  app.get('/proxy/v1/models', async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send({ error: 'unauthorized' });
    return {
      object: 'list',
      data: MODELS.map((m) => ({ id: m.id, object: 'model', owned_by: 'antigravity' })),
    };
  });

  app.post('/proxy/v1/chat/completions', async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send({ error: 'unauthorized' });
    if (!config.gateway.enabled) return reply.code(503).send({ error: 'gateway disabled' });
    const body = req.body as any;
    const model = body?.model || 'gemini-3-pro-low';
    const messages = toMessages(body);
    const stream = !!body?.stream;
    syncFromStore();

    // thử tối đa vài account (failover tự nhiên qua strategy)
    const maxTry = Math.min(3, Math.max(1, pool.candidates().length));
    let lastErr: any;
    for (let attempt = 0; attempt < maxTry; attempt++) {
      let ctx: Awaited<ReturnType<typeof pickReady>>;
      try {
        ctx = await pickReady(undefined, undefined);
      } catch (e) {
        lastErr = e;
        break;
      }
      const t0 = Date.now();
      const plabel = proxyLabelOf(ctx.account);
      emitGw({ kind: 'req', account: ctx.account.email, model, proxy: plabel, endpoint: '/proxy/v1', attempt: attempt + 1, msg: `→ ${model} · ${ctx.account.email}${stream ? ' (stream)' : ''} · proxy:${plabel}` });
      try {
        if (stream) {
          sseInit(reply);
          const id = 'chatcmpl-' + randomUUID();
          let pt = 0;
          let ct = 0;
          for await (const ev of generateStream({
            accessToken: ctx.accessToken,
            projectId: ctx.projectId,
            model,
            messages,
            dispatcher: ctx.dispatcher,
          })) {
            if (ev.delta) sseChunk(reply, model, id, { content: ev.delta }, null);
            if (ev.image) sseChunk(reply, model, id, { content: `\n![image](${ev.image})` }, null);
            if (ev.usage) {
              pt = ev.usage.promptTokens;
              ct = ev.usage.completionTokens;
            }
          }
          sseChunk(reply, model, id, {}, 'stop');
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
          const ms = Date.now() - t0;
          pool.report(ctx.account.email, { ok: true, promptTokens: pt, completionTokens: ct });
          afterCall(ctx.account, model, { ok: true, promptTokens: pt, completionTokens: ct, ms });
          savePersist();
          emitGw({ kind: 'res', account: ctx.account.email, model, ms, tokens: pt + ct, status: 200, msg: `← 200 · stream · ${pt + ct} tok · ${ms}ms` });
          return reply;
        } else {
          const r = await generate({
            accessToken: ctx.accessToken,
            projectId: ctx.projectId,
            model,
            messages,
            dispatcher: ctx.dispatcher,
          });
          const ms = Date.now() - t0;
          pool.report(ctx.account.email, {
            ok: true,
            promptTokens: r.usage.promptTokens,
            completionTokens: r.usage.completionTokens,
          });
          afterCall(ctx.account, model, { ok: true, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, ms });
          savePersist();
          emitGw({ kind: 'res', account: ctx.account.email, model, ms, tokens: r.usage.totalTokens, status: 200, msg: `← 200 · ${r.usage.totalTokens} tok · ${ms}ms` });
          return reply.send(openaiCompletion(model, r));
        }
      } catch (e: any) {
        lastErr = e;
        const ms = Date.now() - t0;
        pool.report(ctx.account.email, { ok: false, status: e?.status, err: e?.message });
        afterCall(ctx.account, model, { ok: false, ms });
        emitGw({ kind: 'err', account: ctx.account.email, model, ms, status: e?.status, msg: `← ✗ ${e?.status ?? ''} ${String(e?.message ?? e).slice(0, 100)}` });
        if (stream && reply.raw.headersSent) {
          reply.raw.end();
          return reply;
        }
        // thử account kế
      } finally {
        pool.release(ctx.account.email);
      }
    }
    const code = lastErr instanceof NoAccountError ? 503 : 502;
    return reply.code(code).send({ error: lastErr?.message ?? 'all accounts failed' });
  });

  // ---------------- Quản lý (tab UI) ----------------
  app.get('/api/gateway/accounts', async () => {
    syncFromStore();
    const now = Date.now();
    return {
      accounts: pool.list().map((a) => ({
        email: a.email,
        enabled: a.enabled,
        health: a.health,
        requests: a.requests,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        lastUsed: a.lastUsed,
        cooldown: (a.cooldownUntil || 0) > now,
        cooldownUntil: a.cooldownUntil,
        lastError: a.lastError,
        quota: a.quota ?? null,
        geminiPct: geminiPct(a),
        liveStatus: a.liveStatus ?? null,
        hasProxy: !!a.proxyLabel,
      })),
    };
  });

  app.post('/api/gateway/accounts/:email/toggle', async (req) => {
    const { email } = req.params as { email: string };
    const { enabled } = (req.body as { enabled?: boolean }) ?? {};
    const a = pool.accounts.get(email);
    if (a) a.enabled = enabled ?? !a.enabled;
    savePersist();
    return { ok: !!a, enabled: a?.enabled };
  });

  app.post('/api/gateway/accounts/bulk', async (req) => {
    const { emails, enabled } = (req.body as { emails?: string[]; enabled?: boolean }) ?? {};
    let n = 0;
    const list = emails && emails.length ? emails : pool.list().map((a) => a.email);
    for (const e of list) {
      const a = pool.accounts.get(e);
      if (a) {
        a.enabled = !!enabled;
        n++;
      }
    }
    savePersist();
    return { updated: n };
  });

  app.get('/api/gateway/config', async () => ({
    enabled: config.gateway.enabled,
    rotation: config.gateway.rotation,
    apiKey: config.gateway.apiKey,
    outboundProxy: config.gateway.outboundProxy,
    cooldownSec: config.gateway.cooldownSec,
    quota: config.gateway.quota,
    baseUrl: `http://localhost:${config.port}/proxy/v1`,
  }));

  app.patch('/api/gateway/config', async (req) => {
    const b = (req.body as any) ?? {};
    if (typeof b.enabled === 'boolean') config.gateway.enabled = b.enabled;
    if (b.rotation) config.gateway.rotation = b.rotation;
    if (typeof b.outboundProxy === 'string') config.gateway.outboundProxy = b.outboundProxy;
    if (typeof b.cooldownSec === 'number') config.gateway.cooldownSec = b.cooldownSec;
    if (b.quota && typeof b.quota === 'object') {
      const q = config.gateway.quota;
      if (typeof b.quota.autoRefresh === 'boolean') q.autoRefresh = b.quota.autoRefresh;
      if (typeof b.quota.intervalMin === 'number') q.intervalMin = b.quota.intervalMin;
      if (typeof b.quota.onCall === 'boolean') q.onCall = b.quota.onCall;
      if (typeof b.quota.cacheTtlMin === 'number') q.cacheTtlMin = b.quota.cacheTtlMin;
    }
    if (b.regenerateKey) config.gateway.apiKey = 'agy-' + randomUUID().replace(/-/g, '');
    else if (typeof b.apiKey === 'string') config.gateway.apiKey = b.apiKey;
    return { ok: true, config: { ...config.gateway } };
  });

  app.get('/api/gateway/models', async () => ({
    models: MODELS.map((m) => ({ id: m.id, label: m.label, image: m.image })),
  }));

  // Chat thử qua pool (hoặc ép 1 account) — trả text + images (non-stream, dễ render).
  app.post('/api/gateway/chat', async (req, reply) => {
    const b = req.body as any;
    const model = b?.model || 'gemini-3-pro-low';
    const messages = toMessages(b);
    const forced = b?.account && b.account !== 'auto' ? String(b.account) : undefined;
    const proxy = b?.proxy ? String(b.proxy) : undefined;
    syncFromStore();
    const t0 = Date.now();
    let ctx: Awaited<ReturnType<typeof pickReady>>;
    try {
      ctx = await pickReady(forced, proxy);
    } catch (e: any) {
      return reply.code(e?.code ?? 503).send({ error: e?.message ?? 'no account' });
    }
    const plabel = proxyLabelOf(ctx.account, proxy);
    emitGw({ kind: 'req', account: ctx.account.email, model, proxy: plabel, endpoint: 'chat-test', msg: `→ ${model} · ${ctx.account.email} · chat-test · proxy:${plabel}` });
    try {
      const r = await generate({
        accessToken: ctx.accessToken,
        projectId: ctx.projectId,
        model,
        messages,
        dispatcher: ctx.dispatcher,
      });
      const ms = Date.now() - t0;
      pool.report(ctx.account.email, {
        ok: true,
        promptTokens: r.usage.promptTokens,
        completionTokens: r.usage.completionTokens,
      });
      afterCall(ctx.account, model, { ok: true, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, ms });
      savePersist();
      emitGw({ kind: 'res', account: ctx.account.email, model, ms, tokens: r.usage.totalTokens, status: 200, msg: `← 200 · ${r.usage.totalTokens} tok · ${ms}ms` });
      return {
        ok: true,
        account: ctx.account.email,
        model,
        ms,
        text: r.text,
        images: r.images,
        usage: r.usage,
        isImage: isImageModel(model),
      };
    } catch (e: any) {
      const ms = Date.now() - t0;
      pool.report(ctx.account.email, { ok: false, status: e?.status, err: e?.message });
      afterCall(ctx.account, model, { ok: false, ms });
      emitGw({ kind: 'err', account: ctx.account.email, model, ms, status: e?.status, msg: `← ✗ ${e?.status ?? ''} ${String(e?.message ?? e).slice(0, 100)}` });
      return reply.code(502).send({ ok: false, account: ctx.account.email, error: e?.message ?? String(e) });
    } finally {
      pool.release(ctx.account.email);
    }
  });

  // ---------------- Hạn mức (quota) ----------------
  app.post('/api/gateway/quota/:email', async (req, reply) => {
    const { email } = req.params as { email: string };
    syncFromStore();
    const a = pool.accounts.get(email);
    if (!a) return reply.code(404).send({ error: 'không có account' });
    try {
      const q = await refreshQuota(a, true);
      return { ok: true, email, quota: q };
    } catch (e: any) {
      return reply.code(502).send({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post('/api/gateway/quota/refresh', async (req) => {
    const { emails } = (req.body as { emails?: string[] }) ?? {};
    syncFromStore();
    const targets = (emails && emails.length ? emails.map((e) => pool.accounts.get(e)).filter(Boolean) : pool.list().filter((a) => a.enabled)) as PoolAccount[];
    // chạy nền tuần tự, giãn nhịp nhẹ
    (async () => {
      let done = 0;
      for (const a of targets) {
        try {
          await refreshQuota(a, true);
          done++;
          log(a.email, 'info', `quota ${geminiPct(a) ?? '?'}% (refresh ${done}/${targets.length})`);
        } catch (e: any) {
          log(a.email, 'warn', `quota lỗi: ${String(e?.message ?? e).slice(0, 80)}`);
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    })().catch(() => {});
    return { queued: targets.length };
  });

  app.get('/api/gateway/quota-summary', async () => {
    const withQuota = pool.list().filter((a) => a.quota);
    const gem = withQuota.map((a) => geminiPct(a) ?? 0);
    const tp = withQuota.map((a) => a.quota?.groups?.find((g) => !/gemini/i.test(g.name))?.pct ?? 0);
    const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : null);
    const tierCount: Record<string, number> = {};
    for (const a of withQuota) if (a.quota?.tier) tierCount[a.quota.tier] = (tierCount[a.quota.tier] || 0) + 1;
    return {
      fetched: withQuota.length,
      total: pool.list().length,
      geminiAvg: avg(gem),
      geminiMin: gem.length ? Math.min(...gem) : null,
      thirdPartyAvg: avg(tp),
      tiers: tierCount,
    };
  });

  // ---------------- Test lẻ (còn sống?) ----------------
  async function testAccount(a: PoolAccount): Promise<{ alive: boolean; ms: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const dispatcher = dispatcherFor(a);
      const tok = await refreshAccessToken(a.refreshToken, dispatcher);
      a.token = tok;
      a.health = 'alive';
      store.setCredentialHealth(a.email, 'agy', 'alive');
      return { alive: true, ms: Date.now() - t0 };
    } catch (e: any) {
      a.health = 'dead';
      store.setCredentialHealth(a.email, 'agy', 'dead');
      return { alive: false, ms: Date.now() - t0, detail: String(e?.message ?? e).slice(0, 120) };
    }
  }

  /** Check live: account có gọi model thật được không (khác check token). */
  async function checkLiveAccount(a: PoolAccount): Promise<{ status: 'ok' | 'quota' | 'error'; ms: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const dispatcher = dispatcherFor(a);
      const { accessToken, projectId } = await ensureReady(a, dispatcher);
      await generate({ accessToken, projectId, model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], dispatcher, generationConfig: { maxOutputTokens: 8 } });
      a.health = 'alive';
      a.liveStatus = 'ok';
      return { status: 'ok', ms: Date.now() - t0 };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const quota = e?.status === 429 || /quota|exhaust|resource_exhausted/i.test(msg);
      if (e?.status === 401 || /invalid_grant/i.test(msg)) a.health = 'dead';
      a.liveStatus = quota ? 'quota' : 'error';
      return { status: quota ? 'quota' : 'error', ms: Date.now() - t0, detail: msg.slice(0, 120) };
    }
  }

  /** Emit sự kiện check realtime cho UI cập nhật từng dòng. */
  function emitCheck(email: string, kind: 'token' | 'live', result: string, level: string, done?: number, total?: number) {
    emitLog({ runId: 0, email, flow: 'gateway', level, msg: `${kind === 'live' ? 'check live' : 'check token'}: ${result}${done ? ` (${done}/${total})` : ''}`, kind: 'check', account: email, check: { kind, result, done, total } });
  }

  app.post('/api/gateway/accounts/:email/test', async (req, reply) => {
    const { email } = req.params as { email: string };
    syncFromStore();
    const a = pool.accounts.get(email);
    if (!a) return reply.code(404).send({ error: 'không có account' });
    const r = await testAccount(a);
    emitCheck(email, 'token', r.alive ? 'alive' : 'dead', r.alive ? 'info' : 'warn');
    return { ok: true, email, ...r };
  });

  app.post('/api/gateway/accounts/:email/checklive', async (req, reply) => {
    const { email } = req.params as { email: string };
    syncFromStore();
    const a = pool.accounts.get(email);
    if (!a) return reply.code(404).send({ error: 'không có account' });
    const r = await checkLiveAccount(a);
    emitCheck(email, 'live', r.status, r.status === 'ok' ? 'info' : r.status === 'quota' ? 'warn' : 'error');
    return { ok: true, email, ...r };
  });

  /** Check hàng loạt token/live/both — chạy nền, emit realtime từng account. */
  app.post('/api/gateway/accounts/check', async (req) => {
    const { emails, mode } = (req.body as { emails?: string[]; mode?: 'token' | 'live' | 'both' }) ?? {};
    const m = mode || 'token';
    syncFromStore();
    const targets = (emails && emails.length ? emails.map((e) => pool.accounts.get(e)).filter(Boolean) : pool.list()) as PoolAccount[];
    const total = targets.length;
    (async () => {
      let i = 0, okc = 0;
      for (const a of targets) {
        i++;
        if (m === 'token' || m === 'both') {
          const r = await testAccount(a);
          emitCheck(a.email, 'token', r.alive ? 'alive' : 'dead', r.alive ? 'info' : 'warn', i, total);
          if (!r.alive) { await new Promise((r) => setTimeout(r, 250)); continue; } // token chết thì khỏi check live
        }
        if (m === 'live' || m === 'both') {
          const r = await checkLiveAccount(a);
          if (r.status === 'ok') okc++;
          emitCheck(a.email, 'live', r.status, r.status === 'ok' ? 'info' : r.status === 'quota' ? 'warn' : 'error', i, total);
        } else if (m === 'token') {
          okc += a.health === 'alive' ? 1 : 0;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      savePersist();
      log('', 'info', `Check ${m} xong: ${okc}/${total} ok`);
    })().catch(() => {});
    return { queued: total, mode: m };
  });

  // giữ tương thích: test-bulk = check mode token
  app.post('/api/gateway/accounts/test-bulk', async (req) => {
    const { emails } = (req.body as { emails?: string[] }) ?? {};
    syncFromStore();
    const targets = (emails && emails.length ? emails.map((e) => pool.accounts.get(e)).filter(Boolean) : pool.list()) as PoolAccount[];
    const total = targets.length;
    (async () => {
      let i = 0;
      for (const a of targets) {
        i++;
        const r = await testAccount(a);
        emitCheck(a.email, 'token', r.alive ? 'alive' : 'dead', r.alive ? 'info' : 'warn', i, total);
        await new Promise((r) => setTimeout(r, 300));
      }
      savePersist();
    })().catch(() => {});
    return { queued: total };
  });

  // ---------------- Check live model ----------------
  app.post('/api/gateway/models/check', async (req, reply) => {
    syncFromStore();
    let ctx: Awaited<ReturnType<typeof pickReady>>;
    try {
      ctx = await pickReady(undefined, undefined);
    } catch (e: any) {
      return reply.code(e?.code ?? 503).send({ error: e?.message ?? 'no account' });
    }
    const results = await checkModelsLive(ctx.accessToken, ctx.projectId, ctx.dispatcher);
    log(ctx.account.email, 'info', `check live model qua ${ctx.account.email}: ${results.filter((r) => r.status === 'ok').length}/${results.length} ok`);
    return { account: ctx.account.email, models: results };
  });

  // ---------------- Báo cáo sử dụng ----------------
  function rangeOf(req: FastifyRequest): { from: number; to: number; groupBy: 'day' | 'week' } {
    const q = req.query as any;
    const to = q.to ? Number(q.to) : Date.now();
    const days = q.range === '30d' ? 30 : q.range === '90d' ? 90 : 7;
    const from = q.from ? Number(q.from) : to - days * 86400_000;
    const groupBy = q.groupBy === 'week' ? 'week' : 'day';
    return { from, to, groupBy };
  }

  app.get('/api/gateway/usage', async (req) => {
    const { from, to, groupBy } = rangeOf(req);
    return {
      totals: usageTotals(from, to),
      series: usageSeries(from, to, groupBy),
      byModel: usageByModel(from, to),
      byAccount: usageByAccount(from, to),
    };
  });

  app.get('/api/gateway/usage/export.csv', async (req, reply) => {
    const { from, to } = rangeOf(req);
    const rows = usageRows(from, to);
    const head = 'ts,datetime,email,model,prompt_tokens,completion_tokens,ok,ms\n';
    const body = rows
      .map((r) => `${r.ts},${new Date(r.ts).toISOString()},${r.email},${r.model},${r.promptTokens},${r.completionTokens},${r.ok ? 1 : 0},${r.ms}`)
      .join('\n');
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="gateway-usage.csv"');
    return head + body;
  });

  // ---------------- Lịch sử hạn mức ----------------
  app.get('/api/gateway/quota/history', async (req) => {
    const q = req.query as any;
    const to = q.to ? Number(q.to) : Date.now();
    const days = q.range === '90d' ? 90 : q.range === '30d' ? 30 : q.range === '1d' ? 1 : 7;
    const from = q.from ? Number(q.from) : to - days * 86400_000;
    const groupBy = q.groupBy === 'hour' || days <= 1 ? 'hour' : 'day';
    if (q.email) {
      return { email: q.email, points: quotaForAccount(String(q.email), from, to) };
    }
    return { series: quotaSeries(from, to, groupBy), groupBy, total: quotaHistoryCount() };
  });

  // ---------------- Auto refresh quota (nền, ÁP NÓNG) ----------------
  // Timer tự lên lịch lại mỗi vòng → bật/tắt & đổi chu kỳ có hiệu lực NGAY, không cần restart.
  let quotaTimer: NodeJS.Timeout | null = null;
  const scheduleQuotaLoop = () => {
    if (quotaTimer) clearTimeout(quotaTimer);
    const mins = Math.max(1, config.gateway.quota?.intervalMin ?? 30);
    quotaTimer = setTimeout(async () => {
      if (config.gateway.quota?.autoRefresh) {
        for (const a of pool.list().filter((x) => x.enabled)) {
          await refreshQuota(a).catch(() => {});
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      scheduleQuotaLoop();
    }, mins * 60_000);
    quotaTimer.unref?.();
  };
  scheduleQuotaLoop();

  // Dọn lịch sử cũ (theo cấu hình, mặc định 90 ngày): lúc boot + mỗi 24h.
  const prune = () => {
    try {
      pruneQuotaHistory(config.gateway.quota?.historyDays ?? 90);
    } catch { /* bỏ qua */ }
  };
  prune();
  setInterval(prune, 24 * 3600_000).unref?.();
}
