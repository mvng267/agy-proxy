import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Refresh token XOAY VÒNG phải được ghi xuống đĩa — mọi provider, không riêng Nous.
 *
 * Nous đã có cơ chế này (`setNousRotateHook`) sau sự cố 12/08/2026: token xoay mà chỉ giữ
 * trong RAM thì restart là mất, Portal trả `invalid_grant: Refresh token reuse detected`,
 * account chết vĩnh viễn.
 *
 * Kiro có ĐÚNG cùng vấn đề mà không có cơ chế đó. `providers/kiro.ts` gán token mới vào
 * RAM, nhưng:
 *   - `pool.toPersist()` không lưu `refreshToken`
 *   - `pool.upsert()` mỗi nhịp sync 2 giây ghi đè `cur.refreshToken` bằng bản từ CSV
 * → token mới sống nhiều nhất 2 giây.
 *
 * MỨC ĐỘ THẬT (đo trên production, không suy đoán): log có 0 dòng `invalid_grant` /
 * `refresh_failed`, 315/351 account Kiro vẫn `alive`. Kiro KHÔNG xoay token trong thực tế
 * — nếu có, pool đã chết sạch từ lâu. Đây là mìn chưa nổ, và giá để gỡ là vài dòng.
 *
 * Đây cũng là dạng lỗi lặp lại nhiều lần trong repo: sửa đúng một nhánh, bỏ sót nhánh song
 * song (Nous có hook / Kiro không; endpoint sweep có khoá / vòng nền không; `testAccount`
 * dùng `isPermanentAuthError` / `checkLiveAccount` không).
 */

const ROOT = resolve(import.meta.dirname, '../..');

/** Bỏ comment trước khi soi — chính lời giải thích cũng nhắc tên những thứ này. */
function code(f: string): string {
  return readFileSync(resolve(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('hook lưu token xoay vòng là CHUNG, không riêng của Nous', () => {
  test('có hook chung đặt tên theo chức năng, không theo provider', () => {
    /**
     * `setNousRotateHook` mang tên một provider trong khi việc nó làm (ghi credential
     * xuống đĩa) đúng với mọi provider. Provider thứ 5 sẽ lại phải tự nhớ ra điều này.
     *
     * Hook nằm ở `types.ts` — file duy nhất trong `providers/` mà mọi provider đã import
     * sẵn, và không import gì ngược lại (quy tắc chống vòng lặp module).
     */
    const s = code('src/gateway/providers/types.ts');
    assert.match(s, /export function setRotateHook/, 'types.ts phải export hook chung');
    assert.match(s, /export function luuTokenXoay/, 'phải có hàm provider gọi khi token xoay');
  });

  test('hook lộ ra ngoài qua providers/index.js', () => {
    // pool import từ `./providers/index.js`; `export *` phải mang hook theo.
    const s = code('src/gateway/providers/index.ts');
    assert.match(s, /export \* from '\.\/types\.js'/);
  });

  test('Kiro gọi hook khi refresh token đổi', () => {
    const s = code('src/gateway/providers/kiro.ts');
    assert.match(s, /luuTokenXoay|onRotate/, 'kiro.ts phải báo lên khi token xoay');
  });

  test('Nous vẫn gọi hook (không làm hỏng đường đã chạy)', () => {
    const s = code('src/gateway/providers/nous.ts');
    assert.match(s, /luuTokenXoay|onRotate/);
  });

  test('pool cắm hook CHUNG, không phải hook riêng Nous', () => {
    const s = code('src/gateway/pool.ts');
    assert.match(s, /setRotateHook/, 'pool phải cắm hook chung');
    assert.doesNotMatch(s, /setNousRotateHook/, 'không còn hook riêng tên Nous');
  });
});

describe('Kiro ghi credential đúng định dạng đọc lại được', () => {
  test('kiro.ts cập nhật a.credential chứ không chỉ a.refreshToken', () => {
    /**
     * Đây là điểm dễ sót nhất. `pool.upsert()` ghi đè `refreshToken` từ CSV mỗi 2 giây, nên
     * chỉ gán `a.refreshToken` là vô nghĩa — phải cập nhật cả `a.credential` (thứ được ghi
     * xuống CSV) rồi báo hook.
     */
    const s = code('src/gateway/providers/kiro.ts');
    assert.match(s, /a\.credential\s*=/, 'phải cập nhật a.credential để ghi xuống CSV');
  });

  test('credential mới giữ nguyên các trường Kiro cần (không mất profileArn/region)', () => {
    /**
     * Credential Kiro là JSON nhiều trường. Ghi đè bằng `{refreshToken}` trần là mất
     * `profileArn`/`region` — account vẫn refresh được nhưng gọi model thì hỏng.
     */
    const s = code('src/gateway/providers/kiro.ts');
    const i = s.indexOf('a.credential =');
    assert.ok(i > 0);
    const doan = s.slice(i, i + 300);
    assert.match(doan, /\.\.\.|parse/, 'phải giữ các trường cũ, không ghi đè bằng object trần');
  });
});
