import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { moProfile, dongPhien, dsPhienMo, type PhuThuoc } from '../../src/browser/moTay.js';
import type { Account } from '../../src/store/models.js';

/**
 * Mở profile Chrome lên màn hình để thao tác tay (nút "Mở Chrome" ở trang Accounts).
 *
 * Ba tính chất phải giữ, mỗi cái từng gây sự cố thật trong dự án này:
 *
 * 1. Không có màn hình thì báo lý do, đừng để Playwright ném lỗi khó hiểu — đúng bài học
 *    của `test/flows/no-display.test.ts` (Debian không chạy X, log chôn mất nguyên nhân).
 * 2. Mỗi account tối đa MỘT cửa sổ — hai context cùng ghi một userDataDir làm hỏng profile,
 *    mà profile hỏng thì login fail với ô mật khẩu trống, rất khó chẩn đoán.
 * 3. Người dùng tự tắt cửa sổ thì phải quên nó đi, không thì bấm lần sau không mở lại được.
 */

const ROOT = resolve(import.meta.dirname, '../..');

const ACC = { email: 'a@x.vn', profile_dir: 'a_x', proxy: '' } as Account;

/** Phụ thuộc giả — đếm số lần mở, giữ handler close để giả lập người dùng tắt cửa sổ. */
function gia(opts: { coAccount?: boolean; moLoi?: string; coManHinh?: boolean } = {}) {
  const { coAccount = true, moLoi, coManHinh = true } = opts;
  const dongHandlers: Array<() => void> = [];
  let soLanMo = 0;

  const pt: PhuThuoc = {
    layAccount: (email) => (coAccount ? { ...ACC, email } : undefined),
    layProxy: () => undefined,
    coManHinh: () => coManHinh,
    mo: async () => {
      soLanMo++;
      if (moLoi) throw new Error(moLoi);
      return {
        context: {
          on: (ev: string, fn: () => void) => {
            if (ev === 'close') dongHandlers.push(fn);
          },
          close: async () => {},
        } as never,
      };
    },
  };

  return { pt, soLanMo: () => soLanMo, tatCuaSo: () => dongHandlers.forEach((f) => f()) };
}

/** Map phiên là module-level nên mỗi test phải tự dọn, tránh rò trạng thái sang test sau. */
async function don() {
  for (const { email } of dsPhienMo()) await dongPhien(email);
}

describe('mở profile tay — hành vi', () => {
  beforeEach(don);

  test('máy không có màn hình → báo lý do, không mở gì', async () => {
    const { pt, soLanMo } = gia({ coManHinh: false });
    const kq = await moProfile('a@x.vn', pt);

    assert.equal(kq.ok, false);
    assert.match(kq.loi!, /màn hình/, 'phải nói rõ máy thiếu gì');
    assert.equal(soLanMo(), 0, 'không được thử mở khi biết chắc sẽ hỏng');
  });

  test('account không tồn tại → báo lỗi, không mở gì', async () => {
    const { pt, soLanMo } = gia({ coAccount: false });
    const kq = await moProfile('khong-co@x.vn', pt);

    assert.equal(kq.ok, false);
    assert.match(kq.loi!, /không có account/);
    assert.equal(soLanMo(), 0);
  });

  test('bấm hai lần chỉ mở một cửa sổ', async () => {
    const { pt, soLanMo } = gia();
    const a = await moProfile('a@x.vn', pt);
    const b = await moProfile('a@x.vn', pt);

    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(b.daMoTruoc, true, 'lần hai phải báo là đã mở trước');
    assert.equal(soLanMo(), 1, 'hai context cùng userDataDir sẽ làm hỏng profile');
  });

  test('hai account khác nhau mở được đồng thời', async () => {
    const { pt, soLanMo } = gia();
    await moProfile('a@x.vn', pt);
    await moProfile('b@x.vn', pt);

    assert.equal(soLanMo(), 2);
    assert.equal(dsPhienMo().length, 2);
  });

  test('tắt cửa sổ tay rồi bấm lại thì mở lại được', async () => {
    const { pt, soLanMo, tatCuaSo } = gia();
    await moProfile('a@x.vn', pt);
    assert.equal(dsPhienMo().length, 1);

    tatCuaSo();
    assert.equal(dsPhienMo().length, 0, 'phải quên phiên khi cửa sổ đóng');

    await moProfile('a@x.vn', pt);
    assert.equal(soLanMo(), 2, 'phải mở lại được sau khi người dùng tắt tay');
  });

  test('lỗi khi mở → trả lý do, không kẹt lại trong danh sách', async () => {
    const { pt } = gia({ moLoi: 'Chrome không khởi động được' });
    const kq = await moProfile('a@x.vn', pt);

    assert.equal(kq.ok, false);
    assert.match(kq.loi!, /Chrome không khởi động được/);
    // Nếu kẹt lại, lần bấm sau sẽ tưởng đang mở và không thử lại nữa.
    assert.equal(dsPhienMo().length, 0);
  });

  test('đóng phiên: có thì true, không có thì false — không ném', async () => {
    const { pt } = gia();
    assert.equal(await dongPhien('chua-mo@x.vn'), false);

    await moProfile('a@x.vn', pt);
    assert.equal(await dongPhien('a@x.vn'), true);
    assert.equal(dsPhienMo().length, 0);
  });
});

describe('mở profile tay — đọc mã nguồn', () => {
  const SRC = readFileSync(resolve(ROOT, 'src/browser/moTay.ts'), 'utf8');

  test('nhận biết màn hình qua DISPLAY / WAYLAND_DISPLAY', () => {
    // Chrome đọc biến môi trường, không đọc socket — kiểm /tmp/.X11-unix là sai hướng.
    const fn = SRC.slice(SRC.indexOf('function coManHinh()'), SRC.indexOf('export function dsPhienMo'));
    assert.match(fn, /process\.env\.DISPLAY/);
    assert.match(fn, /WAYLAND_DISPLAY/);
    assert.match(fn, /darwin|win32/, 'macOS/Windows luôn mở được cửa sổ');
  });

  test('mặc định mở headful — đây là cả mục đích của hàm', () => {
    // openProfile(account, proxy, headless) — tham số thứ ba phải là false.
    assert.match(SRC, /openProfile\(acc, proxy, false\)/);
  });

  test('lắng nghe close để quên phiên', () => {
    assert.match(SRC, /context\.on\('close'/);
  });
});

describe('route mở profile', () => {
  const SRC = readFileSync(resolve(ROOT, 'src/routes.ts'), 'utf8');

  test('có đủ ba route và đã giải mã email', () => {
    // Email chứa '@' và '.', phải encode ở URL nên server phải decode lại.
    for (const r of ['mo-profile', 'dong-profile']) {
      assert.match(SRC, new RegExp(`/api/accounts/:email/${r}`), `thiếu route ${r}`);
    }
    assert.match(SRC, /\/api\/profiles-dang-mo/);

    const i = SRC.indexOf("/api/accounts/:email/mo-profile");
    assert.match(SRC.slice(i, i + 300), /decodeURIComponent\(email\)/);
  });
});
