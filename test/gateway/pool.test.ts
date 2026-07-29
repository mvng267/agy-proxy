import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, NoAccountError, poolKey } from '../../src/gateway/pool.js';

/**
 * 9 assertion gốc GIỮ NGUYÊN — bằng chứng logic xoay account không đổi sau khi
 * pool chuyển sang đa provider (khoá ghép `${provider}:${email}`).
 * Chỉ đổi cơ học: upsert nhận object, get/report nhận account.
 */
function mk() {
  const p = new Pool();
  for (const [e, t] of [['a@x', '1//a'], ['b@x', '1//b'], ['c@x', '1//c']] as const) {
    p.upsert({ provider: 'agy', email: e, refreshToken: t, credential: t, proxyLabel: '', health: 'alive' });
  }
  return p;
}
const get = (p: Pool, e: string) => p.get(e, 'agy')!;

// pick + release (mô phỏng request xong ngay) để test rotation thuần.
const pr = (p: Pool, s: any) => { const a = p.pick(s); p.release(a); return a.email; };

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
  const a = p.pick('full-first'), b = p.pick('full-first'), c = p.pick('full-first');
  assert.deepEqual([a.email, b.email, c.email].sort(), ['a@x', 'b@x', 'c@x']);
});

test('bỏ account tắt / dead / cooldown', () => {
  const p = mk();
  get(p, 'a@x').enabled = false;
  get(p, 'b@x').health = 'dead';
  assert.equal(pr(p, 'round-robin'), 'c@x');
  assert.equal(pr(p, 'full-first'), 'c@x');
});

test('cooldown loại account tạm thời', () => {
  const p = mk();
  const now = 1_000_000;
  get(p, 'a@x').cooldownUntil = now + 60_000;
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
  get(p, 'a@x').quota = quota(10);
  get(p, 'b@x').quota = quota(99);
  get(p, 'c@x').quota = quota(50);
  assert.equal(p.pick('highest-first').email, 'b@x');
  const q = mk();
  get(q, 'a@x').lastUsed = 5000;
  get(q, 'b@x').lastUsed = 0;
  get(q, 'c@x').lastUsed = 9000;
  assert.equal(q.pick('highest-first').email, 'b@x');
});

test('report: đếm token + cooldown khi 429', () => {
  const p = mk();
  const now = 2_000_000;
  const a = get(p, 'a@x');
  p.report(a, { ok: true, promptTokens: 5, completionTokens: 7 }, now);
  assert.equal(a.requests, 1);
  assert.equal(a.tokensIn, 5);
  assert.equal(a.tokensOut, 7);
  assert.equal(a.lastUsed, now);
  p.report(a, { ok: false, status: 429, err: 'quota' }, now);
  assert.ok(a.cooldownUntil > now, 'phải đặt cooldown khi 429');
});

test('persist round-trip (enabled + counters)', () => {
  const p = mk();
  get(p, 'a@x').enabled = false;
  p.report(get(p, 'b@x'), { ok: true, promptTokens: 3, completionTokens: 4 });
  const snap = p.toPersist();

  const q = mk();
  q.applyPersist(snap);
  assert.equal(get(q, 'a@x').enabled, false);
  assert.equal(get(q, 'b@x').tokensIn, 3);
  assert.equal(get(q, 'b@x').tokensOut, 4);
});

// ---------- đa provider ----------

function mk2() {
  const p = mk();
  const kr = JSON.stringify({ refreshToken: 'kr-token', profileArn: 'arn:aws:x' });
  // CÙNG email a@x nhưng provider khác — trường hợp thật: 147 email Kiro trùng email agy
  p.upsert({ provider: 'kr', email: 'a@x', refreshToken: 'kr-token', credential: kr, proxyLabel: '', health: 'alive', profileArn: 'arn:aws:x' });
  p.upsert({ provider: 'kr', email: 'k2@x', refreshToken: 'kr-2', credential: kr, proxyLabel: '', health: 'alive', profileArn: 'arn:aws:x' });
  return p;
}

