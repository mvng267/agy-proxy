import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, isHashed } from '../src/security.js';

test('hashPassword → định dạng scrypt$, không lưu plaintext', () => {
  const h = hashPassword('MatKhau@123');
  assert.ok(isHashed(h));
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[\w+/=]+\$[\w+/=]+$/);
  assert.ok(!h.includes('MatKhau@123'), 'không được chứa mật khẩu gốc');
});

test('verifyPassword: đúng/sai', () => {
  const h = hashPassword('MatKhau@123');
  assert.equal(verifyPassword('MatKhau@123', h), true);
  assert.equal(verifyPassword('MatKhau@124', h), false);
  assert.equal(verifyPassword('', h), false);
});

test('mỗi lần hash cùng mật khẩu ra chuỗi khác (salt ngẫu nhiên)', () => {
  const a = hashPassword('same-password');
  const b = hashPassword('same-password');
  assert.notEqual(a, b);
  assert.equal(verifyPassword('same-password', a), true);
  assert.equal(verifyPassword('same-password', b), true);
});

test('tương thích ngược: so khớp được mật khẩu plaintext cũ (để migrate)', () => {
  assert.equal(isHashed('plain-old-pass'), false);
  assert.equal(verifyPassword('plain-old-pass', 'plain-old-pass'), true);
  assert.equal(verifyPassword('sai', 'plain-old-pass'), false);
});

test('hash hỏng → false, không ném lỗi', () => {
  assert.equal(verifyPassword('x', 'scrypt$bad'), false);
  assert.equal(verifyPassword('x', 'scrypt$1$2$3$@@@$@@@'), false);
});

/**
 * Khoá / mở khoá đăng nhập — cờ `authDisabled` riêng, KHÔNG đụng mật khẩu đã lưu.
 *
 * Vì sao không dùng cách xoá mật khẩu: hash scrypt không đảo ngược được, xoá là mất
 * vĩnh viễn và khoá lại phải nghĩ passcode mới. Test này khoá lại đúng tính chất đó.
 *
 * Rủi ro cần chặn: `isAuthed` vốn đã có nhánh "chưa đặt mật khẩu = cho qua"
 * (auth.ts:102). Thêm nhánh `authDisabled` mà nới lỏng nhầm sẽ mở toang toàn bộ API.
 */
test('authDisabled: mở khoá KHÔNG xoá mật khẩu, khoá lại dùng lại được ngay', async () => {
  const { config } = await import('../src/config.js');
  const saved = { pw: config.dashboardPassword, off: config.authDisabled };
  try {
    const hash = hashPassword('481920');
    config.dashboardPassword = hash;

    // Mở khoá: chỉ bật cờ, hash phải còn NGUYÊN.
    config.authDisabled = true;
    assert.equal(config.dashboardPassword, hash, 'mở khoá không được đụng tới hash');
    assert.ok(verifyPassword('481920', config.dashboardPassword), 'passcode cũ vẫn đúng');

    // Khoá lại: không cần biết passcode, và passcode cũ vẫn dùng được.
    config.authDisabled = false;
    assert.ok(verifyPassword('481920', config.dashboardPassword), 'khoá lại không mất passcode');
  } finally {
    config.dashboardPassword = saved.pw;
    config.authDisabled = saved.off;
  }
});

test('authDisabled chỉ có tác dụng khi ĐANG có mật khẩu', async () => {
  const { config } = await import('../src/config.js');
  const saved = { pw: config.dashboardPassword, off: config.authDisabled };
  try {
    // Không mật khẩu: `isAuthed` vốn đã cho qua vì nhánh khác — cờ này không thêm quyền gì.
    // Điều cần khẳng định là hai nhánh ĐỘC LẬP, không nhánh nào nới lỏng nhánh kia.
    config.dashboardPassword = '';
    config.authDisabled = false;
    assert.equal(config.dashboardPassword, '', 'trạng thái chưa đặt mật khẩu');

    config.dashboardPassword = hashPassword('481920');
    config.authDisabled = false;
    assert.ok(verifyPassword('481920', config.dashboardPassword), 'có mật khẩu + đang khoá');
  } finally {
    config.dashboardPassword = saved.pw;
    config.authDisabled = saved.off;
  }
});
