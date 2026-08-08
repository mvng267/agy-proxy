import type { Dispatcher } from 'undici';
import type {
  ChatMessage, GenArgs, GenResult, LiveResult, Provider, ProviderAccount, ProviderSession,
  StreamEvent, ToolCall, ToolDef,
} from './types.js';

/**
 * Adapter OpenAI-compatible (OpenRouter hoặc BẤT KỲ upstream nào nói wire-format
 * /chat/completions) — provider thứ 3, chứng minh dialect pattern mở rộng được:
 * toàn bộ engine/pool/combo/breaker dùng lại nguyên vẹn, chỉ cần cài interface Provider.
 *
 * Credential (bảng credentials, target 'openrouter') nhận 2 dạng:
 *   - key trần:  sk-or-v1-…                     → baseUrl mặc định openrouter.ai
 *   - JSON:      {"apiKey":"…","baseUrl":"…"}   → trỏ upstream OpenAI-compatible tuỳ ý
 *
 * Khác agy/kr: không có OAuth refresh (API key sống mãi → sessionFresh luôn true),
 * không có API hạn mức chung (quota = undefined; 429/402 đã được pool cooldown lo).
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface OrCredential {
  apiKey: string;
  baseUrl: string;
}

/** Bóc credential thô → {apiKey, baseUrl}. null = không phải credential OpenRouter. */
export function parseOrCredential(value: string): OrCredential | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (s.startsWith('sk-or-')) return { apiKey: s, baseUrl: DEFAULT_BASE_URL };
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (typeof j?.apiKey === 'string' && j.apiKey) {
        const baseUrl = typeof j.baseUrl === 'string' && j.baseUrl
          ? j.baseUrl.replace(/\/+$/, '')
          : DEFAULT_BASE_URL;
        return { apiKey: j.apiKey, baseUrl };
      }
    } catch { /* không phải JSON → không phải của provider này */ }
  }
  return null;
}

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

function wireTools(tools?: ToolDef[]): Record<string, unknown>[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** {maxOutputTokens,temperature,topP} (khoá kiểu Gemini, engine dựng sẵn) → khoá OpenAI. */
function wireGenConfig(g?: Record<string, unknown>): Record<string, unknown> {
  if (!g) return {};
  const out: Record<string, unknown> = {};
  if (typeof g.maxOutputTokens === 'number') out.max_tokens = g.maxOutputTokens;
  if (typeof g.temperature === 'number') out.temperature = g.temperature;
  if (typeof g.topP === 'number') out.top_p = g.topP;
  return out;
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  const sec = Number(h);
  return h && Number.isFinite(sec) && sec > 0 ? sec * 1000 : undefined;
}

async function callUpstream(
  s: ProviderSession, body: Record<string, unknown>, dispatcher?: Dispatcher, signal?: AbortSignal,
): Promise<Response> {
  const base = s.baseUrl || DEFAULT_BASE_URL;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${s.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(120_000),
    ...(dispatcher ? ({ dispatcher } as any) : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`openrouter ${res.status}: ${text.slice(0, 200)}`),
      { status: res.status, retryAfterMs: retryAfterMs(res) },
    );
  }
  return res;
}

/** tool_calls wire → ToolCall nội bộ (arguments là chuỗi JSON, hỏng thì {}). */
function parseToolCalls(raw: any[] | undefined): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t, i) => {
    let input: Record<string, unknown> = {};
    try { input = JSON.parse(t?.function?.arguments || '{}'); } catch { /* giữ {} */ }
    return { id: t?.id || `call_${i}`, name: t?.function?.name ?? '', input };
  });
}

