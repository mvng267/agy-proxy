import { randomUUID } from 'node:crypto';
import { ProxyAgent, type Dispatcher } from 'undici';

/**
 * Antigravity API client — gọi thẳng cloudcode-pa generateContent như Antigravity IDE.
 * Port công thức từ AIClient2API/antigravity-core.js (đã kiểm chứng qua research):
 * body { model, userAgent, requestType, project, requestId, request:{ contents, systemInstruction?, sessionId, generationConfig } }.
 * Không phụ thuộc store — thao tác thuần trên access_token + project để dễ unit-test.
 */

import { AGY_TOKEN_URL as TOKEN_URL, AGY_CLIENT_ID as CLIENT_ID, AGY_CLIENT_SECRET as CLIENT_SECRET } from '../config.js';
const UA = 'antigravity/1.104.0 darwin/arm64'; // generateContent (data-plane)
// Control-plane (loadCodeAssist/onboardUser): node UA làm account đủ điều kiện free-tier
// → Google tự cấp project managed thật (đã kiểm chứng: onboard free-tier trả project chạy được).
const CONTROL_UA = 'antigravity/1.104.0 google-api-nodejs-client/10.3.0';
const GOOG_API_CLIENT = 'gl-node/22.21.1';
const API_VERSION = 'v1internal';

/**
 * Rút thời gian chờ Google yêu cầu từ 429/5xx.
 * Nguồn: header `Retry-After`, hoặc `RetryInfo.retryDelay` trong body ("34s", "1m30s").
 * Antigravity thường KHÔNG gửi Retry-After → trả undefined, nơi gọi tự cooldown mặc định.
 */
export function parseRetryAfterMs(headerVal: string | null, body: string): number | undefined {
  const raw = (headerVal || body.match(/"retryDelay"\s*:\s*"([^"]+)"/)?.[1] || '').trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000; // Retry-After dạng số giây
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/.exec(raw);
  if (!m || !(m[1] || m[2] || m[3])) return undefined;
  return (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** Base host thử lần lượt khi lỗi mạng/429. */
export const BASE_HOSTS = [
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
];

// ---------- types ----------
export interface TokenInfo {
  accessToken: string;
  expiresAt: number; // epoch ms
}
/**
 * Bể hạn mức. Antigravity chia quota làm 2 bể ĐỘC LẬP (đã đo thật trên account EDU:
 * cùng lúc Gemini 73% mà Claude 97% → tiêu bên này không ăn bên kia), khớp đúng 2 nhóm
 * upstream trả về trong retrieveUserQuotaSummary: "Gemini Models" và "Claude and GPT models".
 *
 * LƯU Ý: phân bể theo DỮ LIỆU QUOTA THẬT, không suy từ tên model — `gpt-oss-120b-medium`
 * không phải model Claude nhưng dùng chung bể với Claude.
 * Kiểm lại khi Google đổi cách chia: gọi fetchQuota rồi so `pct` + `resetTime` từng model.
 */
export type QuotaBucket = 'gemini' | 'claude';

export interface ModelInfo {
  id: string;
  label: string;
  image: boolean;
  /** Bể hạn mức của model. Không đặt = provider không chia bể (Kiro). */
  bucket?: QuotaBucket;
  /**
   * Trần ngữ cảnh (token) — ĐO THẬT qua gateway, không lấy theo tài liệu:
   * Gemini nhận 384k OK / đứt trước 448k; claude-* qua Antigravity nhận tới 768k OK
   * (rộng hơn hẳn 200k của Anthropic gốc — upstream Vertex nới trần).
   * Lấy mốc an toàn thấp hơn điểm đứt để gợi ý model thay thế cho chuẩn.
   */
  maxInput?: number;
}
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
/**
 * 1 lần model gọi tool. `id`: Gemini 3 CÓ trả id riêng, nhưng không phải lúc nào cũng có
 * → thiếu thì gateway tự sinh (Anthropic bắt buộc phải có id).
 *
 * `signature` = thoughtSignature của Gemini 3, nằm ở cấp PART (ngang hàng functionCall).
 * BẮT BUỘC gửi lại nguyên văn ở lượt sau, nếu không upstream trả 400
 * "Function call is missing a thought_signature" → hỏng ngay vòng 2 của tool-use.
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  signature?: string;
}
/** Khai báo tool gửi lên model (JSON Schema — dạng chung của Anthropic/OpenAI/Gemini). */
export interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}
export interface GenResult {
  text: string;
  images: string[]; // data URL (base64) cho model ảnh
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: string;
  model: string;
}
export type OAContent =
  | string
  | Array<{ type: string; text?: string; image_url?: { url: string } }>;
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content: OAContent;
  /** role assistant: model đã gọi tool ở lượt này. */
  toolCalls?: ToolCall[];
  /** role tool: kết quả trả về cho toolCallId tương ứng. */
  toolCallId?: string;
  toolName?: string;
}
export interface CallOpts {
  accessToken: string;
  projectId: string;
  model: string;
  messages: ChatMessage[];
  generationConfig?: Record<string, unknown>;
  tools?: ToolDef[];
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
}

