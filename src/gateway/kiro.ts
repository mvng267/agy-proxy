import { randomUUID } from 'node:crypto';
import type { Dispatcher } from 'undici';
import { EventStreamParser, framesToText } from './eventstream.js';
import type { ChatMessage, GenResult, ProviderModel, StreamEvent, ToolDef } from './providers/types.js';

/**
 * Bypass tool-use cho Kiro (CodeWhisperer KHÔNG có function calling native).
 * Chuyển ToolDef[] → text prompt (English, JSON Schema chuẩn), model trả về
 * <tool_call>...</tool_call> hoặc JSON object — agy-proxy parse thành tool_calls
 * structure chuẩn OpenAI/Anthropic để mọi client (Hermes, Claude CLI…) nhận được.
 */

const TOOL_SYSTEM_PREFIX = `You have access to tools. To call a tool, output ONLY a valid XML block — no other text:

<tool_call>
{"name": "TOOL_NAME", "arguments": {VALID_JSON}}
</tool_call>

Rules:
- Only emit a <tool_call> block when you actually need to invoke a tool.
- The arguments value MUST be a valid JSON object.
- If you do not need a tool, respond normally — do NOT emit <tool_call>.
- Do NOT include any text before or after the <tool_call> block when calling a tool.
- You may call multiple tools by emitting multiple <tool_call> blocks in sequence.`;

/** ToolDef[] → text đính vào system prompt (English, JSON Schema đầy đủ). */
export function toolsToPrompt(tools: ToolDef[]): string {
  if (!tools?.length) return '';
  const defs = tools.map((t) => JSON.stringify({
    name: t.name,
    description: t.description ?? '',
    parameters: t.parameters ?? { type: 'object', properties: {} },
  }, null, 2));
  return `${TOOL_SYSTEM_PREFIX}\n\nAvailable tools:\n\`\`\`json\n[\n${defs.join(',\n')}\n]\n\`\`\``;
}

/**
 * Parse text có <tool_call>...</tool_call> → ToolCall[].
 * Hỗ trợ 2 format bên trong block:
 *   1. {"name":"...", "arguments":{...}}  (preferred)
 *   2. <name>...</name><arguments>...</arguments>  (legacy XML)
 */
export function parseToolCalls(text: string): { name: string; args: Record<string, unknown>; id: string }[] {
  const calls: { name: string; args: Record<string, unknown>; id: string }[] = [];
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const block = m[1]?.trim() ?? '';
    let name = '';
    let args: Record<string, unknown> = {};

    // Format 1: JSON object {"name": "...", "arguments": {...}}
    if (block.startsWith('{')) {
      try {
        const j = JSON.parse(block) as Record<string, unknown>;
        name = String(j.name ?? '');
        const a = j.arguments ?? j.args ?? j.parameters ?? {};
        args = typeof a === 'object' && a !== null && !Array.isArray(a)
          ? (a as Record<string, unknown>)
          : { value: a };
      } catch { /* fall through to XML parse */ }
    }

    // Format 2: legacy <name>...</name><arguments>...</arguments>
    if (!name) {
      const nameM = /<name>([\s\S]*?)<\/name>/.exec(block);
      const argM = /<arguments>([\s\S]*?)<\/arguments>/.exec(block);
      if (!nameM) continue;
      name = nameM[1]?.trim() ?? '';
      if (argM?.[1]) {
        try { args = JSON.parse(argM[1].trim()); }
        catch { args = { raw: argM[1].trim() }; }
      }
    }

    if (!name) continue;
    calls.push({ name, args, id: 'call_' + randomUUID().slice(0, 8) });
  }
  return calls;
}

/**
 * Client Kiro (AWS CodeWhisperer / Amazon Q Developer).
 *
 * Giao thức ĐÃ XÁC MINH LIVE (spike 2026-07-29):
 *  - refresh : POST https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken {refreshToken}
 *              → {accessToken, refreshToken, profileArn, expiresIn: 3600}
 *  - inference: POST https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse
 *              headers: authorization Bearer, content-type application/x-amz-json-1.1,
 *                       user-agent kiro-cli, amz-sdk-invocation-id <uuid>
 *              body: {profileArn, conversationState:{chatTriggerType:'MANUAL', conversationId,
 *                     currentMessage:{userInputMessage:{content, modelId, origin:'AI_EDITOR',
 *                     userInputMessageContext:{}}}, history:[]}}
 *  - response: HTTP 200, header content-type ghi 'application/json' NHƯNG body là
 *              AWS binary event stream (frame :event-type=assistantResponseEvent,
 *              payload {"content":"…","modelId":"…"}).
 *  - hết hạn mức: HTTP 402 {"reason":"MONTHLY_REQUEST_COUNT"} — hạn mức THÁNG, không phải 429.
 *  - model sai : HTTP 400 {"reason":"INVALID_MODEL_ID"}.
 */

