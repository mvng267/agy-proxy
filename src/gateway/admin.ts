import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { config, applyConfig } from '../config.js';
import { createApiKey, listPublicApiKeys, patchApiKey, removeApiKey } from './apikeys.js';
import {
  usageTotals, usageSeries, usageByModel, usageByAccount, usageRows, usageSamples,
  quotaSeries, quotaForAccount, quotaHistoryCount,
  getComboRow, upsertComboRow, deleteComboRow, comboStatsRows,
  providerStats, creditsUsedThisMonth,
  usageByApiKey, usageByCombo, attributionSince, type UsageFilter,
  metricsSeries, metricsHistoryCount, getSetting, setSetting,
} from '../store/db.js';
import {
  PROVIDERS, PROVIDER_IDS, allModels, parseModelId,
  type ParsedModel, type ProviderId,
} from './providers/index.js';
import {
  planAuto, validateTargets, AUTO_VARIANT_IDS, AUTO_VARIANTS, scoreCandidates,
} from './combo.js';
import {
  pool, syncFromStore, savePersist, refreshQuota, geminiPct, claudePct,
  type PoolAccount,
} from './pool.js';
import { isImageModel } from './antigravity.js';
import {
  log, emitGw, afterCall, proxyLabelOf, accOf, bucketOf, pickReady, poolSnapshot,
  listCombos, testAccount, checkLiveAccount, emitCheck, runProviderCall,
} from './engine.js';
import { toMessages } from './dialects/wire.js';
import { gatewayMetrics } from './metrics.js';
import { providerBreaker } from './breaker.js';

/**
 * Admin API cho dashboard: quản lý account/key/config/combo, báo cáo usage & quota,
 * health check. Toàn bộ nằm sau xác thực dashboard (xem src/auth.ts).
 */

