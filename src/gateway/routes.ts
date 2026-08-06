import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config, setConfig } from '../config.js';
import { emitLog } from '../events.js';
import { store } from '../store/index.js';
import {
  recordGatewayUsage, usageTotals, usageSeries, usageByModel, usageByAccount, usageRows,
  quotaSeries, quotaForAccount, quotaHistoryCount, pruneQuotaHistory,
  listComboRows, getComboRow, upsertComboRow, deleteComboRow, recordComboRun, comboStatsRows,
  providerStats, usageByProvider, recordQuota, creditsUsedThisMonth,
} from '../store/db.js';
import {
  PROVIDERS, PROVIDER_IDS, allModels, parseModelId, ModelIdError,
  type ParsedModel, type ProviderId, type ProviderSession, type QuotaBucket,
} from './providers/index.js';
import {
  planCombo, planAuto, shouldFallback, isContextTooLong, validateTargets, AUTO_VARIANT_IDS, AUTO_VARIANTS, scoreCandidates,
  type Combo, type ComboStrategy, type ComboTarget, type PoolSnapshot,
} from './combo.js';
import {
  anthropicToMessages, anthropicGenerationConfig, anthropicToolDefs, resultToAnthropic, sseFrame,
  MAX_OUTPUT_TOKENS_CAP,
  anthropicErrorBody, resolveAnthropicModel, type AnthropicRequest,
} from './anthropic.js';
import {
  pool,
  syncFromStore,
  savePersist,
  ensureReady,
  dispatcherFor,
  refreshQuota,
  geminiPct,
  claudePct,
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
  type ToolCall,
  type ToolDef,
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

/** Số bước tối đa combo/auto sẽ thử trước khi bỏ cuộc (dùng chung cho cả 2 nhánh). */
const COMBO_MAX_STEPS = 6;

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

/**
 * Lỗi "đầu vào quá dài": biến thành thông báo hành động được.
 * Kiro/Bedrock chặn quanh ~100k token dù công bố 200k; Antigravity nhận tới 1M.
 */
function contextHint(e: unknown, model: string): string | undefined {
  if (!isContextTooLong(e)) return undefined;
  // Gợi ý theo maxInput THẬT của từng model thay vì chuỗi cứng: lấy các model có
  // trần lớn hơn model đang dùng, sắp giảm dần, đề xuất vài cái đầu.
  const cur = allModels().find((m) => m.prefixed === model)?.maxInput ?? 0;
  const bigger = allModels()
    .filter((m) => !m.image && (m.maxInput ?? 0) > cur)
    .sort((a, b) => (b.maxInput ?? 0) - (a.maxInput ?? 0));
  const tokens = (n?: number) => (n ? `${Math.round(n / 1000)}k` : '?');
  const head = `Prompt quá dài với ${model}${cur ? ` (trần ~${tokens(cur)} token)` : ''}.`;
  if (!bigger.length) {
    return `${head} Đây đã là model có ngữ cảnh lớn nhất — cần rút bớt nội dung gửi lên.`;
  }
  const list = bigger.slice(0, 3).map((m) => `${m.prefixed} (~${tokens(m.maxInput)})`).join(', ');
  return `${head} Model nhận nhiều hơn: ${list}. Hoặc dùng combo/auto để tự chuyển, hoặc rút bớt nội dung.`;
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
  // Nhận cả `x-api-key`: client Anthropic (Hermes…) trỏ base_url vào /proxy/v1 chỉ gửi
  // header này. Thiếu nó thì GET /proxy/v1/models trả 401 → client tưởng proxy KHÔNG có
  // Models API nên bỏ qua bước xác minh và chấp nhận bừa mọi tên model, kể cả model hỏng.
  const xk = (req.headers['x-api-key'] || '') as string;
  return h === `Bearer ${key}` || h === key || xk === key;
}

/** Lấy account theo email + provider từ query (mặc định agy → URL cũ vẫn đúng). */
function accOf(req: FastifyRequest, email: string): PoolAccount | undefined {
  const q = (req.query ?? {}) as any;
  const pid = (q.provider as ProviderId) || 'agy';
  return pool.get(email, PROVIDERS[pid] ? pid : 'agy');
}

/** Chọn account của ĐÚNG provider (ép email nếu có) + lấy session sẵn sàng. */
/** Bể hạn mức của 1 model (id TRẦN). undefined = provider không chia bể. */
function bucketOf(provider: ProviderId, bare: string): QuotaBucket | undefined {
  return PROVIDERS[provider]?.models.find((m) => m.id === bare)?.bucket;
}

async function pickReady(
  provider: ProviderId,
  forcedEmail: string | undefined,
  proxyOverride: string | undefined,
  bucket?: QuotaBucket,
): Promise<{ account: PoolAccount; session: ProviderSession; dispatcher: any }> {
  let account: PoolAccount;
  if (forcedEmail) {
    const a = pool.get(forcedEmail, provider);
    if (!a) throw new NoAccountError(`Account ${forcedEmail} không có trong pool ${provider}`);
    if (!a.enabled) throw new NoAccountError(`Account ${forcedEmail} đang tắt`);
    account = a;
    account.inflight++; // đối xứng với pool.release() ở finally
  } else {
    account = pool.pick(strategy(), Date.now(), provider, bucket); // pick đã inflight++
  }
  try {
    const dispatcher = dispatcherFor(account, proxyOverride);
    const session = await ensureReady(account, dispatcher);
    return { account, session, dispatcher };
  } catch (e) {
    pool.release(account); // chuẩn bị token/project lỗi → trả lại inflight
    throw e;
  }
}

function toMessages(body: any): ChatMessage[] {
  if (Array.isArray(body?.messages)) {
    // Chuẩn hoá tool_calls (OpenAI: arguments là CHUỖI JSON) → ToolCall nội bộ.
    return (body.messages as any[]).map((m): ChatMessage => {
      if (m?.role === 'tool') {
        return {
          role: 'tool',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          toolCallId: m.tool_call_id,
          toolName: m.name,
        };
      }
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const toolCalls: ToolCall[] = m.tool_calls.map((c: any) => {
          let input: Record<string, unknown> = {};
          const raw = c?.function?.arguments;
          if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { input = {}; } }
          else if (raw && typeof raw === 'object') input = raw;
          const sig = typeof c?._signature === 'string' ? c._signature : undefined;
          return { id: String(c?.id ?? ''), name: String(c?.function?.name ?? ''), input, ...(sig ? { signature: sig } : {}) };
        });
        return { role: 'assistant', content: m.content ?? '', toolCalls };
      }
      return m as ChatMessage;
    });
  }
  if (typeof body?.content === 'string') return [{ role: 'user', content: body.content }];
  if (typeof body?.prompt === 'string') return [{ role: 'user', content: body.prompt }];
  return [{ role: 'user', content: '' }];
}

