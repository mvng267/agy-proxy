import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Pool, scoreAccount, errRate, recordOutcome, SCORE_WEIGHTS, SCORE_STALE_MS, type PoolAccount } from '../../src/gateway/pool.js';

/** Account tối thiểu để chấm điểm — không đụng mạng, không đụng DB. */
function mk(email: string, geminiPct?: number, extra: Partial<PoolAccount> = {}): PoolAccount {
  return {
    // `key` là khoá persist (toPersist dùng a.key); thiếu nó thì toPersist trả object rỗng.
    key: `agy:${email}`,
    email, provider: 'agy', enabled: true, health: 'ok', inflight: 0,
    requests: 0, tokensIn: 0, tokensOut: 0, lastUsed: 0, cooldownUntil: 0, lastError: '',
    ...(geminiPct != null
      ? { quota: { tier: 'FREE', models: [], fetchedAt: 0, groups: [{ name: 'gemini', pct: geminiPct }] } }
      : {}),
    ...extra,
  } as any;
}

describe('errRate — cửa sổ trượt 20', () => {
  test('dưới 3 mẫu → null, không phạt oan account mới', () => {
    const a = mk('a@x');
    assert.equal(errRate(a), null);
    recordOutcome(a, false);
    recordOutcome(a, false);
    assert.equal(errRate(a), null, '2 mẫu vẫn chưa đủ để kết luận');
  });

  test('đếm đúng tỉ lệ lỗi', () => {
    const a = mk('a@x');
    for (const ok of [true, false, true, false]) recordOutcome(a, ok);
    assert.equal(errRate(a), 0.5);
  });

  test('cửa sổ chỉ giữ 20 kết quả gần nhất — lỗi cũ trôi ra ngoài', () => {
    const a = mk('a@x');
    for (let i = 0; i < 20; i++) recordOutcome(a, false); // toàn lỗi
    assert.equal(errRate(a), 1);
    for (let i = 0; i < 20; i++) recordOutcome(a, true);  // hồi phục hoàn toàn
    assert.equal(errRate(a), 0, 'account đã hồi phục không được nhớ lỗi cũ mãi');
  });

  test('EWMA độ trễ trượt về phía giá trị mới', () => {
    const a = mk('a@x');
    recordOutcome(a, true, 1000);
    assert.equal(a.latencyEwmaMs, 1000);
    recordOutcome(a, true, 2000);
    assert.ok(a.latencyEwmaMs! > 1000 && a.latencyEwmaMs! < 2000);
  });
});