/** `agy-94d9…e86c` — đủ để nhận ra key nào, không đủ để dùng. */
function maskKey(k: string): string {
  if (!k) return '';
  if (k.length <= 12) return '•'.repeat(k.length);
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

export function registerAdminRoutes(app: FastifyInstance): void {
  // ---------------- Accounts ----------------
  app.get('/api/gateway/accounts', async (req) => {
    syncFromStore();
    const now = Date.now();
    const q = (req.query ?? {}) as any;
    const only = q.provider && PROVIDERS[q.provider as ProviderId] ? (q.provider as ProviderId) : undefined;
    const used = creditsUsedThisMonth('kr/'); // Kiro không có API usage → đếm tại chỗ
    const withModels = String((req.query as any)?.withModels ?? '') === '1';
    const limit = config.gateway.kiroCreditLimit;
    return {
      counts: Object.fromEntries(PROVIDER_IDS.map((p) => [p, pool.list(p).length])),
      creditLimit: limit,
      accounts: pool.list(only).map((a) => ({
        creditsUsed: a.provider === 'kr' ? used[a.email] ?? 0 : undefined,
        creditsLimit: a.provider === 'kr' ? limit : undefined,
        provider: a.provider,
        providerLabel: PROVIDERS[a.provider].label,
        key: a.key,
        email: a.email,
        enabled: a.enabled,
        health: a.health,
        requests: a.requests,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        lastUsed: a.lastUsed,
        cooldown: (a.cooldownUntil || 0) > now,
        // Bỏ hẳn trường mang giá trị MẶC ĐỊNH: với 700 account, chở số 0 và chuỗi rỗng
        // qua mạng mỗi 10s là lãng phí thật. Client dùng `?? 0` / `?? ''` như bình thường.
        ...(a.cooldownUntil ? { cooldownUntil: a.cooldownUntil } : {}),
        ...(a.monthlyExhaustedUntil ? { monthlyExhaustedUntil: a.monthlyExhaustedUntil } : {}),
        ...(a.lastError ? { lastError: a.lastError } : {}),
        // `inflight` có trong PoolAccount nhưng trước đây không được map ra — thiếu nó thì
        // không quan sát được account "đang bận", và cũng không kiểm chứng được rò rỉ.
        ...(a.inflight ? { inflight: a.inflight } : {}),
        ...(a.lastAttempt ? { lastAttempt: a.lastAttempt } : {}),
        ...(a.consecutiveFails ? { consecutiveFails: a.consecutiveFails } : {}),
        // Thời điểm cập nhật quota gần nhất + có quá hạn TTL chưa — để UI hiện
        // "cập nhật X phút trước" thay vì hiển thị số cũ như thể vừa đo.
        ...(a.quota?.fetchedAt ? { quotaFetchedAt: a.quota.fetchedAt } : {}),
        ...(a.quota && Date.now() - (a.quota.fetchedAt ?? 0) > (config.gateway.quota?.cacheTtlMin ?? 10) * 60_000
          ? { quotaStale: true }
          : {}),
        ...(a.bucketCooldown ? { bucketCooldown: a.bucketCooldown } : {}),
        /**
         * Payload mặc định KHÔNG kèm `quota` — nó chiếm phần lớn kích thước (models[] 24
         * phần tử/account, groups[] lặp lại % đã có ở `geminiPct`/`claudePct` bên dưới).
         * Trang Pool poll mỗi 10s nên đây là chi phí thật.
         * Trang Quota gọi `?withModels=1` để lấy đầy đủ.
         */
        ...(withModels ? { quota: a.quota ?? null } : {}),
        ...(a.quota?.tier ? { tier: a.quota.tier } : {}),
        ...(geminiPct(a) != null ? { geminiPct: geminiPct(a) } : {}),
        ...(claudePct(a) != null ? { claudePct: claudePct(a) } : {}),
        ...(a.liveStatus ? { liveStatus: a.liveStatus } : {}),
        ...(a.proxyLabel ? { hasProxy: true } : {}),
      })),
    };
  });

  app.post('/api/gateway/accounts/:email/toggle', async (req) => {
    const { email } = req.params as { email: string };
    const { enabled } = (req.body as { enabled?: boolean }) ?? {};
    const a = accOf(req, email);
    if (a) a.enabled = enabled ?? !a.enabled;
    savePersist();
    return { ok: !!a, enabled: a?.enabled };
  });

  app.post('/api/gateway/accounts/bulk', async (req) => {
    const { emails, enabled } = (req.body as { emails?: string[]; enabled?: boolean }) ?? {};
    let n = 0;
    const list = emails && emails.length ? emails : pool.list().map((a) => a.email);
    for (const e of list) {
      const a = e.includes(':') ? pool.getByKey(e) : pool.get(e, 'agy');
      if (a) {
        a.enabled = !!enabled;
        n++;
      }
    }
    savePersist();
    return { updated: n };
  });

  /**
   * Gỡ cooldown hàng loạt. Cần khi một sự cố phía upstream (vd đợt 429 diện rộng, hoặc
   * request sai tham số làm cháy cả pool) parked hàng trăm account: chờ hết cooldown thì
   * lâu, mà lỗi đã sửa xong rồi. KHÔNG đụng tới `health`/`enabled` — chỉ xoá thời gian nghỉ.
   */
  app.post('/api/gateway/accounts/wake', async (req) => {
    const { emails, provider } = (req.body as { emails?: string[]; provider?: ProviderId }) ?? {};
    syncFromStore();
    const now = Date.now();
    const list = emails?.length
      ? emails.map((e) => (e.includes(':') ? pool.getByKey(e) : pool.get(e, provider ?? 'agy')))
      : pool.list(provider && PROVIDERS[provider] ? provider : undefined);
    let woken = 0;
    for (const a of list) {
      if (a && (a.cooldownUntil || 0) > now) {
        a.cooldownUntil = 0;
        a.monthlyExhaustedUntil = 0;
        if (a.liveStatus === 'quota') a.liveStatus = undefined;
        woken++;
      }
    }
    savePersist();
    return { woken };
  });

  // ---------------- API keys (nhiều key, mỗi key 1 user) ----------------
  // Chỉ để ĐỊNH DANH cho báo cáo — mọi key dùng chung model/pool, không giới hạn hạn mức.
  app.get('/api/gateway/keys', async () => ({ keys: listPublicApiKeys() }));

  app.post('/api/gateway/keys', async (req, reply) => {
    const b = (req.body as { name?: string; note?: string }) ?? {};
    const name = (b.name ?? '').trim();
    if (!name) return reply.code(400).send({ ok: false, error: 'Thiếu tên key' });
    const c = createApiKey(name, b.note);
    // `key` thô CHỈ trả đúng lần này — DB chỉ giữ sha256, không thể lấy lại.
    return { ok: true, id: c.id, name: c.name, prefix: c.prefix, key: c.key };
  });

  app.patch('/api/gateway/keys/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body as { name?: string; note?: string; enabled?: boolean }) ?? {};
    if (!patchApiKey(id, b)) return reply.code(404).send({ ok: false, error: 'Không tìm thấy key' });
    return { ok: true };
  });

  app.delete('/api/gateway/keys/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Usage cũ giữ api_key_id mồ côi CÓ CHỦ ĐÍCH — báo cáo lịch sử không được biến mất.
    if (!removeApiKey(id)) return reply.code(404).send({ ok: false, error: 'Không tìm thấy key' });
    return { ok: true };
  });

  // ---------------- Config ----------------
  /**
   * Che apiKey mặc định — trước đây endpoint này trả key NGUYÊN VĂN, nên key rơi vào
   * log proxy, tab Network, ảnh chụp màn hình chia sẻ. Key thật lấy qua
   * `?reveal=1`, một hành động có chủ đích của người dùng (nút "Hiện" ở trang Cấu hình).
   * Key mới (bảng api_keys) KHÔNG bao giờ lộ ở đây: chỉ hiện đúng một lần lúc tạo.
   */
  app.get('/api/gateway/config', async (req) => ({
    enabled: config.gateway.enabled,
    rotation: config.gateway.rotation,
    apiKey: (req.query as any)?.reveal === '1' ? config.gateway.apiKey : maskKey(config.gateway.apiKey),
    apiKeyMasked: (req.query as any)?.reveal !== '1',
    outboundProxy: config.gateway.outboundProxy,
    cooldownSec: config.gateway.cooldownSec,
    quota: config.gateway.quota,
    baseUrl: `http://localhost:${config.port}/proxy/v1`,
  }));

  // Tương thích ngược (trang Pool dùng) — nay GHI DB qua setConfig để sống qua restart.
  app.patch('/api/gateway/config', async (req) => {
    const b = (req.body as any) ?? {};
    const patch: Record<string, unknown> = {};
    if (typeof b.enabled === 'boolean') patch.gatewayEnabled = b.enabled;
    if (b.rotation) patch.gatewayRotation = b.rotation;
    if (typeof b.outboundProxy === 'string') patch.gatewayProxy = b.outboundProxy;
    if (typeof b.cooldownSec === 'number') patch.gatewayCooldownSec = b.cooldownSec;
    if (b.quota && typeof b.quota === 'object') {
      if (typeof b.quota.autoRefresh === 'boolean') patch.quotaAutoRefresh = b.quota.autoRefresh;
      if (typeof b.quota.intervalMin === 'number') patch.quotaIntervalMin = b.quota.intervalMin;
      if (typeof b.quota.onCall === 'boolean') patch.quotaOnCall = b.quota.onCall;
      if (typeof b.quota.cacheTtlMin === 'number') patch.quotaCacheTtlMin = b.quota.cacheTtlMin;
    }
    if (b.regenerateKey) patch.gatewayApiKey = 'agy-' + randomUUID().replace(/-/g, '');
    else if (typeof b.apiKey === 'string') patch.gatewayApiKey = b.apiKey;
    // TRƯỚC ĐÂY vứt `rejected` rồi vẫn trả ok:true — bấm nút mà không có gì đổi và
    // không ai được báo. Nay giá trị bị từ chối đi kèm lý do để UI hiển thị.
    const { changed, rejected } = applyConfig(patch);
    // Key vừa sinh PHẢI trả nguyên văn — đó là lần duy nhất người dùng thấy nó. Ngoài
    // ra thì che, cùng lý do với GET ở trên.
    const justMadeKey = !!b.regenerateKey || typeof b.apiKey === 'string';
    const cfg = { ...config.gateway, apiKey: justMadeKey ? config.gateway.apiKey : maskKey(config.gateway.apiKey) };
    return { ok: rejected.length === 0, changed, rejected, config: cfg };
  });

  app.get('/api/gateway/models', async () => ({
    models: allModels().map((m) => ({
      id: m.prefixed, bare: m.id, label: m.label,
      // `image` giữ lại cho client cũ; UI mới đọc imageIn/imageOut vì `image` từng
      // mang hai nghĩa trái ngược tuỳ provider (sinh ảnh vs nhận ảnh).
      image: m.image, imageIn: m.imageIn ?? false, imageOut: m.imageOut ?? m.image,
      provider: m.provider, providerLabel: m.providerLabel,
      bucket: m.bucket, maxInput: m.maxInput,
    })),
  }));

  // ---------------- Chat thử ----------------
  // Chat thử qua pool (hoặc ép 1 account) — trả text + images (non-stream, dễ render).
  app.post('/api/gateway/chat', async (req, reply) => {
    const b = req.body as any;
    const messages = toMessages(b);
    const forced = b?.account && b.account !== 'auto' ? String(b.account) : undefined;
    const proxy = b?.proxy ? String(b.proxy) : undefined;
    syncFromStore();
    let parsed: ParsedModel;
    try {
      parsed = parseModelId(b?.model);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message, suggestion: e.suggestion });
    }
    if (parsed.kind !== 'provider') {
      return reply.code(400).send({ error: 'Chat thử chỉ nhận model thật (agy/… hoặc kr/…), không nhận combo.' });
    }
    const model = parsed.prefixed;
    const t0 = Date.now();

    /**
     * Dùng CHUNG engine với /proxy/v1 thay vì tự gọi provider một lần.
     *
     * Bản cũ: pickReady → generate → lỗi là trả 502 luôn. Nên account đầu tiên hết quota
     * là màn "Chat thử" báo 429, dù pool còn hàng trăm account khoẻ — trong khi gọi cùng
     * model qua /proxy/v1 lại thành công. Hai đường cùng một việc mà hành xử khác nhau,
     * và người dùng thử ở đây rồi kết luận nhầm là gateway hỏng.
     *
     * `runProviderCall` lo failover, circuit breaker, ghi usage, cập nhật pool.
     */
    let usedAccount = '';
    try {
      const out = await runProviderCall({
        provider: parsed.provider!,
        bare: parsed.model!,
        labelModel: model,
        messages,
        stream: false,
        reply,
        forcedEmail: forced,
        proxyOverride: proxy,
        endpoint: 'chat-test',
        onAccount: (email: string) => { usedAccount = email; },
      });
      if (!('result' in out)) return { ok: true, account: usedAccount, model, ms: Date.now() - t0 };
      const r = out.result;
      return {
        ok: true,
        account: usedAccount,
        model,
        ms: Date.now() - t0,
        text: r.text,
        images: r.images,
        usage: r.usage,
        isImage: isImageModel(model),
      };
    } catch (e: any) {
      // Sau khi đã thử hết account khả dụng mà vẫn lỗi — lúc này 429 là thật.
      return reply.code(e?.status ?? 502).send({
        ok: false,
        account: usedAccount,
        error: e?.message ?? String(e),
      });
    }
  });

  // ---------------- Hạn mức (quota) ----------------
  app.post('/api/gateway/quota/refresh', async (req) => {
    const { emails } = (req.body as { emails?: string[] }) ?? {};
    const q = (req.query ?? {}) as any;
    const only = q.provider && PROVIDERS[q.provider as ProviderId] ? (q.provider as ProviderId) : undefined;
    syncFromStore();
    const targets = (emails && emails.length
      ? emails.map((e) => (e.includes(':') ? pool.getByKey(e) : pool.get(e, only ?? 'agy'))).filter(Boolean)
      : pool.list(only).filter((a) => a.enabled)) as PoolAccount[];
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

  app.post('/api/gateway/quota/:email', async (req, reply) => {
    const { email } = req.params as { email: string };
    syncFromStore();
    const a = accOf(req, email);
    if (!a) return reply.code(404).send({ error: 'không có account' });
    try {
      const q = await refreshQuota(a, true);
      return { ok: true, email, quota: q };
    } catch (e: any) {
      return reply.code(502).send({ ok: false, error: e?.message ?? String(e) });
    }
  });

  /**
   * Health/metrics tức thời cho monitoring poll dày (dashboard KPI, alerting):
   * cửa sổ trượt 5 phút trong RAM (không quét DB) + trạng thái pool hiện tại.
   * Khác /api/gateway/stats (xu hướng dài hạn, đọc DB) — xem ghi chú ở metrics.ts.
   */
  app.get('/api/metrics', async () => {
    const now = Date.now();
    const accounts = Object.fromEntries(
      PROVIDER_IDS.map((pid) => {
        const all = pool.list(pid);
        return [pid, {
          total: all.length,
          available: pool.candidates(now, pid).length,
          inflight: all.reduce((s, a) => s + a.inflight, 0),
        }];
      }),
    );
    return {
      now,
      uptimeSec: Math.round(process.uptime()),
      window: gatewayMetrics.snapshot(now),
      accounts,
      breaker: providerBreaker.snapshot(now),
      rssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    };
  });

  /**
   * Số liệu hiệu năng để vẽ biểu đồ: tỉ lệ thành công + p95 độ trễ mỗi provider,
   * cộng mẫu `ms`/`ok` thô cho histogram. providerStats() vốn đã tính sẵn cho việc
   * chấm điểm định tuyến nhưng CHƯA từng có endpoint nào expose ra UI.
   */
  app.get('/api/gateway/stats', async (req) => {
    const q = (req.query ?? {}) as any;
    const days = Math.min(90, Math.max(1, Number(q.days) || 7));
    const since = Date.now() - days * 86400_000;
    // LIMIT trong SQL — kéo cả 90 ngày vào JS rồi mới slice là quét thừa trên bảng lớn.
    const samples = usageSamples(since, 3000);
    return {
      days,
      providers: providerStats(since).map((p) => ({
        ...p,
        label: PROVIDERS[p.provider as ProviderId]?.label ?? p.provider,
      })),
      samples,
    };
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

  // ---------------- Test lẻ / check hàng loạt ----------------
  app.post('/api/gateway/accounts/:email/test', async (req, reply) => {
    const { email } = req.params as { email: string };
    syncFromStore();
    const a = accOf(req, email);
    if (!a) return reply.code(404).send({ error: 'không có account' });
    const r = await testAccount(a);
    emitCheck(email, 'token', r.alive ? 'alive' : 'dead', r.alive ? 'info' : 'warn');
    return { ok: true, email, ...r };
  });

  app.post('/api/gateway/accounts/:email/checklive', async (req, reply) => {
    const { email } = req.params as { email: string };
    syncFromStore();
    const a = accOf(req, email);
    if (!a) return reply.code(404).send({ error: 'không có account' });
    const r = await checkLiveAccount(a);
    emitCheck(email, 'live', r.status, r.status === 'ok' ? 'info' : r.status === 'quota' ? 'warn' : 'error');
    return { ok: true, email, ...r };
  });

  /** Danh sách account đích cho check hàng loạt: theo emails/khoá ghép, hoặc cả pool. */
  function bulkTargets(emails?: string[]): PoolAccount[] {
    syncFromStore();
    return (emails && emails.length
      ? emails.map((e) => (e.includes(':') ? pool.getByKey(e) : pool.get(e, 'agy'))).filter(Boolean)
      : pool.list()) as PoolAccount[];
  }

  /**
   * Vòng check nền dùng chung cho `check` và `test-bulk` (trước đây 2 bản copy).
   * Nhịp 1.2s/account là BẮT BUỘC: 300ms × 400 account = Google chặn tốc độ endpoint
   * refresh, gần như mọi account sau vài chục cái đầu đều fail → bulk test tự tay giết
   * pool. Đo thật: chạy dày không gỡ được cái nào, giãn ~1.2s thì 100% hồi sinh.
   */
  async function runBulkCheck(targets: PoolAccount[], m: 'token' | 'live' | 'both'): Promise<void> {
    const total = targets.length;
    let i = 0, okc = 0;
    for (const a of targets) {
      i++;
      if (m === 'token' || m === 'both') {
        const r = await testAccount(a);
        emitCheck(a.email, 'token', r.alive ? 'alive' : 'dead', r.alive ? 'info' : 'warn', i, total);
        if (!r.alive) { await new Promise((r) => setTimeout(r, 1200)); continue; } // token chết thì khỏi check live
      }
      if (m === 'live' || m === 'both') {
        const r = await checkLiveAccount(a);
        if (r.status === 'ok') okc++;
        emitCheck(a.email, 'live', r.status, r.status === 'ok' ? 'info' : r.status === 'quota' ? 'warn' : 'error', i, total);
      } else if (m === 'token') {
        okc += a.health === 'alive' ? 1 : 0;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    savePersist();
    log('', 'info', `Check ${m} xong: ${okc}/${total} ok`);
  }

  /** Check hàng loạt token/live/both — chạy nền, emit realtime từng account. */
  app.post('/api/gateway/accounts/check', async (req) => {
    const { emails, mode } = (req.body as { emails?: string[]; mode?: 'token' | 'live' | 'both' }) ?? {};
    const m = mode || 'token';
    const targets = bulkTargets(emails);
    runBulkCheck(targets, m).catch(() => {});
    return { queued: targets.length, mode: m };
  });

  // giữ tương thích: test-bulk = check mode token
  app.post('/api/gateway/accounts/test-bulk', async (req) => {
    const { emails } = (req.body as { emails?: string[] }) ?? {};
    const targets = bulkTargets(emails);
    runBulkCheck(targets, 'token').catch(() => {});
    return { queued: targets.length };
  });

  // ---------------- Check live model ----------------
  app.post('/api/gateway/models/check', async (req) => {
    syncFromStore();
    const q = (req.query ?? {}) as any;
    const want: ProviderId[] =
      q.provider === 'all' || !q.provider ? [...PROVIDER_IDS] : [String(q.provider) as ProviderId];
    const out: { id: string; status: string; ms: number; detail?: string; provider: ProviderId; account?: string }[] = [];
    const accounts: string[] = [];
    for (const pid of want) {
      if (!PROVIDERS[pid]) continue;
      let ctx: Awaited<ReturnType<typeof pickReady>>;
      try {
        ctx = await pickReady(pid, undefined, undefined);
      } catch (e: any) {
        for (const m of PROVIDERS[pid].models) {
          out.push({ id: `${pid}/${m.id}`, provider: pid, status: 'error', ms: 0, detail: e?.message ?? 'no account' });
        }
        continue;
      }
      try {
        const res = await PROVIDERS[pid].checkModelsLive(ctx.session, ctx.dispatcher);
        accounts.push(`${pid}:${ctx.account.email}`);
        for (const r of res) out.push({ ...r, id: `${pid}/${r.id}`, provider: pid, account: ctx.account.email });
        log(ctx.account.email, 'info', `check live model ${pid}: ${res.filter((r) => r.status === 'ok').length}/${res.length} ok`);
      } finally {
        pool.release(ctx.account);
      }
    }
    return { account: accounts.join(', '), models: out };
  });

  /** Dò tay: POST /api/gateway/probe?provider=kr&limit=10 */
  app.post('/api/gateway/probe', async (req) => {
    const q = (req.query ?? {}) as any;
    const pid = (q.provider as ProviderId) || 'kr';
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));
    const targets = pool.candidates(Date.now(), pid).filter((a) => a.enabled).slice(0, limit);
    (async () => {
      for (const a of targets) {
        await checkLiveAccount(a).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
      }
      savePersist();
    })().catch(() => {});
    return { queued: targets.length, provider: pid };
  });

  // ---------------- Combo CRUD ----------------
  app.get('/api/combos', async () => {
    const stats = comboStatsRows(Date.now() - 7 * 86400_000);
    return {
      combos: listCombos().map((c) => {
        const s = stats.find((x) => x.combo === `combo/${c.id}`);
        return { ...c, calls: s?.calls ?? 0, fallbacks: s?.fallbacks ?? 0 };
      }),
      autoVariants: AUTO_VARIANT_IDS,
      weights: AUTO_VARIANTS,
    };
  });

  app.post('/api/combos', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const id = String(b.id ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (!id) return reply.code(400).send({ ok: false, error: 'thiếu id combo' });
    if (id === 'auto') return reply.code(400).send({ ok: false, error: '"auto" là tên dành riêng' });
    const targets = (Array.isArray(b.targets) ? b.targets : []).map((t: any) =>
      typeof t === 'string' ? { model: t } : { model: String(t.model), weight: t.weight ? Number(t.weight) : undefined },
    );
    const v = validateTargets(targets);
    if (!v.ok) return reply.code(400).send({ ok: false, error: v.error });
    // lưu id đã CHUẨN HOÁ (kr/claude-sonnet-4-5 → kr/claude-sonnet-4.5) để UI hiện đúng
    for (const t of targets) t.model = parseModelId(t.model).prefixed;
    const strategy = ['priority', 'round-robin', 'weighted', 'highest-quota'].includes(b.strategy) ? b.strategy : 'priority';
    upsertComboRow({ id, name: String(b.name ?? id), strategy, targets, enabled: b.enabled !== false });
    return { ok: true, id };
  });

  app.delete('/api/combos/:id', async (req) => {
    const { id } = req.params as { id: string };
    deleteComboRow(id);
    return { ok: true };
  });

  /** Bảng xếp hạng hiện tại của `auto` (đúng thứ tự sẽ thử). */
  app.get('/api/combos/auto/preview', async (req) => {
    const q = (req.query ?? {}) as any;
    const variant = String(q.variant ?? 'default').replace(/^auto\/?/, '') || 'default';
    const snap = poolSnapshot();
    return {
      variant,
      weights: AUTO_VARIANTS[variant] ?? AUTO_VARIANTS.default,
      snapshot: snap,
      plan: planAuto(variant, snap),
      ranking: scoreCandidates(snap, AUTO_VARIANTS[variant] ?? AUTO_VARIANTS.default!).slice(0, 12),
    };
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

  /** Bộ lọc báo cáo lấy từ query — trống nghĩa là không lọc theo tiêu chí đó. */
  const filterOf = (req: FastifyRequest): UsageFilter => {
    const q = (req.query ?? {}) as any;
    return {
      apiKeyId: typeof q.apiKeyId === 'string' && q.apiKeyId ? q.apiKeyId : undefined,
      combo: typeof q.combo === 'string' && q.combo ? q.combo : undefined,
    };
  };

  app.get('/api/gateway/usage', async (req) => {
    const { from, to, groupBy } = rangeOf(req);
    const f = filterOf(req);
    // Nhãn key: usage chỉ lưu id, UI cần tên để hiển thị "Hermes" thay vì "ak_1a2b…".
    const names = new Map(listPublicApiKeys().map((k) => [k.id, k.name]));
    const byApiKey = usageByApiKey(from, to, f).map((r) => ({
      ...r,
      name: r.apiKeyId === 'legacy' ? 'Key mặc định' : r.apiKeyId ? names.get(r.apiKeyId) ?? '(đã xoá)' : '(không key)',
    }));
    return {
      totals: usageTotals(from, to, f),
      series: usageSeries(from, to, groupBy, f),
      byModel: usageByModel(from, to, f),
      byAccount: usageByAccount(from, to, f),
      byApiKey,
      byCombo: usageByCombo(from, to, f),
      /**
       * Mốc bắt đầu ghi attribution. Dữ liệu TRƯỚC mốc này không có api_key_id/combo
       * (cột chỉ có từ schema v3) — UI phải nói rõ, nếu không người dùng tưởng hỏng.
       */
      attributionSince: attributionSince(),
    };
  });

  app.get('/api/gateway/usage/export.csv', async (req, reply) => {
    const { from, to } = rangeOf(req);
    const rows = usageRows(from, to, filterOf(req));
    // Cột mới thêm vào CUỐI dòng — chèn giữa sẽ phá script người dùng đang parse theo vị trí.
    const head = 'ts,datetime,email,model,prompt_tokens,completion_tokens,ok,ms,api_key_id,combo,endpoint,status,request_id,stream\n';
    const csv = (v: unknown) => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const body = rows
      .map((r) => [
        r.ts, new Date(r.ts).toISOString(), r.email, r.model, r.promptTokens, r.completionTokens,
        r.ok ? 1 : 0, r.ms, r.apiKeyId, r.combo, r.endpoint, r.status, r.requestId,
        r.stream == null ? '' : r.stream ? 1 : 0,
      ].map(csv).join(','))
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
    if (q.email) {
      return { email: q.email, points: quotaForAccount(String(q.email), from, to) };
    }

    /**
     * Gộp theo NGÀY cho cửa sổ ≥7 ngày là đúng khi đã chạy nhiều ngày, nhưng sai hẳn lúc
     * mới bật: đo trên production có 14.6k điểm mà TẤT CẢ rơi vào một ngày → gộp theo ngày
     * ra ĐÚNG 1 điểm, và một điểm thì không vẽ thành đường. Khung "Xu hướng toàn pool" vì
     * thế luôn trống dù dữ liệu đầy — người dùng thấy "Chưa có dữ liệu" và tưởng job hỏng.
     *
     * Nên tự hạ xuống mức mịn hơn khi kết quả quá thưa. Cùng dữ liệu đó, gộp theo giờ cho
     * 14 điểm — vẽ được ngay.
     */
    const chosen = q.groupBy === 'hour' || q.groupBy === 'day'
      ? (q.groupBy as 'hour' | 'day')
      : days <= 1 ? 'hour' : 'day';
    let series = quotaSeries(from, to, chosen);
    let groupBy: 'hour' | 'day' = chosen;
    if (!q.groupBy && groupBy === 'day' && series.length < 3) {
      const finer = quotaSeries(from, to, 'hour');
      if (finer.length > series.length) { series = finer; groupBy = 'hour'; }
    }
    return { series, groupBy, total: quotaHistoryCount() };
  });

  /**
   * Lịch sử metrics — nguồn 3 chart trang /metrics.
   *
   * Trước đây trang đó tự tích luỹ điểm trong RAM trình duyệt nên F5 là trắng và phải
   * chờ ≥2 lần poll mới vẽ được gì. Job nền ghi mỗi 60s xuống `metrics_history`, endpoint
   * này đọc ra.
   *
   * Tự chọn độ mịn theo cửa sổ: ≤6h giữ nguyên từng điểm 1 phút; dài hơn thì gộp để
   * không đẩy hàng chục nghìn điểm xuống trình duyệt (7 ngày = 10k điểm nếu để raw).
   */
  /**
   * Thông tin để tool ngoài kết nối vào agyproxy qua CLI hoặc HTTP.
   *
   * Token CLI cho TOÀN QUYỀN điều khiển gateway, nên mặc định trả bản CHE
   * (`agy-1234…cdef`) giống cách `/api/gateway/config` che apiKey. Phải `?reveal=1`
   * mới trả nguyên văn — để token không nằm sẵn trong mọi response, trong cache trình
   * duyệt, hay trong ảnh chụp màn hình người dùng gửi đi.
   *
   * Sinh token nếu chưa có: người dùng mở tab CLI lần đầu là dùng được ngay, không phải
   * SSH vào máy chủ chạy `agyproxy token`.
   */
  app.get('/api/cli/connect', async (req) => {
    let token = getSetting('cliToken');
    if (!token) {
      token = randomBytes(24).toString('base64url');
      setSetting('cliToken', token);
    }
    const reveal = (req.query as any)?.reveal === '1';
    // URL mà tool ngoài phải gọi — lấy từ chính request nên đúng cả khi sau reverse proxy.
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || `127.0.0.1:${config.port}`;
    const proto = (req.headers['x-forwarded-proto'] as string) || (req.protocol ?? 'http');
    const base = `${proto}://${host}`;
    /**
     * Gom mọi thứ tool ngoài cần vào MỘT response, để tab CLI không phải ghép 3 lời gọi.
     *
     * Hai loại secret KHÁC NHAU, dùng nhầm là 401 mà không rõ vì sao:
     *  - `token` (cliToken): điều khiển agyproxy — dashboard, CLI, MCP
     *  - `apiKey` (gatewayApiKey legacy): gọi MODEL qua /proxy/v1 và /v1/messages
     *
     * Key trong bảng `api_keys` KHÔNG lấy lại được (DB chỉ giữ sha256, xem apikeys.ts:104)
     * nên chỉ trả tên + prefix để nhận diện, kèm chỉ dẫn tạo mới ở tab API Keys.
     */
    const gwKey = config.gateway.apiKey;
    return {
      url: base,
      token: reveal ? token : maskKey(token),
      masked: !reveal,
      gatewayUrl: `${base}/proxy/v1`,
      anthropicUrl: base,
      apiKey: gwKey ? (reveal ? gwKey : maskKey(gwKey)) : '',
      hasApiKey: !!gwKey,
      keys: listPublicApiKeys().map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, enabled: k.enabled })),
      models: allModels().map((m) => ({ id: m.prefixed, label: m.label, provider: m.provider })),
    };
  });

  app.get('/api/metrics/history', async (req) => {
    const q = req.query as any;
    const to = q.to ? Number(q.to) : Date.now();
    const hours = Math.max(1, Math.min(24 * 90, Number(q.hours) || 6));
    const from = q.from ? Number(q.from) : to - hours * 3600_000;
    const chosen: 'raw' | 'minute' | 'hour' =
      q.groupBy === 'raw' || q.groupBy === 'minute' || q.groupBy === 'hour'
        ? q.groupBy
        : hours <= 6 ? 'raw' : hours <= 48 ? 'minute' : 'hour';
    let series = metricsSeries(from, to, chosen);
    let groupBy = chosen;
    // Cùng lý do như quota/history: gộp thô quá thì cửa sổ dài ra 1-2 điểm và chart trống.
    if (!q.groupBy && groupBy !== 'raw' && series.length < 3) {
      const finer = metricsSeries(from, to, 'raw');
      if (finer.length > series.length) { series = finer; groupBy = 'raw'; }
    }
    return { series, groupBy, from, to, total: metricsHistoryCount() };
  });
}
