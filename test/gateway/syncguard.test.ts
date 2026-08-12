import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { xoaAnToan } from '../../src/gateway/poolScore.js';

/**
 * `syncFromStore` xoá mọi account không có trong CSV — một lần đọc hụt là mất cả pool.
 *
 * `readCsvFile` (`store/csv.ts`) trả `{headers: [], rows: []}` khi file KHÔNG TỒN TẠI:
 *
 *   if (!existsSync(path)) return { headers: [], rows: [] };
 *
 * Không phân biệt "file thật sự rỗng" với "không đọc được". Rồi ở cuối `syncFromStore`:
 *
 *   for (const a of pool.list()) if (!seen.has(a.key)) pool.remove(a.key);
 *
 * → 703 account biến khỏi pool trong một nhịp sync 2 giây. Ngay sau đó `flushPersist()` ghi
 * `gateway.json` với pool RỖNG, đè mất 1,8 MB state: quota, cooldown, projectId, token của
 * cả pool. Mất kép, không log, không cảnh báo, không có đường lùi.
 *
 * Xoá account là việc BÌNH THƯỜNG (người dùng gỡ account thật) — không chặn được hẳn. Nhưng
 * mất sạch hoặc mất quá nửa trong một nhịp thì gần như chắc chắn là lỗi đọc, không phải ý
 * định của ai.
 */

describe('xoaAnToan — chặn xoá hàng loạt do đọc hụt', () => {
  test('xoá vài account là bình thường, cho qua', () => {
    // Người dùng gỡ 3/703 account: hợp lệ, không được cản.
    const r = xoaAnToan(703, 700);
    assert.equal(r.choPhep, true);
  });

  test('CSV rỗng hoàn toàn trong khi pool đang có account → TỪ CHỐI', () => {
    /**
     * Đây là kịch bản chính: file mất/không đọc được → `listCredentials()` trả mảng rỗng.
     * Không ai xoá 703 account cùng lúc bằng tay.
     */
    const r = xoaAnToan(703, 0);
    assert.equal(r.choPhep, false);
    assert.match(r.lyDo ?? '', /rỗng|0/i);
  });

  test('mất quá nửa pool trong một nhịp → TỪ CHỐI', () => {
    // CSV ghi dở (đĩa đầy giữa writeFileSync) cũng cho ra kết quả cụt như vậy.
    const r = xoaAnToan(703, 300);
    assert.equal(r.choPhep, false);
  });

  test('mất đúng dưới ngưỡng → cho qua', () => {
    const r = xoaAnToan(100, 51);
    assert.equal(r.choPhep, true);
  });

  test('pool đang rỗng (lúc khởi động) → luôn cho qua', () => {
    /**
     * Boot lần đầu: pool rỗng, CSV cũng có thể rỗng. Chặn ở đây thì server không bao giờ
     * nạp được account nào — chốt an toàn không được cản đường đi bình thường.
     */
    assert.equal(xoaAnToan(0, 0).choPhep, true);
    assert.equal(xoaAnToan(0, 703).choPhep, true);
  });

  test('pool nhỏ → không áp ngưỡng phần trăm', () => {
    /**
     * Với 2 account, xoá 1 cái là 50% — nhưng đó là thao tác tay hoàn toàn bình thường.
     * Ngưỡng phần trăm chỉ có nghĩa khi pool đủ lớn để "mất hàng loạt" là bất thường.
     */
    assert.equal(xoaAnToan(2, 1).choPhep, true);
    assert.equal(xoaAnToan(5, 2).choPhep, true);
  });

  test('lý do phải nói rõ số liệu để người đọc log hiểu ngay', () => {
    const r = xoaAnToan(703, 0);
    assert.match(r.lyDo ?? '', /703/, 'phải có số account đang giữ');
  });
});
