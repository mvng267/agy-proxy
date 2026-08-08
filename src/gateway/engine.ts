import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { authenticate, type AuthCtx } from './apikeys.js';
import { toOpenAIFinish } from './openai.js';
import { emitLog } from '../events.js';
import { store } from '../store/index.js';
import {
  recordGatewayUsage, listComboRows, recordComboRun, providerStats, recordQuota, setSetting,
  comboRevision,
} from '../store/db.js';
import {
  PROVIDERS, PROVIDER_IDS, parseModelId,
  type ParsedModel, type ProviderId, type ProviderSession, type QuotaBucket,
} from './providers/index.js';
import {
  planCombo, planAuto, shouldFallback, isContextTooLong, isModelQuotaError, getRrCursor,
  type Combo, type ComboStrategy, type ComboTarget, type PoolSnapshot,
} from './combo.js';
import {
  pool,
  savePersist,
  ensureReady,
  dispatcherFor,
  refreshQuota,
  geminiPct,
  isTransientError,
  NoAccountError,
  streamLimiter,
  type PoolAccount,
  type Strategy,
} from './pool.js';
import { providerBreaker } from './breaker.js';
import { refreshAccessToken, type ChatMessage, type GenResult, type ToolCall, type ToolDef } from './antigravity.js';
import { openaiCompletion, sseChunk } from './dialects/wire.js';
import { gatewayMetrics } from './metrics.js';

/**
 * Engine: business logic của gateway — chọn account, gọi provider với failover,
 * chạy kế hoạch combo/auto, health check account. Các dialect HTTP (OpenAI, Anthropic)
 * và admin API đều gọi vào đây; engine KHÔNG đăng ký route nào.
 */

export function log(email: string, level: string, msg: string) {
  emitLog({ runId: 0, email, flow: 'gateway', level, msg });
}

/** Log giàu cho live call→response. */
export function emitGw(e: {
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
  /** Ai gọi (tên API key) và qua combo nào — để Live Log lọc được theo user. */
  apiKey?: string;
  combo?: string;
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
    apiKey: e.apiKey,
    combo: e.combo,
  });
}

/** Số bước tối đa combo/auto sẽ thử trước khi bỏ cuộc (dùng chung cho cả 2 nhánh). */
export const COMBO_MAX_STEPS = 6;

/**
 * Attribution cho một request CLIENT (không phải một lần gọi upstream).
 * `requestId` nối các bước combo lại: combo lỗi 3 bước rồi thành công tạo 4 dòng usage,
 * trước đây không cách nào biết chúng cùng gốc.
 */
export interface UsageCtx {
  requestId: string;
  apiKeyId: string;
  /** Tên người dùng của key — chỉ để HIỂN THỊ trong Live Log, không dùng xác thực. */
  keyName?: string;
  combo?: string;
  endpoint: string;
  stream: boolean;
}

/** Ghi usage + (tuỳ chọn) cập nhật quota kèm mỗi lần gọi. */
export function afterCall(
  account: PoolAccount,
  model: string,
  r: { ok: boolean; promptTokens?: number; completionTokens?: number; ms: number; status?: number },
  ctx?: UsageCtx,
) {
  gatewayMetrics.record(r.ok, r.ms);
  recordGatewayUsage({
    ts: Date.now(),
    email: account.email,
    model,
    promptTokens: r.promptTokens ?? 0,
    completionTokens: r.completionTokens ?? 0,
    ok: r.ok,
    ms: r.ms,
    status: r.status,
    apiKeyId: ctx?.apiKeyId,
    combo: ctx?.combo,
    endpoint: ctx?.endpoint,
    requestId: ctx?.requestId,
    stream: ctx?.stream,
  });
  if (config.gateway.quota?.onCall) {
    // Refresh CẢ khi lỗi quota: đó chính là lúc quota vừa đổi mạnh nhất, mà trước đây
    // `if (r.ok && …)` lại bỏ qua đúng trường hợp đó. force=true để bỏ qua TTL cache.
    const quotaErr = r.status === 402 || r.status === 429;
    if (r.ok) refreshQuota(account).catch(() => {});
    else if (quotaErr) refreshQuota(account, true).catch(() => {});
  }
}