test('cùng email ở 2 provider cùng tồn tại (không đè nhau)', () => {
  const p = mk2();
  assert.equal(p.list().length, 5);
  assert.equal(p.get('a@x', 'agy')!.refreshToken, '1//a');
  assert.equal(p.get('a@x', 'kr')!.refreshToken, 'kr-token');
  assert.equal(p.get('a@x', 'kr')!.key, poolKey('kr', 'a@x'));
});

test('pick lọc theo provider — kr không bao giờ trả account agy', () => {
  const p = mk2();
  for (let i = 0; i < 6; i++) {
    const a = p.pick('round-robin', Date.now(), 'kr');
    p.release(a);
    assert.equal(a.provider, 'kr');
  }
  assert.deepEqual(p.list('kr').map((a) => a.email).sort(), ['a@x', 'k2@x']);
  assert.equal(p.list('agy').length, 3);
});

test('hết account 1 provider → NoAccountError dù provider kia còn', () => {
  const p = mk2();
  for (const a of p.list('kr')) a.enabled = false;
  assert.throws(() => p.pick('round-robin', Date.now(), 'kr'), NoAccountError);
  assert.doesNotThrow(() => p.pick('round-robin', Date.now(), 'agy'));
});

test('round-robin có cursor RIÊNG mỗi provider (không lệch nhau)', () => {
  const p = mk2();
  const agy = [pr(p, 'round-robin')];
  const k1 = p.pick('round-robin', Date.now(), 'kr'); p.release(k1);
  const agy2 = [pr(p, 'round-robin')];
  assert.deepEqual([...agy, ...agy2], ['a@x', 'b@x'], 'cursor agy không bị Kiro làm nhảy');
});

test('persist khoá cũ (chỉ email) migrate thành agy:', () => {
  const legacy = { 'a@x': { enabled: false, requests: 9, tokensIn: 1, tokensOut: 2, lastUsed: 5 } };
  const p = mk2();
  p.applyPersist(legacy as any);
  assert.equal(p.get('a@x', 'agy')!.enabled, false, 'khoá cũ phải áp cho account agy');
  assert.equal(p.get('a@x', 'agy')!.requests, 9);
  assert.equal(p.get('a@x', 'kr')!.enabled, true, 'không được áp nhầm sang Kiro');
});

test('toPersist dùng khoá ghép', () => {
  const p = mk2();
  const keys = Object.keys(p.toPersist()).sort();
  assert.ok(keys.includes('agy:a@x') && keys.includes('kr:a@x'));
});

test('report: 402 MONTHLY_REQUEST_COUNT → cooldown DÀI (hết hạn mức tháng)', () => {
  const p = mk2();
  const now = 3_000_000;
  const a = p.get('a@x', 'kr')!;
  p.report(a, { ok: false, status: 402, err: 'MONTHLY_REQUEST_COUNT' }, now);
  assert.ok(a.cooldownUntil >= now + 11 * 3600 * 1000, 'hết hạn mức tháng phải nghỉ dài, không phải cooldown ngắn');
  assert.equal(a.liveStatus, 'quota');
});

test('persist GIỮ cooldown + liveStatus qua restart (không đốt lại quota Kiro)', () => {
  const p = mk2();
  const now = Date.now();
  const a = p.get('a@x', 'kr')!;
  p.report(a, { ok: false, status: 402, err: 'MONTHLY_REQUEST_COUNT' }, now);
  const snap = p.toPersist();

  const q = mk2();
  q.applyPersist(snap);
  const b = q.get('a@x', 'kr')!;
  assert.ok(b.cooldownUntil > now, 'cooldown phải sống qua restart');
  assert.equal(b.liveStatus, 'quota');
  assert.equal(q.candidates(now, 'kr').some((x) => x.email === 'a@x'), false, 'không được chọn lại account đã cạn');
});

test('persist BỎ cooldown đã hết hạn', () => {
  const p = mk2();
  const stale = { 'kr:a@x': { cooldownUntil: Date.now() - 60_000, liveStatus: 'quota' } };
  p.applyPersist(stale as any);
  assert.equal(p.get('a@x', 'kr')!.cooldownUntil, 0, 'cooldown quá hạn thì bỏ qua');
});