/**
 * Model client-facing. `upstream` = tên gửi lên cloudcode-pa (khác khi cần map).
 * Đã kiểm chứng live trên account free-tier EDU: các model dưới đều trả kết quả.
 * gemini-3-pro-high/low native trả 500 trên free-tier → map sang gemini-pro-agent
 * (model "pro" tier chạy được, giống cách Antigravity Manager/AIClient2API xử lý).
 */
export const MODELS: ModelInfo[] = [
  // --- danh sách gốc (giữ nguyên id để không phá cấu hình/combo đã có) ---
  { id: 'gemini-3-pro-high', label: 'Gemini 3 Pro (High)', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3-pro-low', label: 'Gemini 3 Pro (Low)', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (Preview)', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image 🖼', image: true, bucket: 'gemini' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', image: false, maxInput: 768_000, bucket: 'claude' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', image: false, maxInput: 768_000, bucket: 'claude' },
  // --- bổ sung từ danh mục Antigravity CLI (ListModels của OmniRoute) ---
  // Antigravity IDE và Antigravity CLI dùng CHUNG upstream cloudcode-pa và CHUNG
  // 15 model, chỉ khác đường đăng nhập → gọi thẳng bằng account agy/ sẵn có.
  // Đã gọi thử live: tất cả trả kết quả (trừ gpt-oss-120b-medium hết hạn mức account thử).
  { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3.6-flash-low', label: 'Gemini 3.6 Flash (Low)', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3.5-flash-high', label: 'Gemini 3.5 Flash (High)', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3.5-flash-extra-low', label: 'Gemini 3.5 Flash (Low)', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-2.5-flash-thinking', label: 'Gemini 2.5 Flash Thinking', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', image: false, maxInput: 384_000, bucket: 'gemini' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', image: false, maxInput: 128_000, bucket: 'claude' },
];

/** Map model client → tên upstream cloudcode-pa (chỉ khi khác). */
const CLIENT_TO_UPSTREAM: Record<string, string> = {
  'gemini-3-pro-high': 'gemini-pro-agent',
  'gemini-3-pro-low': 'gemini-pro-agent',
  'gemini-3.1-pro-high': 'gemini-pro-agent',
  'gemini-3.1-pro-preview': 'gemini-pro-agent',
  // Antigravity CLI gọi "Gemini 3.5 Flash (High)" bằng upstream gemini-3-flash-agent
  // (đã gọi thử live OK). Trước đây map nhầm sang gemini-3.5-flash-low = bản Medium.
  'gemini-3.5-flash-high': 'gemini-3-flash-agent',
};

export function resolveUpstreamModel(model: string): string {
  return CLIENT_TO_UPSTREAM[model] || model;
}

export function isImageModel(model: string): boolean {
  return !!model && model.toLowerCase().includes('image');
}

/** Tạo ProxyAgent từ URL proxy (http://user:pass@host:port). '' | undefined → undefined (direct). */
export function proxyDispatcher(url?: string): Dispatcher | undefined {
  if (!url) return undefined;
  try {
    return new ProxyAgent(url);
  } catch {
    return undefined;
  }
}

// ---------- auth ----------
/** refresh_token → access_token (đọc JSON access_token + expires_in). MẢNH CÒN THIẾU trước đây. */
export async function refreshAccessToken(
  refreshToken: string,
  dispatcher?: Dispatcher,
): Promise<TokenInfo> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept-encoding': 'identity' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(20000),
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`refresh token failed (${res.status}): ${raw.slice(0, 200)}`);
  }
  const j = JSON.parse(raw) as { access_token: string; expires_in?: number };
  if (!j.access_token) throw new Error('refresh: no access_token in response');
  return { accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
}

