import { MAX_OUTPUT_TOKENS_CAP } from './anthropic.js';
import { NoAccountError } from './pool.js';

/**
 * Chuyển đổi + chuẩn hoá phía OpenAI — cặp đối xứng của anthropic.ts.
 * Toàn hàm THUẦN nên test được không cần mạng.
 */

/**
 * Tham số sinh của client OpenAI.
 *
 * TRƯỚC ĐÂY /chat/completions KHÔNG dựng generationConfig gì cả → max_tokens,
 * temperature, top_p bị BỎ HOÀN TOÀN. Đo thật: gửi max_tokens=5 nhận 211 token.
 *
 * `maxOutputTokens` PHẢI kẹp 64000: vượt trần thì Google trả 429 TRẦN (không
 * retryDelay, không quotaId) trông y hệt hết hạn mức → proxy tưởng account cạn,
 * cooldown rồi xoay account, và cả pool cùng cháy dù lỗi nằm ở REQUEST.
 */
export function openaiGenerationConfig(b: any): Record<string, unknown> {
  const g: Record<string, unknown> = {};
  const maxTok = b?.max_completion_tokens ?? b?.max_tokens;
  if (typeof maxTok === 'number' && maxTok > 0) {
    g.maxOutputTokens = Math.min(maxTok, MAX_OUTPUT_TOKENS_CAP);
  }
  if (typeof b?.temperature === 'number') g.temperature = b.temperature;
  if (typeof b?.top_p === 'number') g.topP = b.top_p;
  const stop = b?.stop;
  if (typeof stop === 'string') g.stopSequences = [stop];
  else if (Array.isArray(stop) && stop.length) g.stopSequences = stop.filter((x: unknown) => typeof x === 'string');
  return g;
}

/**
 * finishReason của Gemini → giá trị OpenAI hợp lệ.
 * Trước đây trả thẳng `r.finishReason` nên client nhận "STOP"/"MAX_TOKENS" (in hoa,
 * không có trong spec) thay vì "stop"/"length".
 */
export function toOpenAIFinish(finish?: string): 'stop' | 'length' | 'content_filter' | 'tool_calls' {
  const f = String(finish || '').toUpperCase();
  if (f === 'MAX_TOKENS' || f === 'LENGTH') return 'length';
  if (f === 'SAFETY' || f === 'RECITATION' || f === 'BLOCKLIST' || f === 'PROHIBITED_CONTENT') return 'content_filter';
  if (f === 'TOOL_USE' || f === 'TOOL_CALLS') return 'tool_calls';
  return 'stop';
}

export type OpenAIErrorType =
  | 'authentication_error' | 'invalid_request_error' | 'rate_limit_error'
  | 'permission_error' | 'not_found_error' | 'api_error';

function typeOf(status: number): OpenAIErrorType {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 400 || status === 413 || status === 422) return 'invalid_request_error';
  return 'api_error';
}

/**
 * Envelope lỗi ĐÚNG spec OpenAI: `{error:{message,type,code,param}}`.
 *
 * Trước đây có 4 shape khác nhau, trong đó đường chính trả `{error: "<string>"}` —
 * SDK OpenAI đọc `err.error.message` sẽ được `undefined`.
 */
export function openaiError(
  status: number,
  message: string,
  extra?: { code?: string | null; param?: string | null; [k: string]: unknown },
) {
  return {
    error: {
      message,
      type: typeOf(status),
      code: extra?.code ?? null,
      param: extra?.param ?? null,
      ...(extra ? Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'code' && k !== 'param')) : {}),
    },
  };
}

/**
 * Map lỗi nội bộ → HTTP status trả cho client. Dùng chung cả 2 dialect.
 *
 * Trước đây mọi thứ bị dồn về 400/502/503, nên **429 upstream thành 502** và client
 * không biết là nên retry.
 *
 * Lưu ý ngữ nghĩa: 401/403 của UPSTREAM không được trả nguyên về client — client sẽ
 * tưởng API key của NÓ sai, trong khi thực ra là token account trong pool hỏng.
 */
export function mapStatus(e: any): number {
  if (e instanceof NoAccountError) return 503;
  const s = Number(e?.status ?? e?.code);
  if (s === 400 || s === 404 || s === 413 || s === 422 || s === 429) return s;
  return 502;
}

/** Giây cho header `Retry-After` khi trả 429. undefined nếu upstream không nói. */
export function retryAfterSec(e: any): number | undefined {
  const ms = Number(e?.retryAfterMs);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.max(1, Math.ceil(ms / 1000));
}
