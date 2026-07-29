import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, NoAccountError } from '../../src/gateway/pool.js';

function mk() {
  const p = new Pool();
  p.upsert('a@x', '1//a', '', 'alive');
  p.upsert('b@x', '1//b', '', 'alive');
  p.upsert('c@x', '1//c', '', 'alive');
  return p;
}

// pick + release (mô phỏng request xong ngay) để test rotation thuần.
const pr = (p: Pool, s: any) => { const a = p.pick(s); p.release(a.email); return a.email; };

test('round-robin luân phiên đều', () => {
  const p = mk();
  const seq = [pr(p, 'round-robin'), pr(p, 'round-robin'), pr(p, 'round-robin'), pr(p, 'round-robin')];
  assert.deepEqual(seq, ['a@x', 'b@x', 'c@x', 'a@x']);
});

test('full-first & failover luôn account đầu khả dụng (khi rảnh)', () => {
  const p = mk();
  assert.equal(pr(p, 'full-first'), 'a@x');
  assert.equal(pr(p, 'full-first'), 'a@x');
  assert.equal(pr(p, 'failover'), 'a@x');
});

test('concurrency-aware: burst full-first xoay sang account rảnh', () => {
  const p = mk();
  // 3 request đồng thời (không release) → phải rơi vào 3 account khác nhau
  const a = p.pick('full-first'), b = p.pick('full-first'), c = p.pick('full-first');
  assert.deepEqual([a.email, b.email, c.email].sort(), ['a@x', 'b@x', 'c@x']);
});

test('bỏ account tắt / dead / cooldown', () => {
  const p = mk();
  p.accounts.get('a@x')!.enabled = false;
  p.accounts.get('b@x')!.health = 'dead';
  // còn mỗi c@x
  assert.equal(pr(p, 'round-robin'), 'c@x');
  assert.equal(pr(p, 'full-first'), 'c@x');
});

test('cooldown loại account tạm thời', () => {
  const p = mk();
  const now = 1_000_000;
  p.accounts.get('a@x')!.cooldownUntil = now + 60_000;
  assert.equal(p.pick('full-first', now).email, 'b@x');
});

test('tất cả không khả dụng → NoAccountError (503)', () => {
  const p = mk();
  for (const a of p.list()) a.enabled = false;
  assert.throws(() => p.pick('round-robin'), (e: any) => e instanceof NoAccountError && e.code === 503);
});

const quota = (pct: number) => ({ tier: null, groups: [{ name: 'Gemini Models', pct, resetTime: '' }], models: [], fetchedAt: 0 });
test('highest-first chọn quota Gemini cao nhất, fallback ít dùng nhất', () => {
  const p = mk();
  p.accounts.get('a@x')!.quota = quota(10);
  p.accounts.get('b@x')!.quota = quota(99);
  p.accounts.get('c@x')!.quota = quota(50);
  assert.equal(p.pick('highest-first').email, 'b@x');
  // chưa fetch quota → tie-break lastUsed cũ nhất
  const q = mk();
  q.accounts.get('a@x')!.lastUsed = 5000;
  q.accounts.get('b@x')!.lastUsed = 0; // chưa dùng → ưu tiên
  q.accounts.get('c@x')!.lastUsed = 9000;
  assert.equal(q.pick('highest-first').email, 'b@x');
});

test('report: đếm token + cooldown khi 429', () => {
  const p = mk();
  const now = 2_000_000;
  p.report('a@x', { ok: true, promptTokens: 5, completionTokens: 7 }, now);
  const a = p.accounts.get('a@x')!;
  assert.equal(a.requests, 1);
  assert.equal(a.tokensIn, 5);
  assert.equal(a.tokensOut, 7);
  assert.equal(a.lastUsed, now);
  p.report('a@x', { ok: false, status: 429, err: 'quota' }, now);
  assert.ok(a.cooldownUntil > now, 'phải đặt cooldown khi 429');
});

test('persist round-trip (enabled + counters)', () => {
  const p = mk();
  p.accounts.get('a@x')!.enabled = false;
  p.report('b@x', { ok: true, promptTokens: 3, completionTokens: 4 });
  const snap = p.toPersist();

  const q = mk();
  q.applyPersist(snap);
  assert.equal(q.accounts.get('a@x')!.enabled, false);
  assert.equal(q.accounts.get('b@x')!.tokensIn, 3);
  assert.equal(q.accounts.get('b@x')!.tokensOut, 4);
});