interface ApiOpts {
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
  control?: boolean; // dùng node UA + x-goog-api-client cho loadCodeAssist/onboardUser
}

async function apiCall(accessToken: string, method: string, body: unknown, o: ApiOpts = {}): Promise<any> {
  const { dispatcher, signal, control } = o;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'accept-encoding': 'identity',
    authorization: `Bearer ${accessToken}`,
    'user-agent': control ? CONTROL_UA : UA,
  };
  if (control) headers['x-goog-api-client'] = GOOG_API_CLIENT;
  let lastErr: unknown;
  for (const host of BASE_HOSTS) {
    try {
      const res = await fetch(`${host}/${API_VERSION}:${method}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(60000),
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`${method} ${res.status}: ${text.slice(0, 300)}`) as Error & {
          status?: number; retryAfterMs?: number;
        };
        err.status = res.status;
        err.retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), text);
        // 429/5xx → thử host kế; 4xx khác → ném ngay
        if (res.status === 429 || res.status >= 500) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      return text ? JSON.parse(text) : {};
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function onboardTier(
  accessToken: string,
  tier: string,
  dispatcher?: Dispatcher,
  signal?: AbortSignal,
): Promise<string | null> {
  const onboardReq = {
    tier_id: tier,
    metadata: { ide_type: 'ANTIGRAVITY', ide_name: 'antigravity', ide_version: '1.104.0' },
  };
  let lro = await apiCall(accessToken, 'onboardUser', onboardReq, { dispatcher, signal, control: true });
  for (let i = 0; i < 15 && !lro?.done; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    lro = await apiCall(accessToken, 'onboardUser', onboardReq, { dispatcher, signal, control: true });
  }
  const pid = lro?.response?.cloudaicompanionProject?.id ?? lro?.response?.cloudaicompanionProject;
  return typeof pid === 'string' && pid ? pid : null;
}

/**
 * Lấy project managed thật cho account. RECIPE ĐÃ KIỂM CHỨNG:
 * loadCodeAssist (node UA) → nếu chưa có project thì onboardUser tier "free-tier"
 * (node UA làm account EDU đủ điều kiện free-tier) → Google tự cấp project chạy được.
 * Fallback standard-tier. Không dùng project random (bị CONSUMER_INVALID).
 */
export async function discoverProject(
  accessToken: string,
  dispatcher?: Dispatcher,
  signal?: AbortSignal,
): Promise<string> {
  const load = await apiCall(
    accessToken,
    'loadCodeAssist',
    { metadata: { ideType: 'ANTIGRAVITY' } },
    { dispatcher, signal, control: true },
  );
  if (load?.cloudaicompanionProject) return String(load.cloudaicompanionProject);

  for (const tier of ['free-tier', 'standard-tier']) {
    const pid = await onboardTier(accessToken, tier, dispatcher, signal);
    if (pid) return pid;
  }
  throw new Error('Không cấp được project cho account (onboard free-tier/standard-tier đều không trả project)');
}

// ---------- convert OpenAI → Antigravity ----------
type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

function dataUrlToInline(url: string): GeminiPart | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url);
  if (!m) return null;
  return { inlineData: { mimeType: m[1] ?? 'image/png', data: m[2] ?? '' } };
}

function contentToParts(content: OAContent): GeminiPart[] {
  if (typeof content === 'string') return [{ text: content }];
  const parts: GeminiPart[] = [];
  for (const p of content) {
    if (p.type === 'text' && p.text != null) parts.push({ text: p.text });
    else if (p.type === 'image_url' && p.image_url?.url) {
      const inline = dataUrlToInline(p.image_url.url);
      if (inline) parts.push(inline);
    }
  }
  return parts.length ? parts : [{ text: '' }];
}

/**
 * JSON Schema → schema Gemini chấp nhận. Gemini v1internal từ chối các khoá phụ của
 * JSON Schema ($schema, additionalProperties…) → lọc trắng, giữ đúng phần nó hiểu.
 */
export function toGeminiSchema(s: unknown): Record<string, unknown> | undefined {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
  const src = s as Record<string, any>;
  const out: Record<string, unknown> = {};
  if (typeof src.type === 'string') out.type = src.type.toUpperCase();
  if (typeof src.description === 'string') out.description = src.description;
  if (Array.isArray(src.enum)) out.enum = src.enum.map(String);
  if (Array.isArray(src.required) && src.required.length) out.required = src.required.map(String);
  if (src.properties && typeof src.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src.properties as Record<string, unknown>)) {
      const sub = toGeminiSchema(v);
      if (sub) props[k] = sub;
    }
    if (Object.keys(props).length) out.properties = props;
  }
  if (src.items) {
    const it = toGeminiSchema(src.items);
    if (it) out.items = it;
  }
  // Không có type mà có properties → mặc định OBJECT (Claude Code hay bỏ trống).
  if (!out.type && out.properties) out.type = 'OBJECT';
  return Object.keys(out).length ? out : undefined;
}

/** ToolDef[] → tools.functionDeclarations của Gemini. */
export function toolsToGemini(tools?: ToolDef[]): Array<{ functionDeclarations: unknown[] }> | undefined {
  const decls = (tools ?? [])
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => {
      const d: Record<string, unknown> = { name: t.name };
      if (t.description) d.description = t.description;
      const params = toGeminiSchema(t.parameters);
      // Gemini đòi OBJECT rỗng chứ không nhận thiếu parameters với tool không tham số.
      d.parameters = params ?? { type: 'OBJECT', properties: {} };
      return d;
    });
  return decls.length ? [{ functionDeclarations: decls }] : undefined;
}

/** OpenAI messages → body Antigravity generateContent. */
export function openaiToAntigravity(
  model: string,
  messages: ChatMessage[],
  opts: { projectId: string; generationConfig?: Record<string, unknown>; tools?: ToolDef[] },
): Record<string, unknown> {
  const isImg = isImageModel(model);
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  let systemInstruction: { parts: GeminiPart[] } | undefined;

  for (const m of messages) {
    if (m.role === 'system') {
      const parts = contentToParts(m.content);
      systemInstruction = systemInstruction
        ? { parts: [...systemInstruction.parts, ...parts] }
        : { parts };
      continue;
    }
    // Kết quả tool → functionResponse (role user theo quy ước Gemini).
    if (m.role === 'tool') {
      const text = typeof m.content === 'string'
        ? m.content
        : contentToParts(m.content).map((p) => ('text' in p ? p.text : '')).join('');
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: m.toolName || m.toolCallId || 'tool',
            // Upstream Anthropic khớp theo id; Gemini khớp theo tên. Gửi cả hai.
            ...(m.toolCallId ? { id: m.toolCallId } : {}),
            response: { result: text },
          },
        }],
      });
      continue;
    }
    const parts = m.role === 'assistant' && m.toolCalls?.length ? [] : contentToParts(m.content);
    // Lượt assistant có tool_use → kèm functionCall để model thấy lại việc nó đã gọi.
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const txt = typeof m.content === 'string' ? m.content : '';
      if (txt) parts.push({ text: txt });
      for (const c of m.toolCalls) {
        // thoughtSignature nằm CÙNG CẤP với functionCall (không lồng bên trong).
        // Thiếu nó → Gemini 3 trả 400 "Function call is missing a thought_signature".
        // `id` phải gửi lại nguyên văn: model Claude qua Antigravity (upstream Anthropic)
        // bắt buộc có, thiếu thì 400 "tool_use.id: Field required". Gemini bỏ qua id lạ
        // nên gửi kèm là an toàn cho cả hai.
        parts.push({
          ...(c.signature ? { thoughtSignature: c.signature } : {}),
          functionCall: { name: c.name, args: c.input ?? {}, ...(c.id ? { id: c.id } : {}) },
        });
      }
    }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: parts.length ? parts : [{ text: '' }] });
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '' }] });

  const request: Record<string, unknown> = {
    contents,
    sessionId: randomUUID(),
  };
  if (systemInstruction) request.systemInstruction = systemInstruction;
  if (opts.generationConfig && Object.keys(opts.generationConfig).length) {
    request.generationConfig = opts.generationConfig;
  }
  // Model ảnh không có function calling → bỏ qua tools.
  const gtools = isImg ? undefined : toolsToGemini(opts.tools);
  if (gtools) request.tools = gtools;

  return {
    model: resolveUpstreamModel(model),
    userAgent: 'antigravity',
    requestType: isImg ? 'image_gen' : 'agent',
    project: opts.projectId,
    requestId: isImg ? `image_gen/1/${randomUUID()}/12` : `agent-${randomUUID()}`,
    request,
  };
}

// ---------- convert Antigravity → kết quả ----------
function extractNode(data: any): any {
  return data?.response ?? data;
}

function partsOf(node: any): any[] {
  return node?.candidates?.[0]?.content?.parts ?? [];
}

/** Gemini KHÔNG trả id cho functionCall, Anthropic thì bắt buộc → gateway tự sinh. */
export function newToolCallId(): string {
  return 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 24);
}

/** Bóc 1 part functionCall → ToolCall (dùng chung cho non-stream và stream). */
function toolCallOfPart(p: any): ToolCall {
  const sig = p?.thoughtSignature ?? p?.thought_signature;
  return {
    // Gemini 3 có trả id riêng; thiếu thì tự sinh (Anthropic bắt buộc có id).
    id: String(p.functionCall.id || '') || newToolCallId(),
    name: String(p.functionCall.name),
    input: (p.functionCall.args ?? {}) as Record<string, unknown>,
    ...(typeof sig === 'string' && sig ? { signature: sig } : {}),
  };
}

function collect(node: any, into: { text: string; images: string[]; toolCalls: ToolCall[] }): void {
  for (const p of partsOf(node)) {
    if (p?.functionCall?.name) {
      into.toolCalls.push(toolCallOfPart(p));
    } else if (typeof p?.text === 'string') into.text += p.text;
    else if (p?.inlineData?.data) {
      const mime = p.inlineData.mimeType || 'image/png';
      into.images.push(`data:${mime};base64,${p.inlineData.data}`);
    }
  }
}

function usageOf(node: any): Usage {
  const u = node?.usageMetadata ?? {};
  const prompt = u.promptTokenCount ?? 0;
  const completion = u.candidatesTokenCount ?? 0;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: u.totalTokenCount ?? prompt + completion };
}

/** Response non-stream (đã JSON) → GenResult. */
export function antigravityToResult(data: any, model: string): GenResult {
  const node = extractNode(data);
  const acc = { text: '', images: [] as string[], toolCalls: [] as ToolCall[] };
  collect(node, acc);
  const finish = node?.candidates?.[0]?.finishReason ?? 'stop';
  return {
    text: acc.text,
    images: acc.images,
    toolCalls: acc.toolCalls,
    usage: usageOf(node),
    // Có tool call → phải báo tool_use, kể cả khi upstream ghi STOP.
    finishReason: acc.toolCalls.length ? 'tool_use' : finish,
    model,
  };
}

// ---------- gọi model ----------
/** Non-stream: gọi generateContent, trả GenResult. */
export async function generate(opts: CallOpts): Promise<GenResult> {
  const body = openaiToAntigravity(opts.model, opts.messages, {
    projectId: opts.projectId,
    generationConfig: opts.generationConfig,
    tools: opts.tools,
  });
  const data = await apiCall(opts.accessToken, 'generateContent', body, {
    dispatcher: opts.dispatcher,
    signal: opts.signal,
  });
  return antigravityToResult(data, opts.model);
}

/** Stream: async generator phát text delta (+ usage cuối). */
export async function* generateStream(
  opts: CallOpts,
): AsyncGenerator<{ delta?: string; image?: string; toolCall?: ToolCall; usage?: Usage; done?: boolean }> {
  const body = openaiToAntigravity(opts.model, opts.messages, {
    projectId: opts.projectId,
    generationConfig: opts.generationConfig,
    tools: opts.tools,
  });
  let res: Response | null = null;
  let lastErr: unknown;
  for (const host of BASE_HOSTS) {
    try {
      res = await fetch(`${host}/${API_VERSION}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'accept-encoding': 'identity',
          'user-agent': UA,
          authorization: `Bearer ${opts.accessToken}`,
        },
        body: JSON.stringify(body),
        // Không có timeout thì stream hỏng giữa chừng sẽ treo request vĩnh viễn
        // (routes.ts không tạo AbortController nên opts.signal thường undefined).
        // Rộng hơn non-stream vì stream dài hơi là bình thường.
        signal: opts.signal ?? AbortSignal.timeout(300_000),
        ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
      } as RequestInit);
      if (res.ok && res.body) break;
      if (res.status === 429 || res.status >= 500) {
        // PHẢI gắn status: pool đọc e.status để biết account hết hạn mức mà cooldown
        // + đổi account. Thiếu nó thì stream 429 chỉ báo lỗi thẳng cho client, trong
        // khi non-stream cùng tình huống lại xoay account bình thường.
        //
        // Đọc body: trước đây vứt hết nên log chỉ có "stream 429", không phân biệt được
        // hết hạn mức NGÀY với chặn tốc độ THEO PHÚT (hai thứ khác hẳn nhau về cách xử lý).
        // Google trả RESOURCE_EXHAUSTED kèm quotaId/quotaMetric trong body; riêng
        // Antigravity thường KHÔNG có header Retry-After nên vẫn phải tự cooldown.
        const raw = await res.text().catch(() => '');
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), raw);
        const quotaId = raw.match(/"quotaId"\s*:\s*"([^"]+)"/)?.[1] ?? '';
        const detail = [quotaId, retryAfterMs && `retry sau ${Math.round(retryAfterMs / 1000)}s`]
          .filter(Boolean).join(' · ');
        const e = new Error(`stream ${res.status}${detail ? ` (${detail})` : ''}`) as Error & {
          status?: number; retryAfterMs?: number; quotaId?: string;
        };
        e.status = res.status;
        e.quotaId = quotaId || undefined;
        e.retryAfterMs = retryAfterMs;
        lastErr = e;
        res = null;
        continue;
      }
      const t = await res.text().catch(() => '');
      const e = new Error(`stream ${res.status}: ${t.slice(0, 200)}`) as Error & { status?: number };
      e.status = res.status;
      throw e;
    } catch (e) {
      lastErr = e;
      res = null;
    }
  }
  if (!res || !res.body) throw lastErr instanceof Error ? lastErr : new Error('stream failed');

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let usage: Usage | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let data: any;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      const node = extractNode(data);
      for (const p of partsOf(node)) {
        // functionCall đến nguyên khối trong 1 chunk (Gemini không cắt nhỏ args).
        if (p?.functionCall?.name) {
          yield { toolCall: toolCallOfPart(p) };
        } else if (typeof p?.text === 'string' && p.text) yield { delta: p.text };
        else if (p?.inlineData?.data) {
          const mime = p.inlineData.mimeType || 'image/png';
          yield { image: `data:${mime};base64,${p.inlineData.data}` };
        }
      }
      if (node?.usageMetadata) usage = usageOf(node);
    }
  }
  yield { usage, done: true };
}

