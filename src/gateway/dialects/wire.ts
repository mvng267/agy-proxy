import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { openaiError, mapStatus, retryAfterSec, toOpenAIFinish } from '../openai.js';
import { allModels } from '../providers/index.js';
import { isContextTooLong } from '../combo.js';
import type { ChatMessage, GenResult, ToolCall, ToolDef } from '../antigravity.js';

/**
 * Wire-format helpers dùng chung cho các dialect HTTP: chuyển body client ↔ kiểu nội bộ,
 * dựng response OpenAI, và khung SSE. KHÔNG chứa business logic (không đụng pool/engine).
 */

/**
 * Lỗi "đầu vào quá dài": biến thành thông báo hành động được.
 * Kiro/Bedrock chặn quanh ~100k token dù công bố 200k; Antigravity nhận tới 1M.
 */
export function contextHint(e: unknown, model: string): string | undefined {
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

export function toMessages(body: any): ChatMessage[] {
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
export function toToolDefs(body: any): ToolDef[] {
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

export function openaiCompletion(model: string, r: GenResult) {
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
    // Trước đây trả thẳng r.finishReason → client nhận 'STOP'/'MAX_TOKENS' của Gemini,
    // không phải giá trị OpenAI hợp lệ.
    choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : toOpenAIFinish(r.finishReason) }],
    usage: {
      prompt_tokens: r.usage.promptTokens,
      completion_tokens: r.usage.completionTokens,
      total_tokens: r.usage.totalTokens,
    },
  };
}

/**
 * Trả lỗi cho client OpenAI, đúng spec.
 *
 * Ba việc mà đường cũ làm sai:
 *  1. `{error: "<chuỗi>"}` — SDK đọc `err.error.message` được undefined.
 *  2. Mọi lỗi bị dồn về 400/502/503 nên 429 upstream thành 502, client không biết retry.
 *  3. Lỗi giữa stream chỉ `reply.raw.end()` — không `[DONE]`, không frame lỗi → client TREO.
 */
export function sendOpenAIError(reply: FastifyReply, e: any, model?: string): FastifyReply {
  const status = mapStatus(e);
  const hint = model ? contextHint(e, model) : undefined;
  const msg = hint ?? e?.message ?? 'all accounts failed';
  const ra = retryAfterSec(e);
  if (ra != null && status === 429) reply.header('retry-after', String(ra));

  // Đã gửi byte SSE → không đổi được status nữa, nhưng vẫn phải ĐÓNG stream đúng cách.
  if (reply.raw.headersSent) {
    const body = config.gateway.openaiStrictErrors
      ? openaiError(status, msg, hint ? { detail: e?.message } : undefined)
      : { error: msg };
    try {
      reply.raw.write(`data: ${JSON.stringify(body)}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
    } catch { /* client đã ngắt */ }
    reply.raw.end();
    return reply;
  }

  if (!config.gateway.openaiStrictErrors) {
    return reply.code(status).send({ error: msg, ...(hint ? { detail: e?.message } : {}) });
  }
  return reply.code(status).send(openaiError(status, msg, hint ? { detail: e?.message } : undefined));
}

export function sseInit(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

export function sseChunk(reply: FastifyReply, model: string, id: string, delta: any, finish: string | null) {
  // Tự mở stream ở byte đầu tiên: MỌI đường stream (combo lẫn direct-model) đều hoãn
  // sseInit() để còn failover (trượt bước combo / đổi account) khi chưa gửi byte nào.
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