export const openrouterProvider: Provider = {
  id: 'or',
  label: 'OpenRouter',
  credentialTarget: 'openrouter',
  /**
   * Danh sách chỉ để LIỆT KÊ (UI, /v1/models, check live) — parseModelId cho qua mọi id
   * sau prefix `or/`, kể cả id có dấu gạch chéo (or/anthropic/claude-sonnet-4).
   */
  models: [
    { id: 'openrouter/auto', label: 'OpenRouter Auto', image: false },
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', image: false },
    { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder', image: false },
  ],
  defaultModel: 'openrouter/auto',
  supportsTools: true,

  accepts(value) {
    return parseOrCredential(value) !== null;
  },

  parseCredential(value) {
    const c = parseOrCredential(value);
    // API key đóng luôn vai refreshToken (pool chỉ cần MỘT chuỗi định danh phiên).
    return c ? { refreshToken: c.apiKey } : null;
  },

  // API key không hết hạn → session luôn tươi, không có vòng refresh.
  sessionFresh() {
    return true;
  },

  sessionOf(a): ProviderSession {
    const c = parseOrCredential(a.credential);
    return { accessToken: c?.apiKey ?? a.refreshToken, baseUrl: c?.baseUrl ?? DEFAULT_BASE_URL };
  },

  async ensureReady(a: ProviderAccount): Promise<ProviderSession> {
    return this.sessionOf(a);
  },

  async generate(args: GenArgs): Promise<GenResult> {
    const res = await callUpstream(args.session, {
      model: args.model,
      messages: toOpenAIWire(args.messages),
      ...(wireTools(args.tools) ? { tools: wireTools(args.tools) } : {}),
      ...wireGenConfig(args.generationConfig),
    }, args.dispatcher, args.signal);
    const j: any = await res.json();
    const msg = j?.choices?.[0]?.message ?? {};
    const toolCalls = parseToolCalls(msg.tool_calls);
    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      images: [],
      toolCalls,
      usage: {
        promptTokens: j?.usage?.prompt_tokens ?? 0,
        completionTokens: j?.usage?.completion_tokens ?? 0,
        totalTokens: j?.usage?.total_tokens ?? 0,
      },
      finishReason: j?.choices?.[0]?.finish_reason ?? 'stop',
      model: j?.model ?? args.model,
    };
  },

  async *generateStream(args: GenArgs): AsyncGenerator<StreamEvent> {
    const res = await callUpstream(args.session, {
      model: args.model,
      messages: toOpenAIWire(args.messages),
      stream: true,
      // usage nằm ở chunk cuối — không xin thì upstream OpenAI-compatible không gửi
      stream_options: { include_usage: true },
      ...(wireTools(args.tools) ? { tools: wireTools(args.tools) } : {}),
      ...wireGenConfig(args.generationConfig),
    }, args.dispatcher, args.signal);

    if (!res.body) throw Object.assign(new Error('openrouter: stream không có body'), { status: 502 });

    // tool_calls stream RỜI RẠC theo index (arguments đến từng mẩu) → gom đủ rồi mới phát
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | undefined;
    let usage: StreamEvent['usage'];

    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j: any;
        try { j = JSON.parse(data); } catch { continue; }
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
      }
    }

    for (const [idx, t] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(t.args || '{}'); } catch { /* giữ {} */ }
      yield { toolCall: { id: t.id || `call_${idx}`, name: t.name, input } };
    }
    yield { ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}), done: true };
  },

  /** GET /models — rẻ, không tốn credit, đủ biết key còn sống. */
  async checkToken(a: ProviderAccount, d?: Dispatcher): Promise<boolean> {
    const s = this.sessionOf(a);
    try {
      const res = await fetch(`${s.baseUrl || DEFAULT_BASE_URL}/models`, {
        headers: { authorization: `Bearer ${s.accessToken}` },
        signal: AbortSignal.timeout(15_000),
        ...(d ? ({ dispatcher: d } as any) : {}),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async checkLive(_a: ProviderAccount, s: ProviderSession, d?: Dispatcher): Promise<LiveResult> {
    const t0 = Date.now();
    try {
      const r = await this.generate({
        session: s,
        model: this.defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
        generationConfig: { maxOutputTokens: 8 },
        dispatcher: d,
      });
      return { status: 'ok', ms: Date.now() - t0, detail: (r.text || '').slice(0, 40) };
    } catch (e: any) {
      const quota = e?.status === 402 || e?.status === 429;
      return { status: quota ? 'quota' : 'error', ms: Date.now() - t0, detail: String(e?.message ?? e).slice(0, 120) };
    }
  },

  async checkModelsLive(s: ProviderSession, d?: Dispatcher) {
    const out: { id: string; status: 'ok' | 'quota' | 'error'; ms: number; detail?: string }[] = [];
    for (const m of this.models) {
      const t0 = Date.now();
      try {
        const r = await this.generate({
          session: s,
          model: m.id,
          messages: [{ role: 'user', content: 'hi' }],
          generationConfig: { maxOutputTokens: 8 },
          dispatcher: d,
        });
        out.push({ id: m.id, status: 'ok', ms: Date.now() - t0, detail: (r.text || '').slice(0, 30) });
      } catch (e: any) {
        const quota = e?.status === 402 || e?.status === 429;
        out.push({ id: m.id, status: quota ? 'quota' : 'error', ms: Date.now() - t0, detail: String(e?.message ?? e).slice(0, 100) });
      }
    }
    return out;
  },

  // Không có API hạn mức chung cho mọi upstream OpenAI-compatible → không cài quota().
};