// ---------- models & credits (best-effort) ----------
export async function fetchModels(
  accessToken: string,
  projectId: string,
  dispatcher?: Dispatcher,
): Promise<ModelInfo[]> {
  try {
    const data = await apiCall(accessToken, 'listModels', { project: projectId }, { dispatcher, control: true });
    const raw: any[] = data?.models ?? [];
    const list = raw
      .map((m) => {
        const id = m.name || m.id || m.model;
        if (!id) return null;
        return { id: String(id), label: m.displayName || String(id), image: isImageModel(String(id)) };
      })
      .filter(Boolean) as ModelInfo[];
    return list.length ? list : MODELS;
  } catch {
    return MODELS;
  }
}

// ---------- hạn mức (retrieveUserQuotaSummary + fetchAvailableModels) ----------
export interface QuotaBucketInfo {
  name: string; // 'Gemini Models' | 'Claude and GPT models'
  pct: number; // 0-100 remaining (window weekly)
  resetTime: string;
  desc?: string;
}
export interface QuotaModelInfo {
  id: string; // tên upstream (map ngược sang client khi hiển thị)
  pct: number;
  resetTime: string;
}
export interface QuotaInfo {
  tier: string | null; // FREE/PRO/ULTRA hoặc tier id
  groups: QuotaBucketInfo[]; // 2 nhóm
  models: QuotaModelInfo[]; // per-model
  fetchedAt: number;
}

