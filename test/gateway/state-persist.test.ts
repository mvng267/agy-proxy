import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../../src/gateway/pool.js';

/**
 * Trạng thái kiểm account phải SỐNG SÓT qua đồng bộ và qua restart.
 *
 * Hai bug người dùng gặp trên production ("đồng bộ xong không lưu lại trạng thái"):
 *
 * 1. `syncFromStore()` chạy mỗi 2 giây và gọi `pool.upsert()` với
 *    `health: c.health || 'unknown'` lấy từ credentials.csv. `upsert` gán vô điều kiện
 *    `cur.health = i.health`, nên kết quả vừa kiểm xong (`alive`) bị xoá về `unknown`
 *    ngay lần sync kế tiếp — bấm "Kiểm tra", thấy xanh vài giây rồi mất. Trái hẳn với
 *    lời hứa "giữ nguyên state cũ" ghi ngay trên đầu hàm.
 *
 * 2. `liveStatus` được ghi vào file persist nhưng KHÔNG khôi phục lúc nạp, và không có
 *    mốc thời gian nào. Nên sau restart, công sức quét cả pool (~1.2s/account, 700
 *    account ≈ 14 phút) mất sạch.
 */

const cred = (health: string) => ({
  provider: 'agy' as const,
  email: 'a@x',
  refreshToken: '1//a',
  credential: '1//a',
  proxyLabel: '',
  health,
});

describe('sync không được xoá kết quả kiểm', () => {
  test('store nói "unknown" thì GIỮ trạng thái RAM đang biết rõ', () => {
    const p = new Pool();
    p.upsert(cred('unknown'));
    const a = p.get('a@x', 'agy')!;

    // Người dùng bấm "Kiểm tra" → biết account còn sống.
    a.health = 'alive';
    a.liveStatus = 'ok';
    a.lastCheckAt = Date.now();

    // syncFromStore chạy lại (mỗi 2 giây) với health từ CSV = 'unknown'.
    p.upsert(cred('unknown'));

    assert.equal(a.health, 'alive', 'sync đã xoá kết quả kiểm — đúng bug người dùng gặp');
    assert.equal(a.liveStatus, 'ok', 'liveStatus cũng phải còn');
  });

  test('store biết RÕ HƠN thì vẫn được nâng cấp', () => {
    // Chỉ chặn hạ cấp ('unknown'), không chặn cập nhật thật.
    const p = new Pool();
    p.upsert(cred('unknown'));
    const a = p.get('a@x', 'agy')!;
    a.health = 'alive';

    p.upsert(cred('dead'));
    assert.equal(a.health, 'dead', 'store báo dead là thông tin thật, phải nhận');
  });

  test('trường khác vẫn cập nhật bình thường', () => {
    const p = new Pool();
    p.upsert(cred('unknown'));
    const a = p.get('a@x', 'agy')!;
    a.health = 'alive';

    p.upsert({ ...cred('unknown'), credential: '1//moi', refreshToken: '1//moi', proxyLabel: 'px1' });
    assert.equal(a.credential, '1//moi', 'credential mới phải được nhận');
    assert.equal(a.proxyLabel, 'px1');
    assert.equal(a.health, 'alive', 'nhưng health vẫn giữ');
  });
});

describe('persist — trạng thái sống qua restart', () => {
  test('toPersist mang theo health và lastCheckAt', () => {
    const p = new Pool();
    p.upsert(cred('unknown'));
    const a = p.get('a@x', 'agy')!;
    a.health = 'alive';
    a.liveStatus = 'ok';
    a.lastCheckAt = 1_700_000_000_000;

    const snap = p.toPersist() as Record<string, any>;
    const s = snap['agy:a@x'];
    assert.equal(s.health, 'alive', 'không lưu health thì restart là mất');
    assert.equal(s.liveStatus, 'ok');
    assert.equal(s.lastCheckAt, 1_700_000_000_000, 'không có mốc thì "alive" không biết từ bao giờ');
  });

  test('applyPersist khôi phục lại sau restart', () => {
    const p = new Pool();
    p.upsert(cred('unknown')); // pool mới sau restart: chưa biết gì
    p.applyPersist({
      'agy:a@x': { health: 'alive', liveStatus: 'ok', lastCheckAt: 1_700_000_000_000 } as any,
    });
    const a = p.get('a@x', 'agy')!;
    assert.equal(a.health, 'alive', 'bản trước persist liveStatus mà không đọc lại');
    assert.equal(a.liveStatus, 'ok');
    assert.equal(a.lastCheckAt, 1_700_000_000_000);
  });

  test('persist KHÔNG ghi đè khi RAM đã biết rõ hơn', () => {
    // File persist có thể cũ hơn thực tế: vừa kiểm ra 'dead' mà file còn 'alive'
    // thì tin cái vừa kiểm.
    const p = new Pool();
    p.upsert(cred('unknown'));
    const a = p.get('a@x', 'agy')!;
    a.health = 'dead';

    p.applyPersist({ 'agy:a@x': { health: 'alive' } as any });
    assert.equal(a.health, 'dead', 'kết quả kiểm mới phải thắng file cũ');
  });
});
