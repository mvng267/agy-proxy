import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chetHangLoat, NGUONG_CHET_HANG_LOAT } from '../../src/gateway/poolScore.js';

/**
 * Account bị đánh dấu `dead` OAN — đo trên production 15/08/2026.
 *
 *   457/703 account health='dead'
 *   → 272 trong số đó có liveStatus='ok', tức GỌI MODEL THẬT THÀNH CÔNG
 *   → 6/6 mẫu thử refresh token đều sống (5–198ms)
 *   → 457/457 KHÔNG ghi lý do chết (lastError rỗng)
 *   → chết theo CỤM: 153 account trong 6 phút sáng 15/08, 62 cái trong 2 phút ngày 11/08
 *
 * `dead` là trạng thái VĨNH VIỄN — account rơi vào đó thì biến khỏi `candidates()` cho
 * tới khi có người gỡ tay. Mất 65% pool mà dashboard vẫn báo xanh.
 *
 * ─── Cơ chế (đã truy ra) ───────────────────────────────────────────────────────
 *
 * `checkLiveAccount` khi gọi model THÀNH CÔNG chỉ đặt `a.health = 'alive'` trong RAM,
 * KHÔNG ghi xuống CSV — khác hẳn `testAccount` (engine.ts:653) vốn gọi
 * `store.setCredentialHealth(...)`.
 *
 * Mà `syncFromStore()` chạy mỗi 2 giây và `pool.upsert()` đẩy health từ CSV vào RAM:
 *
 *     if (i.health && i.health !== 'unknown') cur.health = i.health;
 *
 * → kết quả kiểm live bị xoá sau 2 giây, account "sống" quay lại 'dead' vĩnh viễn.
 *
 * Đúng dạng lỗi lặp lại của repo này: sửa một nhánh, bỏ sót nhánh song song.
 */

const ROOT = resolve(import.meta.dirname, '../..');

function code(f: string): string {
  return readFileSync(resolve(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('kiểm live thành công phải được GHI LẠI, không chỉ nằm trong RAM', () => {
  test('checkLiveAccount ghi health xuống CSV khi account sống', () => {
    /**
     * Không ghi thì `syncFromStore` (2 giây/lần) đè lại bằng giá trị cũ trong CSV. Đây là
     * lý do 272 account gọi model được vẫn nằm ở 'dead'.
     */
    const s = code('src/gateway/engine.ts');
    const i = s.indexOf('export async function checkLiveAccount');
    assert.ok(i > 0, 'không tìm thấy checkLiveAccount');
    const than = s.slice(i, i + 1800);
    assert.match(than, /setCredentialHealth/, 'checkLiveAccount phải ghi health xuống store');
  });

  test('cả hai đường kiểm đều ghi — không lệch nhau', () => {
    const s = code('src/gateway/engine.ts');
    const n = [...s.matchAll(/setCredentialHealth/g)].length;
    assert.ok(n >= 3, `chỉ ${n} chỗ ghi health — testAccount có, checkLiveAccount thiếu`);
  });
});

describe('chetHangLoat — chốt chặn không cho quét giết cả pool', () => {
  test('vài account chết là bình thường, cho qua', () => {
    // Token hỏng lẻ tẻ là chuyện thật, không được cản.
    assert.equal(chetHangLoat({ daChet: 3, tong: 700 }), false);
  });

  test('một vòng giết quá NGƯỠNG pool → chặn', () => {
    /**
     * 153 account chết trong 6 phút không phải 153 token cùng hỏng — đó là dấu hiệu của
     * rate-limit hoặc sự cố hạ tầng phía trên. Chặn ở đây rẻ hơn nhiều so với gỡ tay 457
     * account sau đó.
     */
    assert.equal(chetHangLoat({ daChet: 153, tong: 700 }), true);
  });

  test('pool nhỏ không áp ngưỡng phần trăm', () => {
    // 2/3 account chết trong pool 3 cái là bình thường, không phải sự cố hệ thống.
    assert.equal(chetHangLoat({ daChet: 2, tong: 3 }), false);
  });

  test('ngưỡng nằm trong khoảng hợp lý', () => {
    // Quá thấp thì chặn oan lúc thật sự có nhiều token hỏng; quá cao thì vô dụng.
    assert.ok(NGUONG_CHET_HANG_LOAT > 0.02 && NGUONG_CHET_HANG_LOAT <= 0.25);
  });

  test('đúng mốc ngưỡng thì CHƯA chặn, vượt mới chặn', () => {
    const tong = 1000;
    const mocs = Math.floor(NGUONG_CHET_HANG_LOAT * tong);
    assert.equal(chetHangLoat({ daChet: mocs, tong }), false);
    assert.equal(chetHangLoat({ daChet: mocs + 1, tong }), true);
  });
});

describe('đánh dấu chết phải GHI LÝ DO', () => {
  test('chỉ MỘT đường đặt health dead trong engine', () => {
    /**
     * Trước đây có hai chỗ tự gán `a.health = 'dead'` với hai luật phân loại lỗi khác nhau
     * — `testAccount` xét `invalid_grant|400|401`, `checkLiveAccount` chỉ xét `401`, bỏ qua
     * `isPermanentAuthError`. Hai luật cho cùng một quyết định là nguồn lệch cố hữu.
     *
     * Gom về `danhDauChet()` để lý do, chốt chặn và ghi CSV chỉ tồn tại ở một nơi.
     */
    const s = code('src/gateway/engine.ts');
    const n = [...s.matchAll(/\.health = 'dead'/g)].length;
    assert.equal(n, 1, `có ${n} chỗ tự gán dead — phải đi qua danhDauChet()`);
  });

  test('danhDauChet ghi lý do, ghi CSV và có chốt chặn', () => {
    /**
     * 457/457 account chết trên production có `lastError` RỖNG — chẩn đoán phải suy ngược
     * từ trạng thái cuối. Một chuỗi lý do là đủ để biết ngay.
     */
    const s = code('src/gateway/engine.ts');
    const i = s.indexOf('function danhDauChet');
    assert.ok(i > 0, 'thiếu hàm danhDauChet');
    const than = s.slice(i, i + 1400);
    assert.match(than, /lastError\s*=/, 'phải ghi lý do vào lastError');
    assert.match(than, /chetHangLoat\(/, 'phải hỏi chốt chặn trước khi đánh chết');
    assert.match(than, /setCredentialHealth/, 'phải ghi xuống CSV, không chỉ RAM');
  });

  test('hai đường kiểm dùng CHUNG isPermanentAuthError', () => {
    // `pool.report()` đã dùng; `checkLiveAccount` trước đây tự viết luật riêng.
    const s = code('src/gateway/engine.ts');
    assert.match(s, /isPermanentAuthError\(/, 'checkLiveAccount phải dùng lá chắn chung');
  });
});
