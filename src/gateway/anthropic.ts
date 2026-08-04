import { randomUUID } from 'node:crypto';
import type { ChatMessage, GenResult, ToolCall, ToolDef } from './antigravity.js';

/**
 * Dịch Anthropic Messages API ↔ nội bộ (THUẦN, không mạng).
 * Cần vì Claude Code KHÔNG nói OpenAI API — nó gọi <base>/v1/messages.
 *
 * v2: dịch đủ tools/tool_use/tool_result → Claude Code sửa file/chạy lệnh được
 * (chỉ với provider có function calling native — hiện là agy/, xem Provider.supportsTools).
 */

export interface AnthropicBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string };
  content?: unknown;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  /**
   * Chữ ký thoughtSignature của Gemini, gắn kèm block tool_use để đi khứ hồi qua
   * client. Claude Code gửi trả nguyên văn block nó nhận được, nên chữ ký quay về
   * đủ để dựng lại request hợp lệ cho lượt sau. Không phải field chuẩn Anthropic —
   * dùng tiền tố _ để không đụng khoá thật của Anthropic về sau.
   */
  _signature?: string;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicBlock[] }>;
  system?: string | Array<{ type: string; text?: string }>;
  max_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: { type?: string; name?: string };
}

/** Nội dung 1 block tool_result → text thuần (Anthropic cho phép string | mảng block). */
export function toolResultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((x: any) => {
        if (typeof x === 'string') return x;
        if (x?.type === 'text') return x.text ?? '';
        // block ảnh trong tool_result: Gemini functionResponse không nhận ảnh → ghi chú.
        if (x?.type === 'image') return '[image]';
        return x?.text ?? '';
      })
      .join('');
  }
  if (c == null) return '';
  return JSON.stringify(c);
}

function blocksToOA(blocks: AnthropicBlock[]): ChatMessage['content'] {
  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text':
        if (b.text) parts.push({ type: 'text', text: b.text });
        break;
      case 'image': {
        const s = b.source;
        if (s?.type === 'base64' && s.data) {
          parts.push({ type: 'image_url', image_url: { url: `data:${s.media_type ?? 'image/png'};base64,${s.data}` } });
        }
        break;
      }
      // tool_use/tool_result KHÔNG xử lý ở đây — anthropicToMessages tách thành
      // message riêng để giữ đúng ngữ nghĩa function call.
      // 'thinking' → bỏ
    }
  }
  if (parts.length === 1 && parts[0]!.type === 'text') return parts[0]!.text ?? '';
  return parts.length ? parts : '';
}

/**
 * THUẦN: request Anthropic → messages nội bộ (system thành 1 message role system).
 * 1 message Anthropic có thể sinh NHIỀU message nội bộ: mỗi tool_result là 1 message
 * role 'tool' riêng (Claude Code gộp nhiều tool_result vào 1 message user).
 */
export function anthropicToMessages(b: AnthropicRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (b.system) {
    const sys = typeof b.system === 'string' ? b.system : b.system.map((x) => x.text ?? '').join('\n');
    if (sys.trim()) out.push({ role: 'system', content: sys });
  }
  // tool_use_id → tên tool: functionResponse của Gemini khớp theo TÊN, không theo id.
  const nameById = new Map<string, string>();

  for (const m of b.messages || []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    const toolUses = blocks.filter((x) => x?.type === 'tool_use');
    const toolResults = blocks.filter((x) => x?.type === 'tool_result');

    if (m.role === 'assistant' && toolUses.length) {
      const calls: ToolCall[] = toolUses.map((t) => {
        const id = String(t.id ?? '');
        const name = String(t.name ?? '');
        if (id && name) nameById.set(id, name);
        const sig = typeof t._signature === 'string' ? t._signature : undefined;
        return { id, name, input: (t.input ?? {}) as Record<string, unknown>, ...(sig ? { signature: sig } : {}) };
      });
      const text = blocks.filter((x) => x?.type === 'text').map((x) => x.text ?? '').join('');
      out.push({ role: 'assistant', content: text, toolCalls: calls });
      continue;
    }

    if (toolResults.length) {
      // Phần text đi kèm (nếu có) giữ lại thành message user riêng SAU kết quả tool.
      const rest = blocksToOA(blocks);
      for (const r of toolResults) {
        const id = String(r.tool_use_id ?? '');
        const body = toolResultText(r.content);
        out.push({
          role: 'tool',
          content: r.is_error ? `[error] ${body}` : body,
          toolCallId: id,
          toolName: nameById.get(id) ?? 'tool',
        });
      }
      if (rest && !(typeof rest === 'string' && !rest.trim())) out.push({ role: 'user', content: rest });
      continue;
    }

    out.push({ role: m.role, content: blocksToOA(blocks) });
  }
  return out;
}