/** tools OpenAI ([{type:'function', function:{name,description,parameters}}]) → ToolDef. */
function toToolDefs(body: any): ToolDef[] {
  const raw = Array.isArray(body?.tools) ? body.tools : [];
  const out: ToolDef[] = [];
  for (const t of raw) {
    const f = t?.type === 'function' ? t.function : t;
    if (f && typeof f.name === 'string' && f.name) {
      out.push({ name: f.name, description: f.description, parameters: f.parameters });
    }
  }
  // API cũ: functions[] (deprecated nhưng vẫn có tool dùng)
  if (!out.length && Array.isArray(body?.functions)) {
    for (const f of body.functions) {
      if (f && typeof f.name === 'string' && f.name) out.push({ name: f.name, description: f.description, parameters: f.parameters });
    }
  }
  return out;
}

function openaiCompletion(model: string, r: GenResult) {
  let content = r.text;
  for (const img of r.images) content += (content ? '\n\n' : '') + `![image](${img})`;
  const calls = r.toolCalls ?? [];
  const message: Record<string, unknown> = { role: 'assistant', content: content || (calls.length ? null : '') };
  if (calls.length) {
    message.tool_calls = calls.map((c, i) => ({
      index: i, id: c.id, type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
      // Chữ ký Gemini (xem ToolCall.signature) — client trả lại thì vòng 2 mới chạy.
      ...(c.signature ? { _signature: c.signature } : {}),
    }));
  }
  return {
    id: 'chatcmpl-' + randomUUID(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : r.finishReason || 'stop' }],
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
  // Tự mở stream nếu chưa: combo hoãn sseInit() để còn trượt bước khi bước đầu lỗi,
  // nên byte đầu tiên có thể tới đây lúc header chưa gửi.
  if (!reply.raw.headersSent) sseInit(reply);
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

// ---------------- Combo helpers ----------------
function listCombos(): Combo[] {
  return listComboRows().map((r) => ({
    id: r.id,
    name: r.name,
    strategy: r.strategy as ComboStrategy,
    targets: JSON.parse(r.targets_json) as ComboTarget[],
    enabled: r.enabled !== 0,
  }));
}

let statsCache: { at: number; snap: PoolSnapshot } | null = null;
/** Ảnh chụp pool cho chấm điểm — cache 60s (KHÔNG truy vấn DB mỗi request). */
function poolSnapshot(): PoolSnapshot {
  if (statsCache && Date.now() - statsCache.at < 60_000) return statsCache.snap;
  const stats = providerStats(Date.now() - 24 * 3600_000);
  const snap: PoolSnapshot = {};
  for (const pid of PROVIDER_IDS) {
    const all = pool.list(pid);
    const avail = pool.candidates(Date.now(), pid);
    const st = stats.find((s) => s.provider === pid);
    const withQuota = all.map((a) => geminiPct(a)).filter((x): x is number => x != null);
    snap[pid] = {
      provider: pid,
      available: avail.length,
      total: all.length,
      quotaAvg: withQuota.length ? Math.round(withQuota.reduce((s, x) => s + x, 0) / withQuota.length) : null,
      p95Ms: st?.p95 ?? null,
      successRate: st?.okRate ?? null,
      inflight: all.reduce((s, a) => s + a.inflight, 0),
    };
  }
  statsCache = { at: Date.now(), snap };
  return snap;
}

export async function registerGatewayRoutes(app: FastifyInstance): Promise<void> {
  syncFromStore(true);

  /** Dựng thứ tự thử cho combo/auto (dùng chung cho cả /proxy/v1 lẫn /v1/messages). */
  function resolveComboPlan(parsed: ParsedModel): { name: string; plan: ComboTarget[] } | { error: string; status: number } {
    const snap = poolSnapshot();
    if (parsed.kind === 'auto') {
      return { name: parsed.prefixed, plan: planAuto(parsed.combo || 'default', snap) };
    }
    const c = listCombos().find((x) => x.id === parsed.combo);
    if (!c) return { error: `Combo "${parsed.combo}" không tồn tại`, status: 404 };
    if (!c.enabled) return { error: `Combo "${c.id}" đang tắt`, status: 503 };
    return { name: `combo/${c.id}`, plan: planCombo(c, snap) };
  }

  /** Chạy combo/auto: thử từng bước, trượt sang bước kế khi shouldFallback. */
  async function runComboRequest(
    parsed: ParsedModel,
    o: {
      messages: ChatMessage[];
      tools?: ToolDef[];
      stream: boolean;
      reply: FastifyReply;
      runProviderCall: (opts: any) => Promise<{ done: true } | { result: GenResult }>;
    },
  ): Promise<any> {
    const snap = poolSnapshot();
    let plan: ComboTarget[];
    let comboName: string;

    if (parsed.kind === 'auto') {
      comboName = parsed.prefixed;
      plan = planAuto(parsed.combo || 'default', snap);
    } else {
      const c = listCombos().find((x) => x.id === parsed.combo);
      if (!c) return o.reply.code(404).send({ error: `Combo "${parsed.combo}" không tồn tại` });
      if (!c.enabled) return o.reply.code(503).send({ error: `Combo "${c.id}" đang tắt` });
      comboName = `combo/${c.id}`;
      plan = planCombo(c, snap);
    }
    if (!plan.length) return o.reply.code(503).send({ error: `${comboName}: không có model nào khả dụng` });

    // Có tools → bỏ các bước trỏ tới provider không có function calling (bước đó
    // chắc chắn 400, trượt qua luôn cho đỡ tốn 1 lượt trong 3 bước).
    if (o.tools?.length) {
      plan = plan.filter((t) => {
        try {
          const p = parseModelId(t.model);
          return p.kind !== 'provider' || !!PROVIDERS[p.provider!]?.supportsTools;
        } catch { return true; }
      });
      if (!plan.length) {
        return o.reply.code(400).send({ error: `${comboName}: không có bước nào hỗ trợ tool-use — thêm model agy/ vào combo.` });
      }
    }

    // Chặn cứng 3 bước khiến combo dài hơn 3 có bước không bao giờ chạy — người dùng
    // cấu hình 6 bước dự phòng mà thực tế chỉ 3 bước đầu có tác dụng. Nới lên 6: mỗi bước
    // lỗi đã tự xoay tối đa 32 account trước khi trượt, nên tới bước 6 là đã thử rất nhiều.
    const maxSteps = Math.min(plan.length, COMBO_MAX_STEPS);
    let lastErr: any;
    for (let step = 0; step < maxSteps; step++) {
      const t = plan[step]!;
      const t0 = Date.now();
      let p: ParsedModel;
      try {
        p = parseModelId(t.model);
      } catch (e: any) {
        lastErr = e;
        continue;
      }
      if (p.kind !== 'provider') continue; // combo không được trỏ tới combo
      try {
        // KHÔNG sseInit() ngay ở bước 0: gửi header rồi thì headersSent=true, và bước 1
        // lỗi 429 sẽ rơi vào nhánh "đã gửi byte → hết cứu" bên dưới → combo mất hẳn tác
        // dụng khi stream. Hoãn tới byte dữ liệu THẬT đầu tiên, lúc đó mới hết đường lùi.
        const out = await o.runProviderCall({
          provider: p.provider!, bare: p.model!, labelModel: p.prefixed,
          messages: o.messages, tools: o.tools, stream: o.stream, reply: o.reply, endpoint: comboName,
        });
        recordComboRun({ combo: comboName, step, model: p.prefixed, ok: true, ms: Date.now() - t0 });
        if ('done' in out) return o.reply;
        return o.reply.send(openaiCompletion(comboName, out.result));
      } catch (e: any) {
        lastErr = e;
        recordComboRun({ combo: comboName, step, model: p.prefixed, ok: false, status: e?.status, ms: Date.now() - t0, reason: String(e?.message ?? e) });
        emitGw({
          kind: 'err', account: '-', model: comboName, status: e?.status,
          msg: `${comboName} bước ${step + 1} (${p.prefixed}) lỗi → ${shouldFallback(e) ? 'trượt sang bước kế' : 'dừng'}: ${String(e?.message ?? e).slice(0, 80)}`,
        });
        // stream đã gửi byte → không phát lại được (giới hạn đã biết)
        if (o.stream && o.reply.raw.headersSent) throw e;
        if (!shouldFallback(e)) throw e;
      }
    }
    throw lastErr ?? new NoAccountError(`${comboName}: mọi bước đều lỗi`);
  }

  // ---------------- OpenAI-compatible ----------------
  app.get('/proxy/v1/models', async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send({ error: 'unauthorized' });
    const q = (req.query ?? {}) as any;
    /**
     * Gateway trung gian (OmniRoute, LiteLLM…) TỰ THÊM prefix provider của nó vào id,
     * nên id `agy/gemini-…` của ta sẽ thành `agy/agy/gemini-…` (prefix chồng prefix).
     * Với các gateway đó, gọi `?bare=1` để lấy id TRẦN, kèm đuôi phân biệt provider
     * (`-kr`) cho model trùng tên giữa 2 provider.
     */
    const bare = q.bare === '0' || q.bare === 'false' ? false : q.bare === '1' || q.bare === 'true' || config.gateway.bareModels;
    const all = allModels();
    // Trùng tên giữa 2 provider, HOẶC trùng tên dành riêng cho combo ảo ('auto') →
    // model Kiro được thêm đuôi '-kr' để id vẫn duy nhất khi bỏ prefix.
    const reserved = new Set<string>(['auto', ...AUTO_VARIANT_IDS]);
    const dupes = new Set(
      all.map((m) => m.id).filter((id, i, arr) => arr.indexOf(id) !== i || reserved.has(id)),
    );
    const data = all.map((m) => ({
      id: bare ? (dupes.has(m.id) && m.provider === 'kr' ? `${m.id}-kr` : m.id) : m.prefixed,
      object: 'model',
      owned_by: m.provider === 'kr' ? 'kiro' : 'antigravity',
    }));
    // combo do người dùng tạo + combo ảo auto
    for (const c of listCombos()) data.push({ id: `combo/${c.id}`, object: 'model', owned_by: 'combo' });
    for (const v of AUTO_VARIANT_IDS) data.push({ id: v, object: 'model', owned_by: 'combo' });
    /**
     * Client Anthropic (Hermes…) trỏ base_url vào /proxy/v1 sẽ gọi ĐÚNG route này để xác
     * minh model, nhưng chờ schema Anthropic (`type`/`display_name`) chứ không phải OpenAI
     * (`object`/`owned_by`). Nhận diện qua header đặc trưng rồi trả đúng schema — nếu không
     * client coi như không xác minh được và chấp nhận bừa mọi tên model.
     */
    if (req.headers['x-api-key'] || req.headers['anthropic-version']) {
      const items = data.map((m) => ({
        type: 'model', id: m.id,
        display_name: all.find((x) => x.prefixed === m.id || x.id === m.id)?.label ?? m.id,
        created_at: new Date(0).toISOString(),
      }));
      return { data: items, has_more: false, first_id: items[0]?.id ?? null, last_id: items[items.length - 1]?.id ?? null };
    }
    return { object: 'list', data };
  });

  /**
   * Chạy 1 lượt gọi model (đã biết provider + id trần) với failover qua nhiều account.
   * Trả về true nếu đã gửi response (stream), hoặc GenResult nếu non-stream.
   */
  async function runProviderCall(opts: {
    provider: ProviderId;
    bare: string;
    labelModel: string; // id có prefix — dùng cho log/usage/echo
    messages: ChatMessage[];
    stream: boolean;
    reply: FastifyReply;
    forcedEmail?: string;
    proxyOverride?: string;
    endpoint?: string;
    onStreamDelta?: (t: string) => void;
    sseWriter?: (delta: string) => void;
    generationConfig?: Record<string, unknown>;
    tools?: ToolDef[];
    /** Stream: model gọi tool (chỉ provider supportsTools mới phát). */
    onToolCall?: (c: ToolCall) => void;
  }): Promise<{ done: true } | { result: GenResult }> {
    const { provider, bare, labelModel, messages, stream, reply } = opts;
    const p = PROVIDERS[provider];
    // Provider không có function calling native → KHÔNG im lặng bỏ tools (model sẽ
    // trả text mô tả việc cần làm, Claude Code treo chờ tool_use không bao giờ tới).
    if (opts.tools?.length && !p.supportsTools) {
      throw Object.assign(
        new Error(`${p.label} (${provider}/) không hỗ trợ tool-use — dùng model agy/ cho Claude Code, hoặc tắt tool.`),
        { status: 400 },
      );
    }
    const genArgs = { generationConfig: opts.generationConfig, tools: opts.tools };
    const avail = pool.candidates(Date.now(), provider).length;
    // Lỗi thật (5xx/mạng) chỉ thử 3 account. Nhưng account HẾT HẠN MỨC thì bị cooldown
    // ngay khi report → bỏ qua rất rẻ, nên không tính vào hạn thử.
    // Cần thiết vì pool Kiro có ~40% account đã cạn hạn mức tháng.
    //
    // Ngân sách skip cũ là 12: khi Google chặn tốc độ DIỆN RỘNG, hàng chục account liên
    // tiếp cùng trả `stream 429` → cạn ngân sách rồi ném lỗi ra client DÙ pool còn ~190
    // account khoẻ. Đo thực tế: 18 request stream song song → 1 lần rò 429 ra ngoài.
    // Mỗi lần bỏ qua chỉ tốn 1 vòng pick (account bị cooldown ngay, không gọi mạng lại),
    // nên nới lên 32 vẫn rẻ mà nuốt được đợt 429 dài hơn nhiều.
    const maxTry = Math.min(3, Math.max(1, avail));
    const maxSkip = Math.min(32, avail);
    let lastErr: any;
    let tries = 0;
    let skips = 0;

    for (let attempt = 0; tries < maxTry && skips <= maxSkip; attempt++) {
      let ctx: Awaited<ReturnType<typeof pickReady>>;
      try {
        ctx = await pickReady(provider, opts.forcedEmail, opts.proxyOverride, bucketOf(provider, bare));
      } catch (e) {
        lastErr = e;
        break;
      }
      const t0 = Date.now();
      const plabel = proxyLabelOf(ctx.account);
      // Kích thước prompt + số tool đi kèm mọi dòng req: khi 429 hàng loạt, đây là thứ
      // duy nhất phân biệt được request của client thật với request thử nghiệm — không có
      // nó thì log chỉ nói "đổi account" mà không cho biết request nào gây ra.
      const promptKB = Math.round(JSON.stringify(messages).length / 1024);
      const nTools = opts.tools?.length ?? 0;
      emitGw({
        kind: 'req', account: ctx.account.email, model: labelModel, proxy: plabel,
        endpoint: opts.endpoint ?? '/proxy/v1', attempt: attempt + 1,
        msg: `→ ${labelModel} · ${ctx.account.email}${stream ? ' (stream)' : ''} · ${promptKB}KB/${nTools}tool · proxy:${plabel}`,
      });
      try {
        if (stream) {
          const id = 'chatcmpl-' + randomUUID();
          let pt = 0, ct = 0;
          // Client OpenAI gộp tool_calls THEO index → mỗi tool phải có index riêng,
          // dùng chung index 0 sẽ làm tool sau đè lên tool trước.
          let toolIndex = 0;
          let sawToolCall = false;
          for await (const ev of p.generateStream({ session: ctx.session, model: bare, messages, ...genArgs, dispatcher: ctx.dispatcher })) {
            if (ev.delta) {
              if (opts.sseWriter) opts.sseWriter(ev.delta);
              else sseChunk(reply, labelModel, id, { content: ev.delta }, null);
            }
            if (ev.toolCall) {
              sawToolCall = true;
              if (opts.onToolCall) opts.onToolCall(ev.toolCall);
              else sseChunk(reply, labelModel, id, {
                tool_calls: [{
                  index: toolIndex++, id: ev.toolCall.id, type: 'function',
                  function: { name: ev.toolCall.name, arguments: JSON.stringify(ev.toolCall.input ?? {}) },
                  ...(ev.toolCall.signature ? { _signature: ev.toolCall.signature } : {}),
                }],
              }, null);
            }
            if (ev.image && !opts.sseWriter) sseChunk(reply, labelModel, id, { content: `\n![image](${ev.image})` }, null);
            if (ev.usage) { pt = ev.usage.promptTokens; ct = ev.usage.completionTokens; }
          }
          if (!opts.sseWriter) {
            sseChunk(reply, labelModel, id, {}, sawToolCall ? 'tool_calls' : 'stop');
            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
          }
          const ms = Date.now() - t0;
          pool.report(ctx.account, { ok: true, promptTokens: pt, completionTokens: ct });
          afterCall(ctx.account, labelModel, { ok: true, promptTokens: pt, completionTokens: ct, ms });
          savePersist();
          emitGw({ kind: 'res', account: ctx.account.email, model: labelModel, ms, tokens: pt + ct, status: 200, msg: `← 200 · stream · ${pt + ct} tok · ${ms}ms` });
          return { done: true };
        }
        const r = await p.generate({ session: ctx.session, model: bare, messages, ...genArgs, dispatcher: ctx.dispatcher });
        const ms = Date.now() - t0;
        pool.report(ctx.account, { ok: true, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens });
        afterCall(ctx.account, labelModel, { ok: true, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, ms });
        savePersist();
        emitGw({ kind: 'res', account: ctx.account.email, model: labelModel, ms, tokens: r.usage.totalTokens, status: 200, msg: `← 200 · ${r.usage.totalTokens} tok · ${ms}ms` });
        return { result: r };
      } catch (e: any) {
        lastErr = e;
        const ms = Date.now() - t0;
        pool.report(ctx.account, { ok: false, status: e?.status, err: e?.message, retryAfterMs: e?.retryAfterMs });
        afterCall(ctx.account, labelModel, { ok: false, ms });
        const outOfQuota = e?.status === 402 || e?.status === 429 || /MONTHLY_REQUEST_COUNT|quota|exhaust/i.test(String(e?.message ?? ''));
        // Prompt quá dài KHÔNG phụ thuộc account — thử account khác chỉ tốn thời gian
        // và làm bẩn log. Dừng ngay để tầng combo đổi sang MODEL khác.
        const tooLong = isContextTooLong(e);
        if (tooLong) {
          emitGw({
            kind: 'err', account: ctx.account.email, model: labelModel, ms, status: e?.status,
            msg: `← ✗ ${e?.status ?? ''} prompt quá dài — không thử account khác, cần đổi model ngữ cảnh lớn hơn`,
          });
          throw e;
        }
        if (outOfQuota) skips++;
        else tries++;
        emitGw({
          kind: 'err', account: ctx.account.email, model: labelModel, ms, status: e?.status,
          msg: `← ✗ ${e?.status ?? ''} ${outOfQuota ? '(hết hạn mức → đổi account)' : ''} ${String(e?.message ?? e).slice(0, 90)}`,
        });
        if (stream && reply.raw.headersSent) throw e; // đã gửi byte → không cứu được
      } finally {
        pool.release(ctx.account);
      }
    }
    throw lastErr ?? new NoAccountError();
  }

  app.post('/proxy/v1/chat/completions', async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send({ error: 'unauthorized' });
    if (!config.gateway.enabled) return reply.code(503).send({ error: 'gateway disabled' });
    const body = req.body as any;
    const messages = toMessages(body);
    const tools = toToolDefs(body);
    const stream = !!body?.stream;
    syncFromStore();

    let parsed: ParsedModel;
    try {
      parsed = parseModelId(body?.model);
    } catch (e: any) {
      return reply.code(400).send({ error: { message: e.message, type: 'invalid_request_error', param: 'model', suggestion: e.suggestion } });
    }

    try {
      // combo / auto → engine combo tự lo fallback
      if (parsed.kind !== 'provider') {
        return await runComboRequest(parsed, { messages, tools, stream, reply, runProviderCall });
      }
      if (stream) sseInit(reply);
      const out = await runProviderCall({
        provider: parsed.provider!, bare: parsed.model!, labelModel: parsed.prefixed,
        messages, tools, stream, reply,
      });
      if ('done' in out) return reply;
      return reply.send(openaiCompletion(parsed.prefixed, out.result));
    } catch (e: any) {
      if (stream && reply.raw.headersSent) {
        reply.raw.end();
        return reply;
      }
      const code = e instanceof NoAccountError ? 503 : e?.status === 400 ? 400 : 502;
      const hint = contextHint(e, parsed.prefixed);
      return reply.code(code).send({ error: hint ?? e?.message ?? 'all accounts failed', ...(hint ? { detail: e?.message } : {}) });
    }
  });

  // ---------------- Quản lý (tab UI) ----------------
  app.get('/api/gateway/accounts', async (req) => {
    syncFromStore();
    const now = Date.now();
    const q = (req.query ?? {}) as any;
    const only = q.provider && PROVIDERS[q.provider as ProviderId] ? (q.provider as ProviderId) : undefined;
    const used = creditsUsedThisMonth('kr/'); // Kiro không có API usage → đếm tại chỗ
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
        cooldownUntil: a.cooldownUntil,
        monthlyExhaustedUntil: a.monthlyExhaustedUntil || 0,
        lastError: a.lastError,
        quota: a.quota ?? null,
        geminiPct: geminiPct(a),
        claudePct: claudePct(a),
        liveStatus: a.liveStatus ?? null,
        hasProxy: !!a.proxyLabel,
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

  app.get('/api/gateway/config', async () => ({
    enabled: config.gateway.enabled,
    rotation: config.gateway.rotation,
    apiKey: config.gateway.apiKey,
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
    setConfig(patch);
    return { ok: true, config: { ...config.gateway } };
  });

  app.get('/api/gateway/models', async () => ({
    models: allModels().map((m) => ({
      id: m.prefixed, bare: m.id, label: m.label, image: m.image,
      provider: m.provider, providerLabel: m.providerLabel,
      bucket: m.bucket, maxInput: m.maxInput,
    })),
  }));

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
    let ctx: Awaited<ReturnType<typeof pickReady>>;
    try {
      ctx = await pickReady(parsed.provider!, forced, proxy);
    } catch (e: any) {
      return reply.code(e?.code ?? 503).send({ error: e?.message ?? 'no account' });
    }
    const plabel = proxyLabelOf(ctx.account, proxy);
    emitGw({ kind: 'req', account: ctx.account.email, model, proxy: plabel, endpoint: 'chat-test', msg: `→ ${model} · ${ctx.account.email} · chat-test · proxy:${plabel}` });
    try {
      const r = await PROVIDERS[parsed.provider!].generate({
        session: ctx.session,
        model: parsed.model!,
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
      pool.report(ctx.account.email, { ok: false, status: e?.status, err: e?.message, retryAfterMs: e?.retryAfterMs });
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
    const a = accOf(req, email);
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

  /**
   * Số liệu hiệu năng để vẽ biểu đồ: tỉ lệ thành công + p95 độ trễ mỗi provider,
   * cộng mẫu `ms`/`ok` thô cho histogram. providerStats() vốn đã tính sẵn cho việc
   * chấm điểm định tuyến nhưng CHƯA từng có endpoint nào expose ra UI.
   */
  app.get('/api/gateway/stats', async (req) => {
    const q = (req.query ?? {}) as any;
    const days = Math.min(90, Math.max(1, Number(q.days) || 7));
    const since = Date.now() - days * 86400_000;
    const rows = usageRows(since, Date.now());
    // Chỉ giữ 2 cột cần cho histogram/tỉ lệ lỗi — tránh đẩy cả nghìn bản ghi đầy đủ.
    const samples = rows.slice(-3000).map((r) => ({ ts: r.ts, ms: r.ms, ok: r.ok, model: r.model }));
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

  // ---------------- Test lẻ (còn sống?) ----------------
  async function testAccount(a: PoolAccount): Promise<{ alive: boolean; ms: number; detail?: string }> {
    const t0 = Date.now();
    // Target phải theo ĐÚNG provider của account. Hard-code 'agy' khiến test một account
    // Kiro ghi health vào credential 'agy' cùng email (nếu có) — sai account, và bản thân
    // account Kiro thì không bao giờ được cập nhật.
    const target = PROVIDERS[a.provider].credentialTarget;
    try {
      const dispatcher = dispatcherFor(a);
      // Kiro không dùng OAuth Google — ensureReady() của provider mới là đường đúng.
      if (a.provider === 'agy') {
        a.token = await refreshAccessToken(a.refreshToken, dispatcher);
      } else {
        await ensureReady(a, dispatcher);
      }
      a.health = 'alive';
      store.setCredentialHealth(a.email, target, 'alive');
      return { alive: true, ms: Date.now() - t0 };
    } catch (e: any) {
      /**
       * `dead` LOẠI ACCOUNT VĨNH VIỄN khỏi pool (xem pool.candidates) và không có đường tự
       * phục hồi — chỉ người dùng test lại thủ công mới gỡ được. Trước đây MỌI lỗi refresh
       * đều đánh dead, nên một đợt mạng chập/429 thoáng qua là mất sạch pool: đo thật thấy
       * 180/201 account bị dead mà test lại thì 5/5 sống, refresh chỉ mất 64-207ms.
       *
       * Chỉ dead khi Google nói rõ token KHÔNG còn dùng được (invalid_grant / revoked /
       * 400-401). Lỗi tạm thời (429, 5xx, timeout, mạng) → cooldown ngắn rồi thử lại.
       */
      // refreshAccessToken ném Error dạng `refresh token failed (400): {...}` — KHÔNG gắn
      // e.status, nên phải đọc mã từ chính message.
      const msg = String(e?.message ?? e);
      const code = Number(/refresh token failed \((\d+)\)/.exec(msg)?.[1] ?? 0);
      const permanent = /invalid_grant|invalid_client|unauthorized_client|revoked|token has been expired/i.test(msg)
        || code === 400 || code === 401;
      if (permanent) {
        a.health = 'dead';
        store.setCredentialHealth(a.email, target, 'dead');
      } else {
        a.cooldownUntil = Date.now() + 60_000;
      }
      return { alive: false, ms: Date.now() - t0, detail: msg.slice(0, 120) };
    }
  }

  /** Check live: account có gọi model thật được không (khác check token). */
  async function checkLiveAccount(a: PoolAccount): Promise<{ status: 'ok' | 'quota' | 'error'; ms: number; detail?: string }> {
    const t0 = Date.now();
    try {
      const dispatcher = dispatcherFor(a);
      const session = await ensureReady(a, dispatcher);
      const r = await PROVIDERS[a.provider].checkLive(a, session, dispatcher);
      a.liveStatus = r.status;
      if (r.status === 'ok') a.health = 'alive';
      // Kiro: 402 hết hạn mức tháng → cho nghỉ dài để pool không chọn lại
      if (r.status === 'quota') a.cooldownUntil = Date.now() + 12 * 3600 * 1000;
      recordQuota({ ts: Date.now(), email: a.email, tier: a.provider, geminiPct: null, thirdPct: null, probeOk: r.status === 'ok' });
      return r;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const quota = e?.status === 429 || e?.status === 402 || /quota|exhaust|resource_exhausted|MONTHLY_REQUEST/i.test(msg);
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

  /** Check hàng loạt token/live/both — chạy nền, emit realtime từng account. */
  app.post('/api/gateway/accounts/check', async (req) => {
    const { emails, mode } = (req.body as { emails?: string[]; mode?: 'token' | 'live' | 'both' }) ?? {};
    const m = mode || 'token';
    syncFromStore();
    const targets = (emails && emails.length ? emails.map((e) => (e.includes(':') ? pool.getByKey(e) : pool.get(e, 'agy'))).filter(Boolean) : pool.list()) as PoolAccount[];
    const total = targets.length;
    (async () => {
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
        await new Promise((r) => setTimeout(r, 1200)); // xem ghi chú nhịp ở test-bulk
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
    const targets = (emails && emails.length ? emails.map((e) => (e.includes(':') ? pool.getByKey(e) : pool.get(e, 'agy'))).filter(Boolean) : pool.list()) as PoolAccount[];
    const total = targets.length;
    (async () => {
      let i = 0;
      for (const a of targets) {
        i++;
        const r = await testAccount(a);
        emitCheck(a.email, 'token', r.alive ? 'alive' : 'dead', r.alive ? 'info' : 'warn', i, total);
        // 300ms × 400 account = Google chặn tốc độ endpoint refresh, gần như mọi account
        // sau vài chục cái đầu đều fail → bulk test tự tay giết pool. Đo thật: chạy bulk
        // không gỡ được cái nào, trong khi test lẻ (giãn ~1.2s) thì 100% hồi sinh.
        await new Promise((r) => setTimeout(r, 1200));
      }
      savePersist();
      log('', 'info', `Test token xong: ${total} account`);
    })().catch(() => {});
    return { queued: total };
  });

  // ---------------- Check live model ----------------
  app.post('/api/gateway/models/check', async (req, reply) => {
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

  /** OpenAI retrieve-model: `GET /proxy/v1/models/:id` — vài gateway gọi để xác thực model. */
  app.get('/proxy/v1/models/:id', async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send({ error: { message: 'unauthorized' } });
    const raw = decodeURIComponent((req.params as any).id ?? '');
    try {
      const p = parseModelId(raw);
      return {
        id: raw,
        object: 'model',
        created: 0,
        owned_by: p.kind === 'provider' ? (p.provider === 'kr' ? 'kiro' : 'antigravity') : 'combo',
      };
    } catch (e: any) {
      return reply.code(404).send({ error: { message: e?.message ?? 'model not found', type: 'invalid_request_error' } });
    }
  });

  /**
   * OpenAI **Responses API** — `POST /proxy/v1/responses`.
   * OmniRoute/Codex gọi đường này thay cho /chat/completions (wire_api="responses").
   * Không có nó thì báo: `404 Route POST:/proxy/v1/responses not found`.
   */
  app.post('/proxy/v1/responses', async (req, reply) => {
    if (!authOk(req)) return reply.code(401).send({ error: { message: 'unauthorized', type: 'authentication_error' } });
    if (!config.gateway.enabled) return reply.code(503).send({ error: { message: 'gateway disabled' } });
    const b = (req.body ?? {}) as any;

    let parsed: ParsedModel;
    try {
      parsed = parseModelId(b?.model);
    } catch (e: any) {
      return reply.code(400).send({ error: { message: e?.message, type: 'invalid_request_error', param: 'model' } });
    }

    // input: chuỗi, hoặc mảng {role, content} với content là chuỗi/mảng khối
    const messages: ChatMessage[] = [];
    if (b.instructions) messages.push({ role: 'system', content: String(b.instructions) });
    const pushPart = (role: any, content: any) => {
      if (typeof content === 'string') messages.push({ role, content });
      else if (Array.isArray(content)) {
        const text = content
          .map((c: any) => (typeof c === 'string' ? c : c?.text ?? c?.input_text ?? ''))
          .filter(Boolean)
          .join('\n');
        if (text) messages.push({ role, content: text });
      }
    };
    if (typeof b.input === 'string') messages.push({ role: 'user', content: b.input });
    else if (Array.isArray(b.input)) for (const it of b.input) pushPart(it?.role ?? 'user', it?.content ?? it);
    if (!messages.some((m) => m.role !== 'system')) messages.push({ role: 'user', content: '' });

    const generationConfig: Record<string, unknown> = {};
    // Cùng trần với nhánh Anthropic — vượt 64K thì Google trả 429 trần, xem MAX_OUTPUT_TOKENS_CAP.
    if (typeof b.max_output_tokens === 'number') {
      generationConfig.maxOutputTokens = Math.min(b.max_output_tokens, MAX_OUTPUT_TOKENS_CAP);
    }
    if (typeof b.temperature === 'number') generationConfig.temperature = b.temperature;
    if (typeof b.top_p === 'number') generationConfig.topP = b.top_p;

    try {
      syncFromStore();
      // stream của Responses API có bộ sự kiện riêng → v1 trả nguyên khối cho chắc
      const one = (p: ParsedModel) =>
        runProviderCall({
          provider: p.provider!, bare: p.model!, labelModel: p.prefixed,
          messages, stream: false, reply, endpoint: '/proxy/v1/responses',
          generationConfig,
        } as any);

      let out: any;
      let usedModel = parsed.prefixed;
      if (parsed.kind === 'provider') {
        out = await one(parsed);
      } else {
        const res = resolveComboPlan(parsed);
        if ('error' in res) return reply.code(res.status).send({ error: { message: res.error } });
        let lastErr: any;
        for (let step = 0; step < Math.min(res.plan.length, 3); step++) {
          const t0 = Date.now();
          let p: ParsedModel;
          try { p = parseModelId(res.plan[step]!.model); } catch (e) { lastErr = e; continue; }
          if (p.kind !== 'provider') continue;
          try {
            out = await one(p);
            usedModel = res.name;
            recordComboRun({ combo: res.name, step, model: p.prefixed, ok: true, ms: Date.now() - t0 });
            break;
          } catch (e: any) {
            lastErr = e;
            recordComboRun({ combo: res.name, step, model: p.prefixed, ok: false, status: e?.status, ms: Date.now() - t0, reason: String(e?.message ?? e) });
            if (!shouldFallback(e)) throw e;
          }
        }
        if (!out) throw lastErr ?? new NoAccountError(`${res.name}: mọi bước đều lỗi`);
      }

      const r = out.result;
      let text = r.text;
      for (const img of r.images ?? []) text += (text ? '\n\n' : '') + `![image](${img})`;
      return reply.send({
        id: 'resp_' + randomUUID().replace(/-/g, ''),
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: usedModel,
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_' + randomUUID().replace(/-/g, ''),
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ],
        output_text: text, // tiện cho client đọc thẳng
        usage: {
          input_tokens: r.usage.promptTokens,
          output_tokens: r.usage.completionTokens,
          total_tokens: r.usage.totalTokens,
        },
      });
    } catch (e: any) {
      const code = e instanceof NoAccountError ? 503 : e?.status === 400 ? 400 : 502;
      const hint = contextHint(e, parsed.prefixed);
      return reply.code(code).send({ error: { message: hint ?? e?.message ?? 'all accounts failed', type: 'api_error' } });
    }
  });

  // ---------------- Anthropic Messages API (cho Claude Code) ----------------
  // Claude Code cấu hình ANTHROPIC_BASE_URL=http://host:port (KHÔNG kèm /v1) rồi tự gọi /v1/messages.
  // Thêm /proxy/v1/messages: client (Hermes…) trỏ base_url vào /proxy/v1 nhưng nói Anthropic
  // Messages API — nó nối '/messages' vào base nên rơi ra ngoài 2 path trên.
  const anthropicPaths = ['/v1/messages', '/anthropic/v1/messages', '/proxy/v1/messages'];

  /** Kiểm key kiểu Anthropic: x-api-key hoặc Authorization: Bearer. */
  function anthropicAuthOk(req: FastifyRequest): boolean {
    const key = config.gateway.apiKey;
    if (!key) return true;
    const xk = (req.headers['x-api-key'] || '') as string;
    const h = (req.headers['authorization'] || '') as string;
    return xk === key || h === `Bearer ${key}` || h === key;
  }

  for (const path of anthropicPaths) {
    app.post(path, async (req, reply) => {
      if (!anthropicAuthOk(req)) return reply.code(401).send(anthropicErrorBody(401, 'invalid x-api-key'));
      if (!config.gateway.enabled) return reply.code(503).send(anthropicErrorBody(503, 'gateway disabled'));
      const b = (req.body ?? {}) as AnthropicRequest;
      if (!Array.isArray(b.messages) || !b.messages.length) {
        return reply.code(400).send(anthropicErrorBody(400, 'messages[] là bắt buộc'));
      }
      syncFromStore();

      const wanted = resolveAnthropicModel(b.model, {
        big: config.gateway.anthropicBigModel,
        small: config.gateway.anthropicSmallModel,
      });
      let parsed: ParsedModel;
      try {
        parsed = parseModelId(wanted);
      } catch (e: any) {
        return reply.code(400).send(anthropicErrorBody(400, e.message));
      }

      const messages = anthropicToMessages(b);
      const generationConfig = anthropicGenerationConfig(b);
      const tools = anthropicToolDefs(b);
      const stream = !!b.stream;
      const echoModel = b.model || parsed.prefixed;
      const msgId = 'msg_' + randomUUID().replace(/-/g, '');

      /** Gọi 1 model; nếu là combo/auto thì thử lần lượt theo kế hoạch (fallback). */
      const call = async (
        target: ParsedModel,
        streamWriter?: (t: string) => void,
        onToolCall?: (c: ToolCall) => void,
      ) => {
        const one = (p: ParsedModel, label?: string) =>
          runProviderCall({
            provider: p.provider!, bare: p.model!, labelModel: p.prefixed,
            messages, stream: !!streamWriter, reply, endpoint: label ?? '/v1/messages',
            sseWriter: streamWriter,
            generationConfig,
            tools,
            onToolCall,
          });

        if (target.kind === 'provider') return one(target);

        // combo / auto — dùng chung engine với /proxy/v1
        const res = resolveComboPlan(target);
        if ('error' in res) throw Object.assign(new Error(res.error), { status: res.status });
        if (!res.plan.length) throw Object.assign(new Error(`${res.name}: không có model khả dụng`), { status: 503 });
        // Claude Code luôn gửi tools → bỏ bước không hỗ trợ tool-use (xem runComboRequest).
        const steps = tools.length
          ? res.plan.filter((t) => {
              try {
                const p = parseModelId(t.model);
                return p.kind !== 'provider' || !!PROVIDERS[p.provider!]?.supportsTools;
              } catch { return true; }
            })
          : res.plan;
        if (!steps.length) {
          throw Object.assign(new Error(`${res.name}: không có bước nào hỗ trợ tool-use — thêm model agy/ vào combo.`), { status: 400 });
        }
        let lastErr: any;
        for (let step = 0; step < Math.min(steps.length, COMBO_MAX_STEPS); step++) {
          const t0 = Date.now();
          let p: ParsedModel;
          try {
            p = parseModelId(steps[step]!.model);
          } catch (e) { lastErr = e; continue; }
          if (p.kind !== 'provider') continue;
          try {
            const out = await one(p, res.name);
            recordComboRun({ combo: res.name, step, model: p.prefixed, ok: true, ms: Date.now() - t0 });
            return out;
          } catch (e: any) {
            lastErr = e;
            recordComboRun({ combo: res.name, step, model: p.prefixed, ok: false, status: e?.status, ms: Date.now() - t0, reason: String(e?.message ?? e) });
            emitGw({ kind: 'err', account: '-', model: res.name, status: e?.status, msg: `${res.name} bước ${step + 1} (${p.prefixed}) lỗi → ${shouldFallback(e) ? 'trượt tiếp' : 'dừng'}` });
            if (streamWriter && reply.raw.headersSent) throw e; // đã gửi byte → không cứu được
            if (!shouldFallback(e)) throw e;
          }
        }
        throw lastErr ?? new NoAccountError(`${res.name}: mọi bước đều lỗi`);
      };

      try {
        if (!stream) {
          const out = await call(parsed);
          if ('result' in out) return reply.send(resultToAnthropic(echoModel, out.result, msgId));
          return reply;
        }

        // ----- streaming theo đúng thứ tự sự kiện Anthropic -----
        // Mở stream LƯỜI: gửi header + message_start ngay từ đây thì headersSent=true
        // TRƯỚC KHI gọi model, nên bước 1 của combo lỗi 429 sẽ rơi vào nhánh "đã gửi byte
        // → không cứu được" và combo mất hẳn tác dụng khi stream (đo thật: 1/20 request
        // rò 429 ra client dù còn 3 bước dự phòng chưa dùng). Hoãn tới byte THẬT đầu tiên
        // ⇒ mọi lỗi xảy ra trước đó vẫn trượt bước được, và vẫn trả JSON lỗi sạch.
        let started = false;
        const startStream = () => {
          if (started) return;
          started = true;
          sseInit(reply);
          reply.raw.write(sseFrame('message_start', {
            type: 'message_start',
            message: { id: msgId, type: 'message', role: 'assistant', model: echoModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
          }));
        };
        const ping = setInterval(() => { if (started) reply.raw.write(sseFrame('ping', { type: 'ping' })); }, 15_000);
        let outChars = 0;
        let sawTool = false;
        // Mỗi block phải mở/đóng ĐÚNG MỘT LẦN theo index tăng dần. Block text mở LAZY:
        // lượt chỉ gọi tool thì không phát block text rỗng thừa. `textOpen` là block
        // DUY NHẤT có thể còn mở khi tới tool kế (block tool tự đóng ngay sau khi ghi).
        let index = -1;
        let textOpen = false;
        const openText = () => {
          if (textOpen) return;
          startStream();
          index++;
          textOpen = true;
          reply.raw.write(sseFrame('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
        };
        const closeText = () => {
          if (!textOpen) return;
          reply.raw.write(sseFrame('content_block_stop', { type: 'content_block_stop', index }));
          textOpen = false;
        };
        try {
          await call(
            parsed,
            (t) => {
              openText();
              outChars += t.length;
              reply.raw.write(sseFrame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } }));
            },
            (c) => {
              sawTool = true;
              startStream();
              closeText(); // chỉ block text mới cần đóng ở đây
              index++;
              const args = JSON.stringify(c.input ?? {});
              outChars += args.length;
              reply.raw.write(sseFrame('content_block_start', {
                type: 'content_block_start', index,
                content_block: {
                  type: 'tool_use', id: c.id, name: c.name, input: {},
                  // Chữ ký Gemini đi kèm để client trả lại ở lượt sau.
                  ...(c.signature ? { _signature: c.signature } : {}),
                },
              }));
              // Gemini trả args nguyên khối → phát 1 delta duy nhất rồi đóng ngay.
              reply.raw.write(sseFrame('content_block_delta', {
                type: 'content_block_delta', index,
                delta: { type: 'input_json_delta', partial_json: args },
              }));
              reply.raw.write(sseFrame('content_block_stop', { type: 'content_block_stop', index }));
            },
          );
          closeText();
          if (index < 0) { // không có byte nào → vẫn phải có 1 block hợp lệ
            openText();
            closeText();
          }
          startStream(); // model im lặng hoàn toàn: vẫn phải mở stream trước khi đóng
          reply.raw.write(sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: sawTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.ceil(outChars / 4) } }));
          reply.raw.write(sseFrame('message_stop', { type: 'message_stop' }));
        } finally {
          clearInterval(ping);
        }
        reply.raw.end();
        return reply;
      } catch (e: any) {
        const status = e?.status === 400 ? 400 : e instanceof NoAccountError ? 503 : 502;
        if (reply.raw.headersSent) {
          reply.raw.write(sseFrame('error', anthropicErrorBody(status, String(e?.message ?? e))));
          reply.raw.end();
          return reply;
        }
        return reply.code(status).send(anthropicErrorBody(status, String(e?.message ?? e)));
      }
    });
  }

  for (const path of ['/v1/models', '/anthropic/v1/models']) {
    app.get(path, async (req, reply) => {
      if (!anthropicAuthOk(req)) return reply.code(401).send(anthropicErrorBody(401, 'invalid x-api-key'));
      const data = allModels().map((m) => ({
        type: 'model', id: m.prefixed, display_name: `${m.label} (${m.providerLabel})`,
        created_at: new Date(0).toISOString(),
      }));
      return { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null };
    });
  }

  for (const path of ['/v1/messages/count_tokens', '/anthropic/v1/messages/count_tokens', '/proxy/v1/messages/count_tokens']) {
    app.post(path, async (req) => {
      const b = (req.body ?? {}) as AnthropicRequest;
      const chars = JSON.stringify(b.messages ?? []).length + JSON.stringify(b.system ?? '').length;
      return { input_tokens: Math.ceil(chars / 4) };
    });
  }

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

  // ---------------- Tự dò hạn mức Kiro (Kiro KHÔNG có API quota) ----------------
  // Mỗi vòng chỉ dò 1 LÔ NHỎ account chưa biết trạng thái → tránh đốt hạn mức thật.
  let probeTimer: NodeJS.Timeout | null = null;
  const scheduleKiroProbe = () => {
    if (probeTimer) clearTimeout(probeTimer);
    const hours = Math.max(1, config.gateway.kiroProbeHours);
    probeTimer = setTimeout(async () => {
      if (config.gateway.kiroProbeEnabled) {
        const batch = Math.max(1, config.gateway.kiroProbeBatch);
        // ưu tiên account chưa dò bao giờ, rồi tới account dò lâu nhất
        const targets = pool
          .candidates(Date.now(), 'kr')
          .filter((a) => a.enabled)
          .sort((x, y) => (x.liveStatus ? 1 : 0) - (y.liveStatus ? 1 : 0) || (x.lastUsed || 0) - (y.lastUsed || 0))
          .slice(0, batch);
        for (const a of targets) {
          try {
            const r = await checkLiveAccount(a);
            log(a.email, r.status === 'ok' ? 'info' : 'warn', `dò hạn mức Kiro: ${r.status} (${r.ms}ms)`);
          } catch {
            /* bỏ qua, vòng sau dò lại */
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (targets.length) savePersist();
      }
      scheduleKiroProbe();
    }, hours * 3600_000);
    probeTimer.unref?.();
  };
  scheduleKiroProbe();

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

  // Dọn lịch sử cũ (theo cấu hình, mặc định 90 ngày): lúc boot + mỗi 24h.
  const prune = () => {
    try {
      pruneQuotaHistory(config.gateway.quota?.historyDays ?? 90);
    } catch { /* bỏ qua */ }
  };
  prune();
  setInterval(prune, 24 * 3600_000).unref?.();
}