export function proxyLabelOf(account: PoolAccount, override?: string): string {
  return override || account.proxyLabel || (config.gateway.outboundProxy ? 'global' : 'direct');
}

function strategy(): Strategy {
  return (config.gateway.rotation as Strategy) || 'round-robin';
}

/**
 * Kiểm API key. Trả true nếu hợp lệ (hoặc chưa cấu hình key nào).
 *
 * Nhận cả `x-api-key`: client Anthropic (Hermes…) trỏ base_url vào /proxy/v1 chỉ gửi
 * header này. Thiếu nó thì GET /proxy/v1/models trả 401 → client tưởng proxy KHÔNG có
 * Models API nên bỏ qua bước xác minh và chấp nhận bừa mọi tên model, kể cả model hỏng.
 *
 * Trước đây có HAI hàm (`authOk` cho OpenAI-path, `anthropicAuthOk` cho Anthropic-path)
 * với logic TRÙNG HOÀN TOÀN, và cả hai so sánh bằng `===` (không timing-safe).
 * Nay cùng gọi `authenticate()` — xem src/gateway/apikeys.ts.
 */
export function authOk(req: FastifyRequest): boolean {
  return authenticate(req) !== null;
}

/** Như authOk nhưng trả context để ghi attribution vào usage. */
export function authCtx(req: FastifyRequest): AuthCtx | null {
  return authenticate(req);
}

/** Lấy account theo email + provider từ query (mặc định agy → URL cũ vẫn đúng). */
export function accOf(req: FastifyRequest, email: string): PoolAccount | undefined {
  const q = (req.query ?? {}) as any;
  const pid = (q.provider as ProviderId) || 'agy';
  return pool.get(email, PROVIDERS[pid] ? pid : 'agy');
}

/** Bể hạn mức của 1 model (id TRẦN). undefined = provider không chia bể. */
export function bucketOf(provider: ProviderId, bare: string): QuotaBucket | undefined {
  return PROVIDERS[provider]?.models.find((m) => m.id === bare)?.bucket;
}

