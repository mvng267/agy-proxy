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
