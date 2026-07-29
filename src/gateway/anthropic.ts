import { randomUUID } from 'node:crypto';
import type { ChatMessage, GenResult } from './antigravity.js';

/**
 * Dịch Anthropic Messages API ↔ nội bộ (THUẦN, không mạng).
 * Cần vì Claude Code KHÔNG nói OpenAI API — nó gọi <base>/v1/messages.
 *
 * Giới hạn v1: chưa dịch tools/tool_use → Claude Code kết nối + stream text được
 * nhưng CHƯA sửa file/chạy lệnh được. Nói rõ trên UI.
 */

export interface AnthropicBlock {
  type: string;
  text?: string;
  source?: { type: string; media_type?: string; data?: string };
  content?: unknown;
  name?: string;
  input?: unknown;
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
  tools?: unknown[];
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
      case 'tool_result': {
        // v1: phẳng hoá thành text (chưa hỗ trợ tool-use thật)
        const c = b.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join('') : JSON.stringify(c ?? '');
        if (t) parts.push({ type: 'text', text: `[tool_result] ${t}` });
        break;
      }
      case 'tool_use':
        parts.push({ type: 'text', text: `[tool_use ${b.name ?? ''}] ${JSON.stringify(b.input ?? {})}` });
        break;
      // 'thinking' → bỏ
    }
  }
  if (parts.length === 1 && parts[0]!.type === 'text') return parts[0]!.text ?? '';
  return parts.length ? parts : '';
}

/** THUẦN: request Anthropic → messages nội bộ (system thành 1 message role system). */
export function anthropicToMessages(b: AnthropicRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (b.system) {
    const sys = typeof b.system === 'string' ? b.system : b.system.map((x) => x.text ?? '').join('\n');
    if (sys.trim()) out.push({ role: 'system', content: sys });
  }
  for (const m of b.messages || []) {
    out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : blocksToOA(m.content) });
  }
  return out;
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

export function toStopReason(finish: string): 'end_turn' | 'max_tokens' | 'stop_sequence' {
  const f = String(finish || '').toUpperCase();
  if (f.includes('MAX_TOKEN') || f === 'LENGTH') return 'max_tokens';
  if (f.includes('STOP_SEQUENCE')) return 'stop_sequence';
  return 'end_turn';
}

/** THUẦN: GenResult → body Anthropic (non-stream). */
export function resultToAnthropic(model: string, r: GenResult, id?: string) {
  let text = r.text;
  for (const img of r.images) text += (text ? '\n\n' : '') + `![image](${img})`;
  return {
    id: id ?? 'msg_' + randomUUID().replace(/-/g, ''),
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: toStopReason(r.finishReason),
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
