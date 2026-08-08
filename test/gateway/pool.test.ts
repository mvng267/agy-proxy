import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, NoAccountError, poolKey, geminiPct, claudePct, bucketPct } from '../../src/gateway/pool.js';

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

test('round-robin luân phiên đều (LRU: chọn account lâu nhất chưa dùng)', () => {
  const p = mk();
  // Tất cả lastUsed=0 → chọn đầu tiên trong Map (a@x)
  const a1 = p.pick('round-robin'); p.release(a1);
  p.report(a1, { ok: true }, 1000); // a@x lastUsed=1000
  const a2 = p.pick('round-robin'); p.release(a2);
  p.report(a2, { ok: true }, 2000); // b@x lastUsed=2000
  const a3 = p.pick('round-robin'); p.release(a3);
  p.report(a3, { ok: true }, 3000); // c@x lastUsed=3000
  const a4 = p.pick('round-robin'); p.release(a4); // quay lại a@x (lastUsed nhỏ nhất)
  assert.deepEqual([a1.email, a2.email, a3.email, a4.email], ['a@x', 'b@x', 'c@x', 'a@x']);
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

test('round-robin LRU: pick theo provider tách biệt nhờ lastUsed', () => {
  const p = mk2();
  // Pick agy lần 1
  const a1 = p.pick('round-robin', Date.now(), 'agy'); p.release(a1);
  p.report(a1, { ok: true }, 1000);
  // Pick kr lần 1 — không ảnh hưởng agy vì tách provider
  const k1 = p.pick('round-robin', Date.now(), 'kr'); p.release(k1);
  p.report(k1, { ok: true }, 2000);
  // Pick agy lần 2 — phải chọn account agy khác (không bị kr làm lệch)
  const a2 = p.pick('round-robin', Date.now(), 'agy'); p.release(a2);
  assert.notEqual(a1.email, a2.email, 'agy pick lần 2 phải khác lần 1 (LRU)');
  assert.equal(a2.provider, 'agy', 'vẫn là account agy');
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

test('report: 402 MONTHLY_REQUEST_COUNT → monthlyExhaustedUntil đến đầu tháng kế', () => {
  const p = mk2();
  // Dùng ngày giữa tháng hiện tại làm "now"
  const now = Date.now();
  const a = p.get('a@x', 'kr')!;
  p.report(a, { ok: false, status: 402, err: 'MONTHLY_REQUEST_COUNT' }, now);
  // Mốc reset là đầu tháng kế THEO GIỜ VN (UTC+7) — hằng số RESET_TZ_OFFSET_H, cố ý
  // không phụ thuộc giờ máy chủ vì Docker/CI thường chạy UTC.
  // TRƯỚC ĐÂY test dùng `new Date(y, m+1, 1)` = giờ MÁY: xanh ở VN, đỏ ở EDT/UTC
  // (đo thật trên Debian EDT). Tính lại bằng UTC để chạy đúng ở mọi múi giờ.
  const TZ = 7;
  const vn = new Date(now + TZ * 3600_000);
  const nextMonth = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth() + 1, 1) - TZ * 3600_000;
  assert.ok(a.monthlyExhaustedUntil >= nextMonth, 'monthlyExhaustedUntil phải >= đầu tháng kế');
  assert.ok(a.monthlyExhaustedUntil <= nextMonth + 2 * 3600_000, 'không quá xa đầu tháng kế');
  assert.ok(a.cooldownUntil === a.monthlyExhaustedUntil, 'cooldownUntil phải khớp monthlyExhaustedUntil');
  assert.equal(a.liveStatus, 'quota');
  // Phải bị loại khỏi candidates
  assert.ok(!p.candidates(now, 'kr').some((x) => x.email === 'a@x'), 'không được chọn lại account hết quota tháng');
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

// ---------- Bể hạn mức: 2 bể ĐỘC LẬP của Antigravity ----------
// Bug thật: xếp hạng account bằng % Gemini khi gọi model Claude → chọn nhầm account
// đã cạn Claude (Gemini 100% mà Claude 0% vẫn được ưu tiên).

function withQuota(p: Pool, email: string, gemini: number, claude: number) {
  const a = p.upsert({ provider: 'agy', email, refreshToken: 'r', credential: 'c', proxyLabel: '', health: 'ok' });
  a.quota = {
    tier: 'Antigravity Starter Quota',
    groups: [
      { name: 'Gemini Models', pct: gemini, resetTime: '' },
      { name: 'Claude and GPT models', pct: claude, resetTime: '' },
    ],
    models: [],
    fetchedAt: Date.now(),
  } as any;
  return a;
}

test('bucketPct đọc ĐÚNG bể, không lẫn sang bể kia', () => {
  const p = new Pool();
  const a = withQuota(p, 'x@t.vn', 73, 97);
  assert.equal(geminiPct(a), 73);
  assert.equal(claudePct(a), 97);
  assert.equal(bucketPct(a, 'gemini'), 73);
  assert.equal(bucketPct(a, 'claude'), 97);
  assert.equal(bucketPct(a, undefined), 73, 'không biết bể → về Gemini như cũ');
});

test('highest-first chọn account theo bể CLAUDE khi gọi model Claude', () => {
  const p = new Pool();
  // A: Gemini đầy nhưng Claude CẠN — cũ sẽ chọn nhầm A vì chỉ nhìn Gemini
  withQuota(p, 'a@t.vn', 100, 0);
  // B: Gemini thấp hơn nhưng Claude còn nhiều
  withQuota(p, 'b@t.vn', 50, 90);

  assert.equal(p.pick('highest-first', Date.now(), 'agy', 'claude').email, 'b@t.vn');
  p.release(p.get('b@t.vn')!);
  assert.equal(p.pick('highest-first', Date.now(), 'agy', 'gemini').email, 'a@t.vn', 'gọi Gemini thì vẫn chọn A');
});

test('provider không chia bể (Kiro) → bucketPct rơi về nhóm đầu', () => {
  const p = new Pool();
  const a = p.upsert({ provider: 'kr', email: 'k@t.vn', refreshToken: 'r', credential: '{"refreshToken":"r"}', proxyLabel: '', health: 'ok' });
  a.quota = { tier: null, groups: [{ name: 'Credits', pct: 42, resetTime: '' }], models: [], fetchedAt: Date.now() } as any;
  assert.equal(bucketPct(a, 'claude'), 42, 'không có nhóm Claude riêng → dùng nhóm đầu');
  assert.equal(bucketPct(a, 'gemini'), 42);
});

test('chưa nạp quota → null, không đoán bừa', () => {
  const p = new Pool();
  const a = p.upsert({ provider: 'agy', email: 'n@t.vn', refreshToken: 'r', credential: 'c', proxyLabel: '', health: 'ok' });
  assert.equal(bucketPct(a, 'claude'), null);
  assert.equal(bucketPct(a, 'gemini'), null);
});

// ---------------------------------------------------------------------------
// G2 — bug fix. Mỗi test dưới đây chốt một bug ĐÃ ĐƯỢC KIỂM CHỨNG trước khi sửa.
// ---------------------------------------------------------------------------

function one(provider: 'agy' | 'kr' = 'agy') {
  const p = new Pool();
  const a = p.upsert({ provider, email: 'a@x', refreshToken: 'r', credential: 'c', proxyLabel: '', health: 'ok' });
  return { p, a };
}

test('release: OBJECT giảm inflight; khoá ghép cũng được; email TRẦN thì không', () => {
  const { p, a } = one();
  a.inflight = 3;
  p.release(a);
  assert.equal(a.inflight, 2, 'object phải giảm');
  p.release('agy:a@x');
  assert.equal(a.inflight, 1, 'khoá ghép phải giảm');
  p.release('a@x'); // email trần — pool tra theo `provider:email` nên trượt
  assert.equal(a.inflight, 1, 'email trần KHÔNG được giảm (đây là bug đã gây rò rỉ)');
});

test('report: lỗi KHÔNG cập nhật lastUsed (giữ LRU trung thực), nhưng ghi lastAttempt', () => {
  const { p, a } = one();
  a.lastUsed = 1000;
  p.report(a, { ok: false, status: 500, err: 'boom' }, 9999);
  assert.equal(a.lastUsed, 1000, 'lỗi mà đổi lastUsed thì account hỏng được LRU ưu ái như account tốt');
  assert.equal(a.lastAttempt, 9999);
});

test('report: thành công cập nhật lastUsed và reset chuỗi lỗi', () => {
  const { p, a } = one();
  a.consecutiveFails = 4;
  p.report(a, { ok: true }, 5000);
  assert.equal(a.lastUsed, 5000);
  assert.equal(a.consecutiveFails, 0);
  assert.equal(a.lastError, '');
});

test('report: lỗi 5xx nay CÓ cooldown (trước đây không có → pick lại ngay request kế)', () => {
  const { p, a } = one();
  const now = 1_000_000;
  p.report(a, { ok: false, status: 503, err: 'upstream down' }, now);
  assert.ok(a.cooldownUntil > now, 'phải có cooldown');
  assert.equal(p.candidates(now, 'agy').length, 0, 'và bị loại khỏi candidates');
});

test('report: 5xx liên tiếp → cooldown tăng dần (backoff), có trần', () => {
  const { p, a } = one();
  const now = 1_000_000;
  p.report(a, { ok: false, status: 500, err: 'x' }, now);
  const first = a.cooldownUntil - now;
  p.report(a, { ok: false, status: 500, err: 'x' }, now);
  p.report(a, { ok: false, status: 500, err: 'x' }, now);
  const third = a.cooldownUntil - now;
  assert.ok(third > first, `lần 3 (${third}ms) phải dài hơn lần 1 (${first}ms)`);
  assert.ok(third <= 300_000, 'nhưng không vượt trần 5 phút');
});

test('report: 401/403 hoặc invalid_grant → dead (token bị thu hồi, thử lại vô ích)', () => {
  for (const info of [
    { ok: false as const, status: 401, err: 'Unauthorized' },
    { ok: false as const, status: 403, err: 'Forbidden' },
    { ok: false as const, status: 400, err: 'invalid_grant' },
  ]) {
    const { p, a } = one();
    p.report(a, info, 1000);
    assert.equal(a.health, 'dead', `${info.status} phải đánh dead`);
    assert.equal(p.candidates(1000, 'agy').length, 0);
  }
});

test('report: 429 vẫn cooldown quota như cũ, KHÔNG đánh dead', () => {
  const { p, a } = one();
  const now = 1_000_000;
  p.report(a, { ok: false, status: 429, err: 'stream 429' }, now);
  assert.notEqual(a.health, 'dead', '429 là tạm thời, không được loại vĩnh viễn');
  assert.equal(a.liveStatus, 'quota');
  assert.ok(a.cooldownUntil > now);
});

test('nextMonthResetMs: KHÔNG phụ thuộc TZ máy chủ (Docker chạy UTC)', async () => {
  const { nextMonthResetMs } = await import('../../src/gateway/pool.js');
  // 2026-03-15T00:00:00Z — mốc reset phải là 2026-04-01 00:00 giờ VN = 2026-03-31T17:00Z, +1h buffer
  const now = Date.UTC(2026, 2, 15);
  const expected = Date.UTC(2026, 3, 1) - 7 * 3600_000 + 3600_000;
  assert.equal(nextMonthResetMs(now), expected);
});

test('geminiPct: ≥2 nhóm mà không có Gemini → null, không lấy bừa nhóm đầu', () => {
  const { a } = one();
  a.quota = {
    tier: null,
    groups: [{ name: 'Claude and GPT models', pct: 90, resetTime: '' }, { name: 'Khác', pct: 10, resetTime: '' }],
    models: [], fetchedAt: Date.now(),
  } as any;
  assert.equal(geminiPct(a), null, 'lấy % bể Claude gắn nhãn gemini sẽ làm highest-first xếp sai');
  assert.equal(claudePct(a), 90, 'nhưng claudePct vẫn đọc đúng');
});

// ---------------------------------------------------------------------------
// G4 — tách bể quota. Bug nghiêm trọng nhất: 429 một bể khoá luôn bể kia.
// ---------------------------------------------------------------------------

function twoBucket() {
  const p = new Pool();
  const a = p.upsert({ provider: 'agy', email: 'a@x', refreshToken: 'r', credential: 'c', proxyLabel: '', health: 'ok' });
  a.quota = {
    tier: 't',
    groups: [{ name: 'Gemini Models', pct: 100, resetTime: '' }, { name: 'Claude and GPT models', pct: 0, resetTime: '' }],
    models: [], fetchedAt: Date.now(),
  } as any;
  return { p, a };
}

test('429 ở bể Claude KHÔNG khoá bể Gemini (trước đây khoá cả account)', () => {
  const { p, a } = twoBucket();
  const now = 1_000_000;
  p.report(a, { ok: false, status: 429, err: 'stream 429', bucket: 'claude' }, now);

  assert.equal(p.candidates(now, 'agy', 'claude').length, 0, 'bể claude phải bị khoá');
  assert.equal(p.candidates(now, 'agy', 'gemini').length, 1, 'bể gemini VẪN phục vụ được');
  assert.equal(a.cooldownUntil, 0, 'không được đặt cooldown toàn cục');
});

test('429 khi KHÔNG biết bể (Kiro) → khoá toàn cục như cũ', () => {
  const p = new Pool();
  const a = p.upsert({ provider: 'kr', email: 'k@x', refreshToken: 'r', credential: 'c', proxyLabel: '', health: 'ok' });
  const now = 1_000_000;
  p.report(a, { ok: false, status: 429, err: 'stream 429' }, now);
  assert.ok(a.cooldownUntil > now, 'không biết bể thì vẫn phải khoá toàn cục');
  assert.equal(p.candidates(now, 'kr').length, 0);
});

test('pick(bucket) bỏ qua account đã cạn đúng bể đó', () => {
  const { p, a } = twoBucket();
  const b = p.upsert({ provider: 'agy', email: 'b@x', refreshToken: 'r', credential: 'c', proxyLabel: '', health: 'ok' });
  const now = 1_000_000;
  p.report(a, { ok: false, status: 429, err: 'x', bucket: 'claude' }, now);

  const picked = p.pick('round-robin', now, 'agy', 'claude');
  assert.equal(picked.email, 'b@x', 'phải chọn account chưa cạn bể claude');
});

test('cooldown bể tự hết hạn theo thời gian', () => {
  const { p, a } = twoBucket();
  const now = 1_000_000;
  p.report(a, { ok: false, status: 429, err: 'x', retryAfterMs: 10_000, bucket: 'claude' }, now);
  assert.equal(p.candidates(now + 5_000, 'agy', 'claude').length, 0, 'còn trong cooldown');
  assert.equal(p.candidates(now + 20_000, 'agy', 'claude').length, 1, 'hết cooldown thì dùng lại được');
});
