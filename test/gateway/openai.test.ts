import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openaiGenerationConfig, toOpenAIFinish, openaiError, mapStatus, retryAfterSec,
} from '../../src/gateway/openai.js';
import { NoAccountError } from '../../src/gateway/pool.js';

/**
 * G3 — chuẩn OpenAI. Mỗi test chốt một sai lệch ĐÃ ĐO ĐƯỢC trước khi sửa
 * (vd gửi max_tokens=5 nhận về 211 completion_tokens).
 */

test('generationConfig: max_tokens được tôn trọng (trước đây bị bỏ hoàn toàn)', () => {
  assert.equal(openaiGenerationConfig({ max_tokens: 5 }).maxOutputTokens, 5);
  assert.equal(openaiGenerationConfig({ max_completion_tokens: 100 }).maxOutputTokens, 100);
});

test('generationConfig: kẹp trần 64000 — vượt là Google trả 429 trần khó chẩn đoán', () => {
  assert.equal(openaiGenerationConfig({ max_tokens: 128000 }).maxOutputTokens, 64000);
  assert.equal(openaiGenerationConfig({ max_tokens: 64000 }).maxOutputTokens, 64000);
});

test('generationConfig: temperature/top_p/stop', () => {
  const g = openaiGenerationConfig({ temperature: 0.2, top_p: 0.9, stop: 'END' });
  assert.equal(g.temperature, 0.2);
  assert.equal(g.topP, 0.9);
  assert.deepEqual(g.stopSequences, ['END']);
  assert.deepEqual(openaiGenerationConfig({ stop: ['a', 'b'] }).stopSequences, ['a', 'b']);
});

test('generationConfig: body rỗng → object rỗng, không bịa giá trị', () => {
  assert.deepEqual(openaiGenerationConfig({}), {});
  assert.deepEqual(openaiGenerationConfig({ max_tokens: 0 }), {}, 'max_tokens=0 không hợp lệ, bỏ qua');
});

test('finish_reason: giá trị Gemini thô → giá trị OpenAI hợp lệ', () => {
  assert.equal(toOpenAIFinish('STOP'), 'stop');
  assert.equal(toOpenAIFinish('MAX_TOKENS'), 'length');
  assert.equal(toOpenAIFinish('SAFETY'), 'content_filter');
  assert.equal(toOpenAIFinish('RECITATION'), 'content_filter');
  assert.equal(toOpenAIFinish(undefined), 'stop');
  assert.equal(toOpenAIFinish('linh tinh'), 'stop', 'không rõ thì mặc định stop, không trả nguyên văn');
});

test('openaiError: envelope object đúng spec, KHÔNG phải chuỗi', () => {
  const e = openaiError(429, 'quá tải');
  assert.equal(typeof e.error, 'object', 'SDK đọc err.error.message — trả chuỗi là hỏng');
  assert.equal(e.error.message, 'quá tải');
  assert.equal(e.error.type, 'rate_limit_error');
  assert.equal(e.error.code, null);
  assert.equal(e.error.param, null);
});

test('openaiError: map type theo status', () => {
  assert.equal(openaiError(401, 'x').error.type, 'authentication_error');
  assert.equal(openaiError(403, 'x').error.type, 'permission_error');
  assert.equal(openaiError(404, 'x').error.type, 'not_found_error');
  assert.equal(openaiError(400, 'x').error.type, 'invalid_request_error');
  assert.equal(openaiError(502, 'x').error.type, 'api_error');
});

test('openaiError: giữ field phụ (param, suggestion) mà không phá cấu trúc', () => {
  const e = openaiError(400, 'model sai', { param: 'model', suggestion: 'thử agy/…' }) as any;
  assert.equal(e.error.param, 'model');
  assert.equal(e.error.suggestion, 'thử agy/…');
});

test('mapStatus: 429 upstream PHẢI ra 429 (trước đây thành 502)', () => {
  assert.equal(mapStatus({ status: 429 }), 429);
  assert.equal(mapStatus({ status: 400 }), 400);
  assert.equal(mapStatus({ status: 413 }), 413);
  assert.equal(mapStatus(new NoAccountError()), 503);
});

test('mapStatus: 401/403 UPSTREAM → 502, không để client tưởng key của nó sai', () => {
  assert.equal(mapStatus({ status: 401 }), 502);
  assert.equal(mapStatus({ status: 403 }), 502);
});

test('mapStatus: 5xx và lỗi không rõ → 502', () => {
  assert.equal(mapStatus({ status: 500 }), 502);
  assert.equal(mapStatus({ status: 503 }), 502);
  assert.equal(mapStatus(new Error('mạng hỏng')), 502);
});

test('retryAfterSec: đọc từ retryAfterMs, làm tròn lên, tối thiểu 1', () => {
  assert.equal(retryAfterSec({ retryAfterMs: 30_000 }), 30);
  assert.equal(retryAfterSec({ retryAfterMs: 1500 }), 2);
  assert.equal(retryAfterSec({ retryAfterMs: 10 }), 1);
  assert.equal(retryAfterSec({}), undefined);
});
