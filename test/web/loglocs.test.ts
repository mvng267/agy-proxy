import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loLoc, dangLoc, BO_LOC_RONG, type BoLoc, type DongLog } from '../../web/src/lib/loglocs.js';

/**
 * Bộ lọc Live Log.
 *
 * Vì sao có file này: bản trước KHÔNG có test nào cho logic lọc, và đúng chỗ đó có ba lỗi
 * cùng lúc — `filtering` kể 4 tiêu chí trong khi `shown` lọc theo 6, còn `clearFilters` xoá
 * 4. Hậu quả rơi vào đúng lúc cần nhất: lọc theo mã 429 mà không dòng nào khớp thì màn hình
 * trống trơn, số đếm báo "500 dòng" thay vì "lọc: 0/500", và không có nút thoát ra.
 */

const ROOT = resolve(import.meta.dirname, '../..');

const mk = (o: Partial<DongLog> = {}): DongLog => ({ kind: 'res', msg: '', ...o });

const loc = (o: Partial<BoLoc> = {}): BoLoc => ({ ...BO_LOC_RONG, kinds: new Set(), ...o });

const DONG: DongLog[] = [
  mk({ kind: 'res', msg: 'ok', model: 'agy/x', account: 'a@t', status: 200 }),
  mk({ kind: 'err', msg: 'het han muc', model: 'agy/x', account: 'b@t', status: 429 }),
  mk({ kind: 'err', msg: 'server loi', model: 'kr/y', account: 'a@t', status: 500 }),
  mk({ kind: 'req', msg: 'gui di', model: 'kr/y', account: 'c@t' }),
];

describe('dangLoc — phải kể ĐỦ mọi tiêu chí', () => {
  test('không lọc gì → false', () => {
    assert.equal(dangLoc(loc()), false);
  });

  /**
   * Đây chính là lỗi đã có. `status` và `account` từng bị bỏ sót, nên lọc theo mã lỗi mà
   * giao diện vẫn tưởng "không lọc gì".
   */
  for (const [ten, f] of [
    ['kinds', loc({ kinds: new Set(['err' as const]) })],
    ['model', loc({ model: 'agy/x' })],
    ['apiKey', loc({ apiKey: 'k1' })],
    ['status', loc({ status: '429' })],
    ['account', loc({ account: 'a@t' })],
    ['q', loc({ q: 'loi' })],
  ] as const) {
    test(`lọc theo ${ten} → true`, () => {
      assert.equal(dangLoc(f), true, `bỏ sót ${ten} thì nút "Bỏ lọc" không hiện`);
    });
  }

  test('q chỉ có khoảng trắng → KHÔNG tính là đang lọc', () => {
    // Gõ nhầm dấu cách rồi xoá chữ đi mà vẫn báo "đang lọc" là gây hoang mang.
    assert.equal(dangLoc(loc({ q: '   ' })), false);
  });
});

describe('dangLoc khớp với loLoc — không được lệch nhau', () => {
  /**
   * Ràng buộc THẬT SỰ quan trọng: nếu `loLoc` bỏ bớt dòng nào thì `dangLoc` phải báo true.
   * Đây là bất biến mà bản trước vi phạm.
   */
  const CAC_BO_LOC: BoLoc[] = [
    loc({ status: '429' }),
    loc({ account: 'a@t' }),
    loc({ model: 'agy/x' }),
    loc({ kinds: new Set(['err']) }),
    loc({ q: 'loi' }),
    loc({ status: '500', account: 'a@t' }),
  ];

  for (const f of CAC_BO_LOC) {
    const ten = Object.entries(f)
      .filter(([, v]) => (v instanceof Set ? v.size : v))
      .map(([k]) => k)
      .join('+');
    test(`bộ lọc "${ten}": bớt dòng thì dangLoc phải báo true`, () => {
      const bot = loLoc(DONG, f).length < DONG.length;
      if (bot) assert.equal(dangLoc(f), true, 'lọc mất dòng mà giao diện tưởng không lọc');
    });
  }
});

