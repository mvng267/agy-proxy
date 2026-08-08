import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitBreakerOpenError } from '../../src/gateway/breaker.js';

/**
 * CircuitBreaker — máy trạng thái thuần, `now` truyền tay (không sleep).
 * Ba trạng thái: closed → open (đủ ngưỡng lỗi liên tiếp) → half-open (hết openMs)
 * → closed (thăm dò ok) hoặc open lại (thăm dò fail).
 */

const T0 = 1_700_000_000_000;

function tripped(b: CircuitBreaker, key: string, n: number, now = T0): void {
  for (let i = 0; i < n; i++) b.fail(key, now);
}

test('closed: dưới ngưỡng vẫn cho qua, đủ ngưỡng thì mở', () => {
  const b = new CircuitBreaker({ failureThreshold: 3, openMs: 30_000 });
  tripped(b, 'agy', 2);
  assert.equal(b.state('agy', T0), 'closed');
  b.allow('agy', T0); // không ném

  b.fail('agy', T0); // lỗi thứ 3 → mở
  assert.equal(b.state('agy', T0), 'open');
  assert.throws(() => b.allow('agy', T0 + 1), CircuitBreakerOpenError);
});

test('thành công reset chuỗi lỗi — lỗi rải rác không bao giờ mở mạch', () => {
  const b = new CircuitBreaker({ failureThreshold: 3, openMs: 30_000 });
  b.fail('agy', T0);
  b.fail('agy', T0);
  b.ok('agy'); // chuỗi đứt
  b.fail('agy', T0);
  b.fail('agy', T0);
  assert.equal(b.state('agy', T0), 'closed');
});

test('open: chặn kèm retryAfterMs đếm lùi; hết openMs thì thành half-open cho qua', () => {
  const b = new CircuitBreaker({ failureThreshold: 2, openMs: 30_000 });
  tripped(b, 'agy', 2, T0);

  try {
    b.allow('agy', T0 + 10_000);
    assert.fail('phải ném khi đang mở');
  } catch (e: any) {
    assert.equal(e.status, 503);
    assert.equal(e.retryAfterMs, 20_000, 'thời gian chờ còn lại phải đếm lùi');
  }

  assert.equal(b.state('agy', T0 + 30_000), 'half-open');
  b.allow('agy', T0 + 30_000); // không ném — nhả request thăm dò
});

test('half-open: thăm dò thành công → đóng hẳn, chuỗi lỗi về 0', () => {
  const b = new CircuitBreaker({ failureThreshold: 2, openMs: 30_000 });
  tripped(b, 'agy', 2, T0);
  b.ok('agy'); // thăm dò ok (sau openMs, nhưng ok() không cần now)
  assert.equal(b.state('agy', T0 + 60_000), 'closed');
  // mở lại cần đủ NGƯỠNG lỗi mới, không phải 1 lỗi
  b.fail('agy', T0 + 60_000);
  assert.equal(b.state('agy', T0 + 60_000), 'closed');
});

test('half-open: thăm dò lỗi → mở lại NGUYÊN một chu kỳ openMs', () => {
  const b = new CircuitBreaker({ failureThreshold: 2, openMs: 30_000 });
  tripped(b, 'agy', 2, T0);
  const t1 = T0 + 30_000; // đã sang half-open
  assert.equal(b.state('agy', t1), 'half-open');
  b.fail('agy', t1);
  assert.equal(b.state('agy', t1 + 1), 'open');
  assert.throws(() => b.allow('agy', t1 + 29_999), CircuitBreakerOpenError);
  assert.equal(b.state('agy', t1 + 30_000), 'half-open');
});

test('mỗi key một mạch riêng — agy mở không ảnh hưởng kr', () => {
  const b = new CircuitBreaker({ failureThreshold: 2, openMs: 30_000 });
  tripped(b, 'agy', 2, T0);
  assert.equal(b.state('agy', T0), 'open');
  assert.equal(b.state('kr', T0), 'closed');
  b.allow('kr', T0); // không ném
});

test('snapshot + reset', () => {
  const b = new CircuitBreaker({ failureThreshold: 2, openMs: 30_000 });
  tripped(b, 'agy', 2, T0);
  b.fail('kr', T0);
  const s = b.snapshot(T0);
  assert.equal(s.agy!.state, 'open');
  assert.equal(s.agy!.consecutiveFails, 2);
  assert.equal(s.kr!.state, 'closed');

  b.reset('agy');
  assert.equal(b.state('agy', T0), 'closed');
  b.reset();
  assert.deepEqual(b.snapshot(T0), {});
});
