import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findKiroConnectionByIdentity } from './kiroConnectionIdentity.ts';
import { findKiroConnectionByIdentity as goc } from './kiroConnectionIdentity.goc.ts';

/**
 * Kiro free-tier cấp CHUNG một profileArn cho mọi tài khoản Google.
 * Đo thật trên 20 tài khoản @luongthevinhhp.edu.vn: 20 refreshToken khác nhau,
 * nhưng profileArn giống hệt nhau 20/20.
 */
const ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK';

const conn = (id: string, refreshToken: string) => ({
  id,
  authType: 'oauth',
  refreshToken,
  providerSpecificData: { profileArn: ARN, authMethod: 'imported' },
});

describe('bản gốc — tái hiện đúng lỗi đã gặp', () => {
  test('tài khoản thứ hai bị nhận nhầm là tài khoản thứ nhất', () => {
    const db = [conn('acc-1', 'aorAAAA-token-cua-account-1')];
    const trung = goc(db, { authType: 'oauth', profileArn: ARN });
    assert.equal(trung?.id, 'acc-1', 'ARN dùng chung khiến account 2 khớp nhầm sang hàng của account 1');
  });
});

describe('bản vá — dedupe theo refreshToken', () => {
  test('tài khoản MỚI (token khác) không khớp hàng cũ', () => {
    const db = [conn('acc-1', 'aorAAAA-token-cua-account-1')];
    const kq = findKiroConnectionByIdentity(db, {
      authType: 'oauth',
      refreshToken: 'aorAAAA-token-cua-account-2',
      profileArn: ARN,
    });
    assert.equal(kq, null, 'token khác ⇒ tài khoản khác ⇒ phải tạo hàng mới');
  });

  test('CÙNG tài khoản (cùng token) vẫn khớp hàng cũ — không tạo bản trùng', () => {
    const db = [conn('acc-1', 'aorAAAA-token-cua-account-1')];
    const kq = findKiroConnectionByIdentity(db, {
      authType: 'oauth',
      refreshToken: 'aorAAAA-token-cua-account-1',
      profileArn: ARN,
    });
    assert.equal(kq?.id, 'acc-1', 'import lại cùng token phải là CẬP NHẬT, không phải thêm mới');
  });

  test('đọc được token nằm trong providerSpecificData', () => {
    // Hàng cũ có thể lưu token ở đó thay vì cột ngoài — không được bỏ sót, kẻo sinh bản trùng.
    const db = [{
      id: 'acc-x', authType: 'oauth',
      providerSpecificData: { profileArn: ARN, refreshToken: 'aorAAAA-nam-trong-psd' },
    }];
    const kq = findKiroConnectionByIdentity(db, { authType: 'oauth', refreshToken: 'aorAAAA-nam-trong-psd' });
    assert.equal(kq?.id, 'acc-x');
  });

  test('20 tài khoản chung ARN ⇒ 20 hàng riêng (đúng ca thật)', () => {
    const dbase: ReturnType<typeof conn>[] = [];
    for (let i = 1; i <= 20; i++) {
      const rt = `aorAAAA-token-${i}`;
      const cu = findKiroConnectionByIdentity(dbase, { authType: 'oauth', refreshToken: rt, profileArn: ARN });
      if (!cu) dbase.push(conn(`acc-${i}`, rt));
    }
    assert.equal(dbase.length, 20, 'phải giữ đủ 20, không gộp thành 1');
  });

  test('KHÔNG có refreshToken → giữ nguyên hành vi cũ (khớp theo ARN)', () => {
    // Đường nhập cũ không gửi token thì vẫn phải chạy như trước, không được vỡ.
    const db = [conn('acc-1', 'aorAAAA-token-cua-account-1')];
    const kq = findKiroConnectionByIdentity(db, { authType: 'oauth', profileArn: ARN });
    assert.equal(kq?.id, 'acc-1');
  });
});