export const KIRO_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
export const KIRO_CW_URL = 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse';
/** Host REST của Kiro (ListAvailableModels / GetUsageLimits) — KHÁC host suy luận. */
export const KIRO_Q_URL = 'https://q.us-east-1.amazonaws.com/';

/**
 * Model Kiro — LẤY TỪ ListAvailableModels (đã kiểm chứng live 2026-07-30).
 * LƯU Ý: id dùng DẤU CHẤM (`claude-sonnet-4.5`), không phải gạch ngang.
 * `credit` = rateMultiplier: số credit tiêu cho 1 lần gọi (gói FREE có 50 credit/tháng)
 * → qwen3-coder-next chỉ 0.05 credit ⇒ ~1000 lượt; sonnet 1.3 credit ⇒ ~38 lượt.
 */
export interface KiroModel extends ProviderModel {
  credit: number;
  /** Trần ngữ cảnh — ĐO THẬT: sonnet-4 nhận 256k OK, 512k trả
   *  CONTENT_LENGTH_EXCEEDS_THRESHOLD. Rộng hơn 200k mà tài liệu công bố. */
  maxInput: number;
}
export const KIRO_MODELS: KiroModel[] = [
  { id: 'auto', label: 'Auto (Kiro tự chọn)', image: true, credit: 1, maxInput: 256_000 },
  { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', image: true, credit: 1.3, maxInput: 256_000 },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', image: true, credit: 1.3, maxInput: 256_000 },
  { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', image: true, credit: 0.4, maxInput: 256_000 },
  { id: 'deepseek-3.2', label: 'DeepSeek v3.2', image: true, credit: 0.25, maxInput: 164_000 },
  { id: 'minimax-m2.5', label: 'MiniMax M2.5', image: false, credit: 0.25, maxInput: 196_000 },
  { id: 'minimax-m2.1', label: 'MiniMax M2.1', image: true, credit: 0.15, maxInput: 196_000 },
  { id: 'glm-5', label: 'GLM 5', image: false, credit: 0.5, maxInput: 256_000 },
  { id: 'qwen3-coder-next', label: 'Qwen3 Coder Next', image: true, credit: 0.05, maxInput: 256_000 },
];

/** Bí danh cho người quen gõ gạch ngang (claude-sonnet-4-5 → claude-sonnet-4.5). */
const KIRO_ALIAS: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'deepseek-3-2': 'deepseek-3.2',
  'minimax-m2-5': 'minimax-m2.5',
  'minimax-m2-1': 'minimax-m2.1',
};

export function resolveKiroUpstream(model: string): string {
  return KIRO_ALIAS[model] ?? model;
}

export interface KiroUsage {
  used: number;
  limit: number;
  pct: number; // % CÒN LẠI
  plan: string;
  resetAt: number; // epoch ms
  daysUntilReset: number;
}

/**
 * Hạn mức THẬT của Kiro. Endpoint REST khác host suy luận:
 *   POST https://q.us-east-1.amazonaws.com/
 *   x-amz-target: AmazonCodeWhispererService.GetUsageLimits
 * KHÔNG tốn credit.
 */
export async function fetchKiroUsage(
  accessToken: string,
  profileArn?: string,
  dispatcher?: Dispatcher,
): Promise<KiroUsage | undefined> {
  const res = await fetch(KIRO_Q_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': 'AmazonCodeWhispererService.GetUsageLimits',
      'user-agent': 'aws-sdk-js/1.28.1 KiroIDE-0.7.45',
      'amz-sdk-invocation-id': randomUUID(),
    },
    body: JSON.stringify(profileArn ? { profileArn } : {}),
    signal: AbortSignal.timeout(30_000),
    ...(dispatcher ? ({ dispatcher } as any) : {}),
  });
  if (!res.ok) return undefined;
  const j = (await res.json()) as any;
  const b = j?.usageBreakdownList?.find((x: any) => x.resourceType === 'CREDIT') ?? j?.usageBreakdownList?.[0];
  if (!b) return undefined;
  const used = Number(b.currentUsage ?? 0);
  const limit = Number(b.usageLimit ?? 0);
  return {
    used,
    limit,
    pct: limit > 0 ? Math.max(0, Math.round(((limit - used) / limit) * 100)) : 0,
    plan: j?.subscriptionInfo?.subscriptionTitle ?? 'KIRO',
    resetAt: Number(j?.nextDateReset ?? 0) * 1000,
    daysUntilReset: Number(j?.daysUntilReset ?? 0),
  };
}

