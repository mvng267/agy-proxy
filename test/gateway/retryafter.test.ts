import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryAfterMs } from '../../src/gateway/antigravity.js';
import { Pool } from '../../src/gateway/pool.js';
import { config } from '../../src/config.js';

/**
 * Trước đây nhánh stream vứt sạch body 429 → log chỉ có "stream 429", không phân
 * biệt được chặn tốc độ THEO PHÚT (chờ vài chục giây) với hết hạn mức NGÀY.
 * Giờ đọc RetryInfo.retryDelay để cooldown đúng bằng Google yêu cầu.
 */

test('parseRetryAfterMs: đọc header Retry-After dạng số giây', () => {
  assert.equal(parseRetryAfterMs('34', ''), 34_000);
});

test('parseRetryAfterMs: đọc RetryInfo.retryDelay trong body', () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' }],
    },
  });
  assert.equal(parseRetryAfterMs(null, body), 42_000);
});

test('parseRetryAfterMs: hiểu dạng ghép phút+giây', () => {
  assert.equal(parseRetryAfterMs(null, '"retryDelay":"1m30s"'), 90_000);
  assert.equal(parseRetryAfterMs(null, '"retryDelay":"2h"'), 7_200_000);
});

test('parseRetryAfterMs: header thắng body khi có cả hai', () => {
  assert.equal(parseRetryAfterMs('10', '"retryDelay":"99s"'), 10_000);
});

test('parseRetryAfterMs: không có gì → undefined (nơi gọi tự dùng mặc định)', () => {
  assert.equal(parseRetryAfterMs(null, ''), undefined);
  assert.equal(parseRetryAfterMs(null, '{"error":{"code":429}}'), undefined);
  assert.equal(parseRetryAfterMs(null, '"retryDelay":"linh tinh"'), undefined);
});

function mkPool() {
  const p = new Pool();
  p.upsert({ provider: 'agy', email: 'a@x', refreshToken: '1//a' } as any);
  return p;
}

test('report: 429 kèm retryDelay ngắn → cooldown đúng bằng đó, không dùng mặc định', () => {
  const p = mkPool();
  const acc = p.list('agy')[0];
  const now = 1_000_000;
  p.report(acc, { ok: false, status: 429, err: 'stream 429', retryAfterMs: 30_000 }, now);
  assert.equal(acc.cooldownUntil, now + 30_000);
});

test('report: 429 không có retryDelay → giữ cooldown mặc định', () => {
  const p = mkPool();
  const acc = p.list('agy')[0];
  const now = 1_000_000;
  p.report(acc, { ok: false, status: 429, err: 'stream 429' }, now);
  assert.equal(acc.cooldownUntil, now + config.gateway.cooldownSec * 1000);
});

test('report: retryDelay vừa phải bị kẹp trần bằng cooldown mặc định', () => {
  const p = mkPool();
  const acc = p.list('agy')[0];
  const now = 1_000_000;
  // 10 phút: vẫn là rate-limit (≤1h) nên kẹp trần xuống cooldownSec rồi thử lại.
  p.report(acc, { ok: false, status: 429, err: 'stream 429', retryAfterMs: 600_000 }, now);
  assert.equal(acc.cooldownUntil, now + config.gateway.cooldownSec * 1000);
});

test('report: retryDelay RẤT dài ⇒ hết hạn mức, nghỉ 1h thay vì lặp lại mỗi 180s', () => {
  const p = mkPool();
  const acc = p.list('agy')[0];
  const now = 1_000_000;
  // Đo thật trên Antigravity: 518324s (~6 ngày). Không nghỉ nguyên 6 ngày, nhưng
  // cũng không kẹp xuống 180s — nếu không sẽ thử lại account cạn hạn mức liên tục.
  p.report(acc, { ok: false, status: 429, err: 'stream 429', retryAfterMs: 518_324_000 }, now);
  assert.equal(acc.cooldownUntil, now + 3_600_000);
});

test('report: retryDelay quá nhỏ bị nâng lên sàn 5s (tránh quay vòng nóng)', () => {
  const p = mkPool();
  const acc = p.list('agy')[0];
  const now = 1_000_000;
  p.report(acc, { ok: false, status: 429, err: 'stream 429', retryAfterMs: 200 }, now);
  assert.equal(acc.cooldownUntil, now + 5_000);
});

test('report: hết hạn mức THÁNG (402) bỏ qua retryDelay, vẫn nghỉ dài 12h', () => {
  const p = mkPool();
  const acc = p.list('agy')[0];
  const now = 1_000_000;
  p.report(acc, { ok: false, status: 402, err: 'MONTHLY_REQUEST_COUNT', retryAfterMs: 5_000 }, now);
  assert.equal(acc.cooldownUntil, now + 12 * 3600 * 1000);
});