describe('scoreAccount', () => {
  test('quota cao hơn → điểm cao hơn (trọng số lớn nhất)', () => {
    assert.ok(scoreAccount(mk('hi@x', 90)) > scoreAccount(mk('lo@x', 10)));
  });

  test('thiếu dữ liệu → trung tính 0.5, KHÔNG phải 0', () => {
    // Nếu tính 0 thì account mới không bao giờ được chọn → không bao giờ có số đo.
    const unknown = mk('new@x');
    const bad = mk('bad@x', 0);
    assert.ok(scoreAccount(unknown) > scoreAccount(bad), 'account chưa đo không được xếp sau account đã biết là cạn');
  });

  test('tỉ lệ lỗi cao kéo điểm xuống', () => {
    const good = mk('g@x', 50);
    const bad = mk('b@x', 50);
    for (let i = 0; i < 10; i++) { recordOutcome(good, true); recordOutcome(bad, false); }
    assert.ok(scoreAccount(good) > scoreAccount(bad));
  });

  test('đang bận nhiều → điểm thấp hơn khi mọi thứ khác bằng nhau', () => {
    assert.ok(scoreAccount(mk('idle@x', 50), undefined, 4) > scoreAccount(mk('busy@x', 50, { inflight: 4 }), undefined, 4));
  });

  test('trọng số cộng lại đúng 1', () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  test('điểm luôn nằm trong 0..1', () => {
    for (const a of [mk('a@x'), mk('b@x', 0), mk('c@x', 100, { inflight: 99, latencyEwmaMs: 99999 })]) {
      const s = scoreAccount(a, undefined, 99);
      assert.ok(s >= 0 && s <= 1, `điểm ${s} ngoài khoảng`);
    }
  });
});

describe('pick — full-first và smart giờ KHÁC nhau', () => {
  /** Pool cô lập, không đụng pool thật. */
  function pool3() {
    const p = new Pool();
    (p as any).accounts = new Map([
      ['agy:lo@x', mk('lo@x', 10)],
      ['agy:mid@x', mk('mid@x', 50)],
      ['agy:hi@x', mk('hi@x', 95)],
    ]);
    return p;
  }

  test('full-first chọn quota THẤP NHẤT — dồn cạn từng account', () => {
    // Trước đây full-first dùng chung `c[0]!` với failover: lấy phần tử đầu Map,
    // không đọc quota. Test này khoá hành vi đúng lại.
    assert.equal(pool3().pick('full-first').email, 'lo@x');
  });

  test('highest-first chọn quota CAO NHẤT', () => {
    assert.equal(pool3().pick('highest-first').email, 'hi@x');
  });

  test('smart chọn account điểm cao nhất — quota cao khi mọi thứ khác bằng nhau', () => {
    assert.equal(pool3().pick('smart').email, 'hi@x');
  });

  test('smart TRÁNH account quota cao nhưng lỗi liên tục', () => {
    const p = pool3();
    const hi = (p as any).accounts.get('agy:hi@x') as PoolAccount;
    for (let i = 0; i < 10; i++) recordOutcome(hi, false); // hi lỗi 100%
    const mid = (p as any).accounts.get('agy:mid@x') as PoolAccount;
    for (let i = 0; i < 10; i++) recordOutcome(mid, true);
    // highest-first vẫn mù quáng chọn hi; smart thì không.
    assert.equal(p.pick('highest-first').email, 'hi@x');
    p.release('agy:hi@x');
    assert.equal(p.pick('smart').email, 'mid@x', 'smart phải né account đang hỏng');
  });
});

describe('persist số liệu chấm điểm qua restart', () => {
  function pool1() {
    const p = new Pool();
    (p as any).accounts = new Map([['agy:a@x', mk('a@x', 50)]]);
    return p;
  }

  test('recentFails/latency ĐƯỢC lưu — restart không bắt học lại từ đầu', () => {
    const p = pool1();
    const a = (p as any).accounts.get('agy:a@x') as PoolAccount;
    for (let i = 0; i < 10; i++) recordOutcome(a, i % 2 === 0, 1200);
    a.lastAttempt = Date.now();

    const saved = p.toPersist()['agy:a@x'];
    assert.equal(typeof saved.recentFails, 'number', 'thiếu recentFails → mất lịch sử lỗi mỗi lần restart');
    assert.equal(saved.recentCount, 10);
    assert.ok(saved.latencyEwmaMs! > 0);
    assert.ok(saved.scoreAt > 0, 'phải kèm mốc thời gian để biết dữ liệu còn mới không');
  });

  test('nạp lại khi còn mới', () => {
    const p = pool1();
    const a = (p as any).accounts.get('agy:a@x') as PoolAccount;
    p.applyPersist({ 'agy:a@x': { recentFails: 0b1111, recentCount: 8, latencyEwmaMs: 900, scoreAt: Date.now() - 60_000 } as any });
    assert.equal(a.recentCount, 8);
    assert.equal(a.latencyEwmaMs, 900);
    assert.equal(errRate(a), 0.5);
  });

  test('BỎ khi quá cũ — upstream có thể đã hồi phục', () => {
    const p = pool1();
    const a = (p as any).accounts.get('agy:a@x') as PoolAccount;
    p.applyPersist({
      'agy:a@x': { recentFails: 0xfffff, recentCount: 20, latencyEwmaMs: 9999, scoreAt: Date.now() - SCORE_STALE_MS - 1000 } as any,
    });
    assert.equal(a.recentCount ?? 0, 0, 'lịch sử lỗi cũ 30+ phút không được dùng lại');
    assert.equal(a.latencyEwmaMs, undefined);
  });

  test('khứ hồi toPersist → applyPersist giữ nguyên điểm', () => {
    const p1 = pool1();
    const a1 = (p1 as any).accounts.get('agy:a@x') as PoolAccount;
    for (let i = 0; i < 6; i++) recordOutcome(a1, true, 800);
    a1.lastAttempt = Date.now();
    const before = scoreAccount(a1, 'gemini', 1);

    const p2 = pool1();
    p2.applyPersist(p1.toPersist());
    const a2 = (p2 as any).accounts.get('agy:a@x') as PoolAccount;
    // inflight KHÔNG persist (nó là trạng thái tức thời), nên so điểm với cùng inflight=0.
    assert.equal(a2.recentCount, a1.recentCount, 'số mẫu phải khớp');
    assert.equal(a2.latencyEwmaMs, a1.latencyEwmaMs, 'độ trễ phải khớp');
    assert.equal(Math.round(scoreAccount(a2, 'gemini', 1) * 1e6), Math.round(before * 1e6));
  });
});