/** Danh sách model thật của account (dùng để đối chiếu khi Kiro đổi danh mục). */
export async function fetchKiroModels(accessToken: string, profileArn?: string, dispatcher?: Dispatcher): Promise<{ id: string; name: string; credit: number }[]> {
  const res = await fetch(KIRO_Q_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': 'AmazonCodeWhispererService.ListAvailableModels',
      'user-agent': 'aws-sdk-js/1.28.1 KiroIDE-0.7.45',
      'amz-sdk-invocation-id': randomUUID(),
    },
    body: JSON.stringify({ origin: 'AI_EDITOR', ...(profileArn ? { profileArn } : {}) }),
    signal: AbortSignal.timeout(30_000),
    ...(dispatcher ? ({ dispatcher } as any) : {}),
  });
  if (!res.ok) return [];
  const j = (await res.json()) as any;
  return (j?.models ?? []).map((m: any) => ({ id: m.modelId, name: m.modelName, credit: Number(m.rateMultiplier ?? 1) }));
}

export interface KiroCredential {
  accessToken?: string;
  refreshToken: string;
  profileArn?: string;
  region?: string;
  authMethod?: string;
  expiresAt?: string;
}

/** THUẦN: bóc credential JSON trong credentials.csv. null nếu không hợp lệ. */
export function parseKiroCredential(value: string): KiroCredential | null {
  if (!value || typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try {
    const j = JSON.parse(value) as KiroCredential;
    if (!j || typeof j.refreshToken !== 'string' || !j.refreshToken) return null;
    return j;
  } catch {
    return null;
  }
}

/** Lỗi có mang HTTP status để pool xử lý cooldown. */
export class KiroError extends Error {
  status: number;
  reason: string;
  constructor(status: number, reason: string, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export interface KiroToken {
  accessToken: string;
  refreshToken?: string;
  profileArn?: string;
  expiresAt: number; // epoch ms
}

export async function refreshKiroToken(refreshToken: string, dispatcher?: Dispatcher): Promise<KiroToken> {
  const res = await fetch(KIRO_REFRESH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'kiro-cli' },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(30_000),
    ...(dispatcher ? ({ dispatcher } as any) : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new KiroError(res.status, 'refresh_failed', `Kiro refresh ${res.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text) as { accessToken?: string; refreshToken?: string; profileArn?: string; expiresIn?: number };
  if (!j.accessToken) throw new KiroError(500, 'no_access_token', 'Kiro refresh không trả accessToken');
  return {
    accessToken: j.accessToken,
    refreshToken: j.refreshToken,
    profileArn: j.profileArn,
    expiresAt: Date.now() + (j.expiresIn ?? 3600) * 1000,
  };
}

/** Gộp content OpenAI (string | mảng block) thành text thuần. Kiro v1 không nhận ảnh. */
function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
    .map((p) => p.text ?? '')
    .join('');
}

/**
 * THUẦN: messages nội bộ → body CodeWhisperer.
 * - system gộp vào tin nhắn user ĐẦU TIÊN (Kiro không có systemInstruction).
 * - history phải XEN KẼ user/assistant; tin user cuối cùng nằm ở currentMessage.
 */
export function messagesToCodeWhisperer(
  model: string,
  messages: ChatMessage[],
  opts: { profileArn: string; conversationId?: string; tools?: ToolDef[] },
): Record<string, unknown> {
  const modelId = resolveKiroUpstream(model);
  const sys: string[] = [];
  const turns: { role: 'user' | 'assistant'; text: string }[] = [];

  for (const m of messages || []) {
    const t = textOf(m.content);
    if (m.role === 'system') {
      if (t) sys.push(t);
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += '\n' + t; // gộp cùng vai liên tiếp
    else turns.push({ role, text: t });
  }

  // gộp tool prompt (nếu có) vào system
  const toolPrompt = opts.tools?.length ? toolsToPrompt(opts.tools) : '';
  if (toolPrompt) sys.push(toolPrompt);

  // bỏ assistant đứng đầu (history phải bắt đầu bằng user)
  while (turns.length && turns[0]!.role === 'assistant') turns.shift();

  // gộp system vào tin user đầu tiên
  if (sys.length) {
    const first = turns.find((t) => t.role === 'user');
    if (first) first.text = sys.join('\n\n') + '\n\n' + first.text;
    else turns.push({ role: 'user', text: sys.join('\n\n') });
  }

  // tin user cuối → currentMessage; phần còn lại → history (cặp user/assistant)
  let lastUserIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const currentText = lastUserIdx >= 0 ? turns[lastUserIdx]!.text : '';
  const histTurns = lastUserIdx >= 0 ? turns.slice(0, lastUserIdx) : turns;

  const history: unknown[] = [];
  for (const t of histTurns) {
    if (t.role === 'user') {
      history.push({ userInputMessage: { content: t.text, modelId, origin: 'AI_EDITOR' } });
    } else {
      history.push({ assistantResponseMessage: { content: t.text } });
    }
  }

  return {
    profileArn: opts.profileArn,
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: opts.conversationId ?? randomUUID(),
      currentMessage: {
        userInputMessage: {
          content: currentText || 'hi',
          modelId,
          origin: 'AI_EDITOR',
          userInputMessageContext: {},
        },
      },
      history,
    },
  };
}

/** Ước lượng token (CodeWhisperer không trả usage). */
export function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil((s || '').length / 4));
}

async function callKiro(
  session: { accessToken: string; profileArn?: string },
  model: string,
  messages: ChatMessage[],
  dispatcher?: Dispatcher,
  signal?: AbortSignal,
  tools?: ToolDef[],
): Promise<Response> {
  const body = messagesToCodeWhisperer(model, messages, { profileArn: session.profileArn ?? '', tools });
  const res = await fetch(KIRO_CW_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': 'application/x-amz-json-1.1',
      'user-agent': 'kiro-cli',
      'amz-sdk-invocation-id': randomUUID(),
    },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(180_000),
    ...(dispatcher ? ({ dispatcher } as any) : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    let reason = '';
    let message = text.slice(0, 200);
    try {
      const j = JSON.parse(text);
      reason = j.reason ?? '';
      message = j.message ?? message;
    } catch {
      /* body không phải JSON */
    }
    // 402 MONTHLY_REQUEST_COUNT = hết hạn mức tháng → coi như quota (cooldown dài)
    throw new KiroError(res.status, reason, `Kiro ${res.status} ${reason}: ${message}`);
  }
  return res;
}

export async function kiroGenerate(args: {
  session: { accessToken: string; profileArn?: string };
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
}): Promise<GenResult> {
  const res = await callKiro(args.session, args.model, args.messages, args.dispatcher, args.signal, args.tools);
  const buf = new Uint8Array(await res.arrayBuffer());
  const parser = new EventStreamParser();
  const text = framesToText(parser.push(buf));
  const promptChars = (args.messages || []).map((m) => textOf(m.content)).join('').length;
  // Parse tool_calls nếu có (bypass mode)
  const toolCalls = args.tools?.length ? parseToolCalls(text) : [];
  const cleanText = toolCalls.length ? text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim() : text;
  return {
    text: cleanText,
    images: [],
    toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, input: c.args })),
    usage: {
      promptTokens: estimateTokens('x'.repeat(promptChars)),
      completionTokens: estimateTokens(text),
      totalTokens: estimateTokens('x'.repeat(promptChars)) + estimateTokens(text),
    },
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    model: args.model,
  };
}

export async function* kiroGenerateStream(args: {
  session: { accessToken: string; profileArn?: string };
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const res = await callKiro(args.session, args.model, args.messages, args.dispatcher, args.signal, args.tools);
  const parser = new EventStreamParser();
  const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
  let out = '';
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const t = framesToText(parser.push(value));
      if (t) {
        out += t;
        yield { delta: t };
      }
    }
  }
  const promptChars = (args.messages || []).map((m) => textOf(m.content)).join('').length;
  const pt = estimateTokens('x'.repeat(promptChars));
  const ct = estimateTokens(out);
  // Parse tool_calls ở cuối stream (nếu có)
  const toolCalls = args.tools?.length ? parseToolCalls(out) : [];
  if (toolCalls.length) {
    for (const c of toolCalls) yield { toolCall: { id: c.id, name: c.name, input: c.args } };
  }
  yield { usage: { promptTokens: pt, completionTokens: ct, totalTokens: pt + ct }, done: true };
}