describe('loLoc — lọc đúng', () => {
  test('theo mã lỗi', () => {
    const r = loLoc(DONG, loc({ status: '429' }));
    assert.equal(r.length, 1);
    assert.equal(r[0]!.msg, 'het han muc');
  });

  test('dòng KHÔNG có status không lọt vào bộ lọc mã cụ thể', () => {
    // `req` chưa có status. Nếu so sánh lỏng thì undefined lọt vào mọi mã.
    assert.equal(loLoc(DONG, loc({ status: '200' })).length, 1);
  });

  test('theo account', () => {
    assert.equal(loLoc(DONG, loc({ account: 'a@t' })).length, 2);
  });

  test('nhiều tiêu chí cùng lúc là AND, không phải OR', () => {
    const r = loLoc(DONG, loc({ account: 'a@t', status: '500' }));
    assert.equal(r.length, 1, 'OR sẽ ra 3 dòng');
    assert.equal(r[0]!.model, 'kr/y');
  });

  test('kinds rỗng nghĩa là KHÔNG lọc theo loại, không phải loại bỏ hết', () => {
    assert.equal(loLoc(DONG, loc({ kinds: new Set() })).length, DONG.length);
  });

  test('tìm chuỗi quét cả model/account/apiKey, không chỉ msg', () => {
    assert.equal(loLoc(DONG, loc({ q: 'kr/y' })).length, 2, 'gõ tên model phải ra dòng của model đó');
    assert.equal(loLoc(DONG, loc({ q: 'c@t' })).length, 1);
  });

  test('tìm chuỗi KHÔNG phân biệt hoa thường', () => {
    assert.equal(loLoc(DONG, loc({ q: 'AGY/X' })).length, 2);
  });

  test('không lọc gì → giữ nguyên tất cả', () => {
    assert.equal(loLoc(DONG, loc()).length, DONG.length);
  });

  test('không sửa mảng gốc', () => {
    const truoc = [...DONG];
    loLoc(DONG, loc({ status: '429' }));
    assert.deepEqual(DONG, truoc);
  });
});

describe('component dùng đúng module chung', () => {
  const SRC = readFileSync(resolve(ROOT, 'web/src/components/pages/LiveLog.tsx'), 'utf8');

  test('không còn danh sách bộ lọc viết tay lần hai', () => {
    // Chính việc chép lại danh sách ở chỗ thứ hai đã sinh ra bug. Bắt ngay nếu tái diễn.
    assert.match(SRC, /const filtering = dangLoc\(boLoc\)/);
    assert.match(SRC, /const shown = useMemo\(\(\) => loLoc\(entries, boLoc\)/);
  });

  test('clearFilters xoá ĐỦ 6 tiêu chí', () => {
    /**
     * Lỗi đã có: bấm "Bỏ lọc" mà mã lỗi và account vẫn còn nguyên — bộ lọc không xoá hết
     * nên người dùng tưởng giao diện hỏng.
     */
    const i = SRC.indexOf('const clearFilters');
    assert.ok(i > 0, 'thiếu clearFilters');
    const fn = SRC.slice(i, SRC.indexOf('\n  }', i));
    for (const set of ['setKinds', 'setModel', 'setApiKey', 'setStatus', 'setAccount', 'setQ']) {
      assert.ok(fn.includes(set), `clearFilters bỏ sót ${set}`);
    }
  });

  test('nút copy từng dòng dùng CHUNG định dạng với file tải về', () => {
    // Hai định dạng khác nhau thì dán vào issue rồi grep trong file tải về sẽ không khớp.
    assert.match(SRC, /const text = shown\.map\(dongText\)\.join\("\\n"\)/);
    assert.match(SRC, /value=\{\(\) => dongText\(e\)\}/);
  });

  test('revokeObjectURL KHÔNG gọi ngay sau click', () => {
    // Gọi ngay là chạy đua với chính nó: trình duyệt có thể chưa kịp đọc blob → file rỗng.
    const i = SRC.indexOf('a.click()');
    assert.ok(i > 0);
    const sau = SRC.slice(i, i + 500);
    assert.doesNotMatch(sau, /a\.click\(\)\s*\n\s*URL\.revokeObjectURL/);
    assert.match(sau, /setTimeout\(\(\) => URL\.revokeObjectURL/);
  });
});
