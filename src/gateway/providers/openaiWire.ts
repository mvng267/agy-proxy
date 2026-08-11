import type { Dispatcher } from 'undici';
import type {
  ChatMessage, GenArgs, GenResult, LiveResult, Provider, ProviderSession, StreamEvent, ToolCall, ToolDef,
} from './types.js';

/**
 * Wire-format OpenAI `/chat/completions` — phần DÙNG CHUNG cho mọi upstream nói chuẩn này.
 *
 * Tách ra từ `openrouter.ts` khi thêm provider Nous: hai upstream khác nhau HOÀN TOÀN ở
 * khâu xác thực (OpenRouter dùng API key sống mãi, Nous dùng JWT hết hạn sau 1 giờ) nhưng
 * giống hệt nhau ở khâu gửi/nhận. Chép lại 200 dòng parse SSE cho mỗi provider mới là cách
 * chắc chắn để hai bản lệch nhau dần — sửa bug ở một bên, quên bên kia.
 *
 * Provider nào cũng chỉ cần cài phần auth của mình rồi gọi các hàm ở đây.
 */

/** ChatMessage nội bộ → message OpenAI wire-format (nội bộ vốn đã gần OpenAI). */
export function toOpenAIWire(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        // OpenAI cấm content:"" đi kèm tool_calls ở vài upstream nghiêm → null cho chắc
        content: typeof m.content === 'string' && m.content ? m.content : null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function wireTools(tools?: ToolDef[]): Record<string, unknown>[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** {maxOutputTokens,temperature,topP} (khoá kiểu Gemini, engine dựng sẵn) → khoá OpenAI. */
export function wireGenConfig(g?: Record<string, unknown>): Record<string, unknown> {
  if (!g) return {};
  const out: Record<string, unknown> = {};
  if (typeof g.maxOutputTokens === 'number') out.max_tokens = g.maxOutputTokens;
  if (typeof g.temperature === 'number') out.temperature = g.temperature;
  if (typeof g.topP === 'number') out.top_p = g.topP;
  return out;
}

export function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  const sec = Number(h);
  return h && Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
}

/** tool_calls wire → ToolCall nội bộ (arguments là chuỗi JSON, hỏng thì {}). */
export function parseToolCalls(raw: any[] | undefined): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t, i) => {
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(t?.function?.arguments || '{}'); } catch { /* giữ {} */ }
    return { id: t?.id || `call_${i}`, name: t?.function?.name ?? '', input };
  });
}

/**
 * Gọi `/chat/completions`.
 *
 * `label` chỉ để ghép vào thông điệp lỗi ('openrouter 429: …' / 'nous 429: …') — nhìn log
 * là biết upstream nào hỏng. `onResponse` để provider bóc thêm gì đó từ header (Nous trả
 * hạn mức ở `x-ratelimit-*` ngay trên response gọi model, không có API riêng để hỏi).
 */
export async function callOpenAI(
  s: ProviderSession,
  body: Record<string, unknown>,
  o: {
    label: string;
    defaultBaseUrl: string;
    dispatcher?: Dispatcher;
    signal?: AbortSignal;
    onResponse?: (res: Response) => void;
  },
): Promise<Response> {
  const base = s.baseUrl || o.defaultBaseUrl;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${s.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: o.signal ?? AbortSignal.timeout(120_000),
    ...(o.dispatcher ? ({ dispatcher: o.dispatcher } as any) : {}),
  });
  // Gọi CẢ khi lỗi: header hạn mức vẫn có mặt trên response 429, và đó chính là lúc số
  // liệu đáng giá nhất.
  o.onResponse?.(res);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`${o.label} ${res.status}: ${text.slice(0, 200)}`),
      { status: res.status, retryAfterMs: retryAfterMs(res) },
    );
  }
  return res;
}

/** Gọi thử 1 request cực nhỏ vào 1 model — checkLive và checkModelsLive dùng chung. */
export async function probeModel(p: Provider, s: ProviderSession, model: string, d?: Dispatcher): Promise<LiveResult> {
  const t0 = Date.now();
  try {
    const r = await p.generate({
      session: s,
      model,
      messages: [{ role: 'user', content: 'hi' }],
      generationConfig: { maxOutputTokens: 8 },
      dispatcher: d,
    });
    return { status: 'ok', ms: Date.now() - t0, detail: (r.text || '').slice(0, 40) };
  } catch (e: any) {
    const quota = e?.status === 402 || e?.status === 429;
    return { status: quota ? 'quota' : 'error', ms: Date.now() - t0, detail: String(e?.message ?? e).slice(0, 120) };
  }
}

