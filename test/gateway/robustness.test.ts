import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withIdleTimeout, hostBackoffMs, HOST_BACKOFF_MS } from '../../src/gateway/antigravity.js';
import { isTransientError } from '../../src/gateway/pool.js';

/**
 * Robustness P2: idle timeout chống stream treo + backoff giữa các host.
 */

test('withIdleTimeout: promise xong trước hạn → trả giá trị, không đụng onTimeout', async () => {
  let fired = false;
  const v = await withIdleTimeout(Promise.resolve(42), 5_000, () => { fired = true; });
  assert.equal(v, 42);
  assert.equal(fired, false);
});

test('withIdleTimeout: quá hạn im lặng → reject + gọi onTimeout (huỷ reader)', async () => {
  let fired = false;
  const never = new Promise<never>(() => {});
  await assert.rejects(
    () => withIdleTimeout(never, 30, () => { fired = true; }),
    /idle timeout/,
  );
  assert.equal(fired, true, 'onTimeout phải được gọi để cancel reader');
});

test('withIdleTimeout: lỗi idle được pool coi là TRANSIENT (cooldown ngắn, không phạt như quota)', async () => {
  try {
    await withIdleTimeout(new Promise<never>(() => {}), 10);
    assert.fail('phải reject');
  } catch (e: any) {
    assert.equal(isTransientError(String(e.message)), true);
  }
});

test('withIdleTimeout: promise reject trước hạn → giữ nguyên lỗi gốc', async () => {
  await assert.rejects(
    () => withIdleTimeout(Promise.reject(new Error('loi goc')), 5_000),
    /loi goc/,
  );
});

test('hostBackoffMs: tăng dần theo host, vượt danh sách thì giữ mức cuối', () => {
  assert.equal(hostBackoffMs(0), HOST_BACKOFF_MS[0]);
  assert.equal(hostBackoffMs(1), HOST_BACKOFF_MS[1]);
  assert.equal(hostBackoffMs(2), HOST_BACKOFF_MS[2]);
  assert.equal(hostBackoffMs(9), HOST_BACKOFF_MS[HOST_BACKOFF_MS.length - 1]);
  // host lạ (indexOf trả -1) cũng không được ra undefined
  assert.equal(hostBackoffMs(-1), HOST_BACKOFF_MS[HOST_BACKOFF_MS.length - 1]);
});