function pctOf(fraction: unknown): number {
  const f = typeof fraction === 'number' ? fraction : 0;
  return Math.max(0, Math.min(100, Math.round(f * 100)));
}

/** Parse thuần (test được): retrieveUserQuotaSummary + fetchAvailableModels + loadCodeAssist → QuotaInfo. */
export function buildQuotaInfo(summary: any, models: any, load: any, now = Date.now()): QuotaInfo {
  const out: QuotaInfo = { tier: null, groups: [], models: [], fetchedAt: now };
  for (const g of summary?.groups ?? []) {
    const buckets: any[] = g.buckets ?? [];
    const b = buckets.find((x) => x.window === 'weekly') ?? buckets[0];
    if (!b) continue;
    out.groups.push({ name: g.displayName || 'Nhóm', pct: pctOf(b.remainingFraction), resetTime: b.resetTime || '', desc: b.description || g.description });
  }
  for (const [id, info] of Object.entries<any>(models?.models ?? {})) {
    const qi = info?.quotaInfo;
    if (!qi) continue;
    out.models.push({ id, pct: pctOf(qi.remainingFraction), resetTime: qi.resetTime || '' });
  }
  const def = (load?.allowedTiers ?? []).find((t: any) => t.isDefault) ?? load?.currentTier;
  out.tier = load?.paidTier?.name || def?.id || null;
  return out;
}