type CallOpts = Omit<Parameters<typeof callOpenAI>[2], 'signal' | 'dispatcher'>;

/** Non-stream: gọi rồi bóc `choices[0].message`. */
export async function generateOpenAI(args: GenArgs, o: CallOpts): Promise<GenResult> {
  const tools = wireTools(args.tools);
  const res = await callOpenAI(args.session, {
    model: args.model,
    messages: toOpenAIWire(args.messages),
    ...(tools ? { tools } : {}),
    ...wireGenConfig(args.generationConfig),
  }, { ...o, dispatcher: args.dispatcher, signal: args.signal });
  const j: any = await res.json();
  const msg = j?.choices?.[0]?.message ?? {};
  return {
    text: typeof msg.content === 'string' ? msg.content : '',
    images: [],
    toolCalls: parseToolCalls(msg.tool_calls),
    usage: {
      promptTokens: j?.usage?.prompt_tokens ?? 0,
      completionTokens: j?.usage?.completion_tokens ?? 0,
      totalTokens: j?.usage?.total_tokens ?? 0,
    },
    finishReason: j?.choices?.[0]?.finish_reason ?? 'stop',
    model: j?.model ?? args.model,
  };
}

/** Stream SSE: gom tool_calls rời rạc theo index rồi mới phát. */
export async function* streamOpenAI(args: GenArgs, o: CallOpts): AsyncGenerator<StreamEvent> {
  const tools = wireTools(args.tools);
  const res = await callOpenAI(args.session, {
    model: args.model,
    messages: toOpenAIWire(args.messages),
    stream: true,
    // usage nằm ở chunk cuối — không xin thì upstream OpenAI-compatible không gửi
    stream_options: { include_usage: true },
    ...(tools ? { tools } : {}),
    ...wireGenConfig(args.generationConfig),
  }, { ...o, dispatcher: args.dispatcher, signal: args.signal });

  if (!res.body) throw Object.assign(new Error(`${o.label}: stream không có body`), { status: 502 });

  // tool_calls stream RỜI RẠC theo index (arguments đến từng mẩu) → gom đủ rồi mới phát
  const pending = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | undefined;
  let usage: StreamEvent['usage'];

  const handleLine = function* (line: string): Generator<StreamEvent> {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    const choice = j?.choices?.[0];
    const delta = choice?.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) yield { delta: delta.content };
    for (const t of delta.tool_calls ?? []) {
      const idx = t?.index ?? 0;
      const cur = pending.get(idx) ?? { id: '', name: '', args: '' };
      if (t?.id) cur.id = t.id;
      if (t?.function?.name) cur.name = t.function.name;
      if (typeof t?.function?.arguments === 'string') cur.args += t.function.arguments;
      pending.set(idx, cur);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (j?.usage) {
      usage = {
        promptTokens: j.usage.prompt_tokens ?? 0,
        completionTokens: j.usage.completion_tokens ?? 0,
        totalTokens: j.usage.total_tokens ?? 0,
      };
    }
  };

  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      yield* handleLine(line);
    }
  }
  // Flush phần còn sót: upstream đóng stream mà dòng cuối KHÔNG có newline thì dòng đó
  // (thường mang usage/finish_reason) sẽ bị vứt lặng lẽ nếu chỉ xử lý trong vòng lặp.
  // decoder.decode() cuối trả nốt ký tự UTF-8 multi-byte đang cắt dở.
  buf += decoder.decode();
  if (buf.trim()) yield* handleLine(buf.trim());

  for (const [idx, t] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(t.args || '{}'); } catch { /* giữ {} */ }
    yield { toolCall: { id: t.id || `call_${idx}`, name: t.name, input } };
  }
  yield { ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}), done: true };
}

/** GET /models — rẻ, không tốn credit, đủ biết token còn sống. */
export async function checkTokenOpenAI(
  s: ProviderSession, defaultBaseUrl: string, d?: Dispatcher,
): Promise<boolean> {
  try {
    const res = await fetch(`${s.baseUrl || defaultBaseUrl}/models`, {
      headers: { authorization: `Bearer ${s.accessToken}` },
      signal: AbortSignal.timeout(15_000),
      ...(d ? ({ dispatcher: d } as any) : {}),
    });
    return res.ok;
  } catch {
    return false;
  }
}