/** THUẦN: tools Anthropic → ToolDef nội bộ. */
export function anthropicToolDefs(b: AnthropicRequest): ToolDef[] {
  return (b.tools ?? [])
    .filter((t) => t && typeof t.name === 'string' && t.name)
    .map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }));
}

export function anthropicGenerationConfig(b: AnthropicRequest): Record<string, unknown> {
  const g: Record<string, unknown> = {};
  if (b.max_tokens) g.maxOutputTokens = b.max_tokens;
  if (b.temperature != null) g.temperature = b.temperature;
  if (b.top_p != null) g.topP = b.top_p;
  if (b.top_k != null) g.topK = b.top_k;
  if (b.stop_sequences?.length) g.stopSequences = b.stop_sequences;
  return g;
}

export function toStopReason(finish: string): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
  const f = String(finish || '').toUpperCase();
  if (f === 'TOOL_USE') return 'tool_use';
  if (f.includes('MAX_TOKEN') || f === 'LENGTH') return 'max_tokens';
  if (f.includes('STOP_SEQUENCE')) return 'stop_sequence';
  return 'end_turn';
}

/** THUẦN: GenResult → body Anthropic (non-stream). */
export function resultToAnthropic(model: string, r: GenResult, id?: string) {
  let text = r.text;
  for (const img of r.images) text += (text ? '\n\n' : '') + `![image](${img})`;
  const calls = r.toolCalls ?? [];
  const content: Array<Record<string, unknown>> = [];
  // Claude Code chấp nhận content rỗng phần text, nhưng KHÔNG chấp nhận mảng rỗng.
  if (text || !calls.length) content.push({ type: 'text', text });
  for (const c of calls) {
    content.push({
      type: 'tool_use',
      id: c.id || 'toolu_' + randomUUID().replace(/-/g, '').slice(0, 24),
      name: c.name,
      input: c.input ?? {},
      // Gửi kèm để client trả lại ở lượt sau (xem AnthropicBlock._signature).
      ...(c.signature ? { _signature: c.signature } : {}),
    });
  }
  return {
    id: id ?? 'msg_' + randomUUID().replace(/-/g, ''),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: calls.length ? 'tool_use' : toStopReason(r.finishReason),
    stop_sequence: null,
    usage: { input_tokens: r.usage.promptTokens, output_tokens: r.usage.completionTokens },
  };
}

/** Anthropic SSE BẮT BUỘC có dòng `event:` (khác OpenAI). */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function anthropicErrorBody(status: number, message: string) {
  const type =
    status === 401 ? 'authentication_error'
    : status === 400 ? 'invalid_request_error'
    : status === 404 ? 'not_found_error'
    : status === 429 ? 'rate_limit_error'
    : status === 503 ? 'overloaded_error'
    : 'api_error';
  return { type: 'error', error: { type, message } };
}

/**
 * Claude Code gửi id Anthropic thật (claude-sonnet-4-5-20250929). Đây là NGOẠI LỆ
 * có chủ đích của luật "prefix bắt buộc" — nếu không thì Claude Code không bao giờ chạy.
 */
export function resolveAnthropicModel(raw: string, cfg: { big: string; small: string }): string {
  const s = String(raw ?? '').trim();
  if (!s) return cfg.big;
  if (/^(agy|kr|antigravity|kiro|combo)\//i.test(s) || s === 'auto' || s.startsWith('auto/')) return s;
  if (/haiku/i.test(s)) return cfg.small;
  return cfg.big; // sonnet/opus/không rõ → model chính
}