/** Lấy hạn mức đầy đủ như Antigravity gửi về: nhóm (weekly) + per-model. */
export async function fetchQuota(
  accessToken: string,
  projectId: string,
  dispatcher?: Dispatcher,
): Promise<QuotaInfo> {
  const safe = async (method: string, body: unknown) => {
    try {
      return await apiCall(accessToken, method, body, { dispatcher, control: true });
    } catch {
      return null;
    }
  };
  const [summary, models, load] = await Promise.all([
    safe('retrieveUserQuotaSummary', { project: projectId }),
    safe('fetchAvailableModels', { project: projectId }),
    safe('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }),
  ]);
  return buildQuotaInfo(summary, models, load);
}

/** Check live từng model: gọi prompt cực ngắn, map trạng thái ok/quota/error. */
export async function checkModelsLive(
  accessToken: string,
  projectId: string,
  dispatcher?: Dispatcher,
): Promise<{ id: string; status: 'ok' | 'quota' | 'error'; ms: number; detail?: string }[]> {
  const out: { id: string; status: 'ok' | 'quota' | 'error'; ms: number; detail?: string }[] = [];
  for (const m of MODELS) {
    const t0 = Date.now();
    try {
      const r = await generate({
        accessToken,
        projectId,
        model: m.id,
        messages: [{ role: 'user', content: 'hi' }],
        dispatcher,
        generationConfig: { maxOutputTokens: m.image ? undefined : 8 },
      });
      out.push({ id: m.id, status: m.image ? (r.images.length ? 'ok' : 'ok') : 'ok', ms: Date.now() - t0 });
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const quota = e?.status === 429 || /quota|exhaust|resource_exhausted/i.test(msg);
      out.push({ id: m.id, status: quota ? 'quota' : 'error', ms: Date.now() - t0, detail: msg.slice(0, 120) });
    }
  }
  return out;
}