/** Chọn account của ĐÚNG provider (ép email nếu có) + lấy session sẵn sàng. */
export async function pickReady(
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

// ---------------- Combo helpers ----------------
/**
 * Cache combo đã parse — trước đây MỖI request combo đều query DB + JSON.parse toàn bộ
 * targets. Revision (bump trong upsert/deleteComboRow) làm thay đổi trong process thấy
 * NGAY; TTL 10s là lưới an toàn cho process khác ghi DB (CLI) mà không bump được rev.
 */
let comboCache: { rev: number; at: number; combos: Combo[] } | null = null;

export function listCombos(): Combo[] {
  const rev = comboRevision();
  if (comboCache && comboCache.rev === rev && Date.now() - comboCache.at < 10_000) {
    return comboCache.combos;
  }
  const combos = listComboRows().map((r) => ({
    id: r.id,
    name: r.name,
    strategy: r.strategy as ComboStrategy,
    targets: JSON.parse(r.targets_json) as ComboTarget[],
    enabled: r.enabled !== 0,
  }));
  comboCache = { rev, at: Date.now(), combos };
  return combos;
}

let statsCache: { at: number; snap: PoolSnapshot } | null = null;
/** Ảnh chụp pool cho chấm điểm — cache 60s (KHÔNG truy vấn DB mỗi request). */
export function poolSnapshot(): PoolSnapshot {
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

/** Dựng thứ tự thử cho combo/auto (dùng chung cho cả /proxy/v1 lẫn /v1/messages). */
export function resolveComboPlan(parsed: ParsedModel): { name: string; plan: ComboTarget[] } | { error: string; status: number } {
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
export async function runComboRequest(
  parsed: ParsedModel,
  o: {
    messages: ChatMessage[];
    tools?: ToolDef[];
    stream: boolean;
    reply: FastifyReply;
    runProviderCall: (opts: any) => Promise<{ done: true } | { result: GenResult }>;
    /** Attribution; `combo` được điền theo tên combo thật ở từng bước. */
    usage?: UsageCtx;
    /** Tham số sinh của client (max_tokens, temperature…) — mọi bước dùng chung. */
    generationConfig?: Record<string, unknown>;
    toolConfig?: Record<string, unknown>;
  },
): Promise<any> {
  // resolveComboPlan là NGUỒN DUY NHẤT dựng plan (trước đây khối này tự lặp lại
  // đúng logic đó — hai bản đã bắt đầu phân kỳ ở thông điệp lỗi).
  const resolved = resolveComboPlan(parsed);
  if ('error' in resolved) return o.reply.code(resolved.status).send({ error: resolved.error });
  const comboName = resolved.name;
  let plan = resolved.plan;
  if (!plan.length) return o.reply.code(503).send({ error: `${comboName}: không có model nào khả dụng` });

  // Có tools → bỏ các bước trỏ tới provider không có function calling (bước đó
  // chắc chắn 400, trượt qua luôn cho đỡ tốn 1 lượt trong 3 bước).
  if (o.tools?.length) {
    plan = plan.filter((t) => {
      try {
        const p = parseModelId(t.model);
        return p.kind !== 'provider' || !!PROVIDERS[p.provider!]?.supportsTools || !!PROVIDERS[p.provider!]?.bypassTools;
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
  // Chia sẻ danh sách account đã lỗi qua các combo steps — tránh pick lại
  // account vừa 429/5xx ở bước trước.
  const skipKeys = new Set<string>();
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
        skipKeys,
        generationConfig: o.generationConfig,
        toolConfig: o.toolConfig,
        // Mọi bước dùng CHUNG requestId → 1 request client = N dòng usage liên kết được.
        usage: o.usage ? { ...o.usage, combo: comboName } : undefined,
      });
      recordComboRun({ combo: comboName, step, model: p.prefixed, ok: true, ms: Date.now() - t0 });
      setSetting('comboRrCursor', String(getRrCursor()));
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
  // Persist combo round-robin cursor sau mỗi combo run
  setSetting('comboRrCursor', String(getRrCursor()));
  throw lastErr ?? new NoAccountError(`${comboName}: mọi bước đều lỗi`);
}

/**
 * Chạy 1 lượt gọi model (đã biết provider + id trần) với failover qua nhiều account.
 * Trả về true nếu đã gửi response (stream), hoặc GenResult nếu non-stream.
 */
export async function runProviderCall(opts: {
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
  /** Account keys đã lỗi trong request này — bỏ qua khi pick. */
  skipKeys?: Set<string>;
  /** Attribution ghi kèm usage (api key, combo, request_id…). */
  usage?: UsageCtx;
  /** Usage THẬT từ upstream — nhánh Anthropic dùng thay vì ước lượng chars/4. */
  onUsage?: (u: { promptTokens: number; completionTokens: number }) => void;
  /** Ép/cấm gọi tool — nguồn là `tool_choice` của client. */
  toolConfig?: Record<string, unknown>;
}): Promise<{ done: true } | { result: GenResult }> {
  const { provider, bare, labelModel, messages, stream, reply } = opts;
  const p = PROVIDERS[provider];
  // Provider không có function calling native:
  //  - bypassTools=true → cho qua (agy-proxy tự parse tool_calls từ text output)
  //  - supportsTools=false & bypassTools=undefined → ném 400 rõ ràng
  if (opts.tools?.length && !p.supportsTools && !p.bypassTools) {
    throw Object.assign(
      new Error(`${p.label} (${provider}/) không hỗ trợ tool-use — dùng model agy/ cho Claude Code, hoặc tắt tool.`),
      { status: 400 },
    );
  }
  // Circuit breaker theo provider: cả upstream đang sập thì fail-fast 503 ngay,
  // không đốt thêm 3 lượt gọi mạng + hàng chục vòng pick. 503 nằm trong shouldFallback
  // nên combo/auto tự trượt sang provider khác.
  providerBreaker.allow(provider);
  /**
   * Mọi dòng log của request này đều mang theo "ai gọi" (tên API key) và combo.
   *
   * Bọc lại thay vì thêm 2 field ở 8 chỗ gọi emitGw: chỉ cần quên MỘT chỗ là dòng log
   * đó mất danh tính, mà đúng những dòng hay quên nhất lại là nhánh lỗi — nơi cần biết
   * user nào nhất.
   */
  const gw = (e: Parameters<typeof emitGw>[0]) =>
    emitGw({ ...e, apiKey: opts.usage?.keyName, combo: opts.usage?.combo });
  const genArgs = { generationConfig: opts.generationConfig, tools: opts.tools, toolConfig: opts.toolConfig };
  const bucket = bucketOf(provider, bare);
  /**
   * skipKeys chia 2 mức:
   *  - `key` trần: account HỎNG (5xx/mạng) — tránh mọi bước sau, bất kể model.
   *  - `key#bucket`: account CẠN HẠN MỨC của đúng bể đó — bước sau dùng model bể KHÁC
   *    (vd combo gemini→claude cùng provider agy) vẫn được dùng account này.
   * Trước đây quota-error cũng ghi key trần, nên combo 2 bước khác bể trên pool nhỏ
   * chết ở bước 2 vì mọi account đều bị blacklist dù còn nguyên hạn mức bể kia.
   */
  const bucketSkip = (key: string) => `${key}#${bucket ?? ''}`;
  const avail = pool.candidates(Date.now(), provider, bucket).length;
  // Lỗi thật (5xx/mạng) chỉ thử 3 account. Nhưng account HẾT HẠN MỨC thì bị cooldown
  // ngay khi report → bỏ qua rất rẻ, nên không tính vào hạn thử.
  // Cần thiết vì pool Kiro có ~40% account đã cạn hạn mức tháng.
  //
  // Ngân sách skip cũ là 12: khi Google chặn tốc độ DIỆN RỘNG, hàng chục account liên
  // tiếp cùng trả `stream 429` → cạn ngân sách rồi ném lỗi ra client DÙ pool còn ~190
  // account khoẻ. Đo thực tế: 18 request stream song song → 1 lần rò 429 ra ngoài.
  // Mỗi lần bỏ qua chỉ tốn 1 vòng pick (account bị cooldown ngay, không gọi mạng lại),
  // nên nới lên 32 vẫn rẻ mà nuốt được đợt 429 dài hơn nhiều.
  let maxTry = Math.min(3, Math.max(1, avail));
  let maxSkip = Math.min(32, avail);
  let lastErr: any;
  let tries = 0;
  let skips = 0;

  // Kích thước prompt + số tool đi kèm mọi dòng req-log: khi 429 hàng loạt, đây là thứ
  // duy nhất phân biệt được request của client thật với request thử nghiệm. Tính MỘT lần
  // ngoài vòng failover — stringify cả messages (có thể hàng MB) mỗi attempt × tối đa
  // 32 lượt skip là chi phí O(n²) vô ích trên cùng một payload bất biến.
  const promptKB = Math.round(JSON.stringify(messages).length / 1024);
  const nTools = opts.tools?.length ?? 0;

  for (let attempt = 0; tries < maxTry && skips <= maxSkip; attempt++) {
    // `avail` là ảnh chụp TRƯỚC vòng lặp. Trong một đợt 429 diện rộng, số account khả
    // dụng đổi rất nhanh (cooldown hết hạn, account khác được release) nhưng ngân sách
    // vẫn tính theo số cũ. Tính lại định kỳ để bám sát thực tế.
    if (attempt > 0 && attempt % 8 === 0) {
      const now = pool.candidates(Date.now(), provider, bucket).length;
      maxTry = Math.min(3, Math.max(1, now));
      maxSkip = Math.min(32, Math.max(maxSkip, now));
    }
    let ctx: Awaited<ReturnType<typeof pickReady>>;
    try {
      // skipKeys: bỏ qua account đã lỗi trong cùng request này (chỉ áp dụng khi
      // không ép forcedEmail). pool.pick() chọn từ candidates() — ta lọc SAU pick
      // rồi release ngay nếu trúng, rẻ hơn clone candidates rồi filter.
      ctx = await pickReady(provider, opts.forcedEmail, opts.proxyOverride, bucket);
      if (opts.skipKeys?.has(ctx.account.key) || opts.skipKeys?.has(bucketSkip(ctx.account.key))) {
        pool.release(ctx.account);
        skips++;
        continue;
      }
    } catch (e: any) {
      lastErr = e;
      // Hết account thật → dừng. Nhưng lỗi của MỘT account (vd refresh token hỏng khiến
      // ensureReady ném) thì phải thử account kế: trước đây `break` ở đây làm cả vòng
      // failover dừng dù pool còn nguyên hàng trăm account khoẻ.
      if (e instanceof NoAccountError) break;
      // Lỗi hạ tầng ở tầng CHUẨN BỊ (endpoint auth sập, mạng đứt) cũng nuôi breaker:
      // một đợt outage thật thường chết ngay ở refresh token, chưa kịp gọi model nào.
      // invalid_grant/401 của MỘT account thì không tính — đó không phải provider sập.
      if (isTransientError(String(e?.message ?? e), e?.status)) providerBreaker.fail(provider);
      tries++;
      continue;
    }
    // Stream: giới hạn số request song song qua streamLimiter để giảm 429 hàng loạt.
    // Non-stream không cần vì ít bị rate-limit và response nhanh.
    let releaseLimiter: (() => void) | undefined;
    if (stream) releaseLimiter = await streamLimiter.acquire();
    const t0 = Date.now();
    const plabel = proxyLabelOf(ctx.account);
    gw({
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
        let finishReason: string | undefined;
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
          if (ev.usage) {
            pt = ev.usage.promptTokens; ct = ev.usage.completionTokens;
            opts.onUsage?.({ promptTokens: pt, completionTokens: ct });
          }
          if (ev.finishReason) finishReason = ev.finishReason;
        }
        if (!opts.sseWriter) {
          // Hardcode 'stop' sẽ NÓI DỐI khi upstream thực sự cắt vì max_tokens.
          sseChunk(reply, labelModel, id, {}, sawToolCall ? 'tool_calls' : toOpenAIFinish(finishReason));
          reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
        }
        const ms = Date.now() - t0;
        providerBreaker.ok(provider);
        pool.report(ctx.account, { ok: true, promptTokens: pt, completionTokens: ct, latencyMs: ms });
        afterCall(ctx.account, labelModel, { ok: true, promptTokens: pt, completionTokens: ct, ms, status: 200 }, opts.usage);
        savePersist();
        gw({ kind: 'res', account: ctx.account.email, model: labelModel, ms, tokens: pt + ct, status: 200, msg: `← 200 · stream · ${pt + ct} tok · ${ms}ms` });
        return { done: true };
      }
      const r = await p.generate({ session: ctx.session, model: bare, messages, ...genArgs, dispatcher: ctx.dispatcher });
      const ms = Date.now() - t0;
      providerBreaker.ok(provider);
      pool.report(ctx.account, { ok: true, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, latencyMs: ms });
      afterCall(ctx.account, labelModel, { ok: true, promptTokens: r.usage.promptTokens, completionTokens: r.usage.completionTokens, ms, status: 200 }, opts.usage);
      savePersist();
      gw({ kind: 'res', account: ctx.account.email, model: labelModel, ms, tokens: r.usage.totalTokens, status: 200, msg: `← 200 · ${r.usage.totalTokens} tok · ${ms}ms` });
      return { result: r };
    } catch (e: any) {
      lastErr = e;
      const ms = Date.now() - t0;
      // `bucket` để 429 chỉ khoá đúng bể quota của model vừa gọi, không khoá cả account.
      pool.report(ctx.account, {
        ok: false, status: e?.status, err: e?.message, retryAfterMs: e?.retryAfterMs,
        bucket, latencyMs: ms,
      });
      afterCall(ctx.account, labelModel, { ok: false, ms, status: e?.status }, opts.usage);
      const outOfQuota = e?.status === 402 || e?.status === 429 || /MONTHLY_REQUEST_COUNT|quota|exhaust/i.test(String(e?.message ?? ''));
      // Prompt quá dài KHÔNG phụ thuộc account — thử account khác chỉ tốn thời gian
      // và làm bẩn log. Dừng ngay để tầng combo đổi sang MODEL khác.
      const tooLong = isContextTooLong(e);
      if (tooLong) {
        gw({
          kind: 'err', account: ctx.account.email, model: labelModel, ms, status: e?.status,
          msg: `← ✗ ${e?.status ?? ''} prompt quá dài — không thử account khác, cần đổi model ngữ cảnh lớn hơn`,
        });
        throw e;
      }
      // "You have exhausted your capacity on THIS MODEL" = hết quota theo MODEL, không
      // theo account. Đổi account là vô nghĩa — mọi account đều đụng cùng trần model đó.
      // Đo thật (agy/gemini-2.5-pro): thử 32 account nối tiếp mất 197 GIÂY rồi vẫn 429,
      // trong khi ngay account đầu Google đã nói rõ "quota reset after 4h59m". Ném ngay
      // để tầng combo đổi sang MODEL khác, giống cách xử lý prompt quá dài ở trên.
      if (isModelQuotaError(e)) {
        gw({
          kind: 'err', account: ctx.account.email, model: labelModel, ms, status: e?.status,
          msg: `← ✗ ${e?.status ?? ''} hết hạn mức của MODEL (không phải account) — đổi model, không thử account khác`,
        });
        throw e;
      }
      if (outOfQuota) skips++;
      else tries++;
      // Ghi nhớ account lỗi để tránh pick lại trong cùng request: hết hạn mức chỉ chặn
      // đúng bể (xem bucketSkip), account hỏng hạ tầng thì chặn hẳn.
      if (outOfQuota) opts.skipKeys?.add(bucketSkip(ctx.account.key));
      else if (e?.status >= 500) opts.skipKeys?.add(ctx.account.key);
      gw({
        kind: 'err', account: ctx.account.email, model: labelModel, ms, status: e?.status,
        msg: `← ✗ ${e?.status ?? ''} ${outOfQuota ? '(hết hạn mức → đổi account)' : ''} ${String(e?.message ?? e).slice(0, 90)}`,
      });
      // Chỉ lỗi HẠ TẦNG mới nuôi circuit breaker — quota là chuyện từng account.
      // isTransientError đã bao mọi status >= 5xx lẫn lỗi mạng/timeout.
      if (!outOfQuota && isTransientError(String(e?.message ?? e), e?.status)) {
        providerBreaker.fail(provider);
        if (providerBreaker.state(provider) === 'open') {
          gw({
            kind: 'err', account: '-', model: labelModel, status: 503,
            msg: `⛔ circuit breaker ${provider} MỞ — ngừng failover, chặn tạm để upstream hồi`,
          });
          throw e; // fail-fast: không thử thêm account nào của provider đang sập
        }
      }
      if (stream && reply.raw.headersSent) throw e; // đã gửi byte → không cứu được
    } finally {
      releaseLimiter?.();
      pool.release(ctx.account);
    }
  }
  throw lastErr ?? new NoAccountError();
}

// ---------------- Health check account (token / live) ----------------
export async function testAccount(a: PoolAccount): Promise<{ alive: boolean; ms: number; detail?: string }> {
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
export async function checkLiveAccount(a: PoolAccount): Promise<{ status: 'ok' | 'quota' | 'error'; ms: number; detail?: string }> {
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
export function emitCheck(email: string, kind: 'token' | 'live', result: string, level: string, done?: number, total?: number) {
  emitLog({ runId: 0, email, flow: 'gateway', level, msg: `${kind === 'live' ? 'check live' : 'check token'}: ${result}${done ? ` (${done}/${total})` : ''}`, kind: 'check', account: email, check: { kind, result, done, total } });
}
