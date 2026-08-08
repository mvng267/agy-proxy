import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cmpVersion, isGitCheckout, checkUpdate } from '../src/updater.js';

describe('cmpVersion', () => {
  test('so sánh đúng theo từng thành phần, không so chuỗi', () => {
    // So chuỗi thì '2.9.0' > '2.10.0' — lỗi kinh điển khiến bản mới không được nhận ra.
    assert.ok(cmpVersion('2.10.0', '2.9.0') > 0);
    assert.ok(cmpVersion('2.15.1', '2.15.0') > 0);
    assert.equal(cmpVersion('2.15.0', '2.15.0'), 0);
    assert.ok(cmpVersion('2.15.0', '3.0.0') < 0);
  });

  test('thiếu thành phần coi như 0', () => {
    assert.equal(cmpVersion('2.15', '2.15.0'), 0);
    assert.ok(cmpVersion('2.15.1', '2.15') > 0);
  });
});

describe('checkUpdate', () => {
  test('luôn trả về phiên bản hiện tại, kể cả khi mất mạng', async () => {
    const r = await checkUpdate();
    assert.match(r.current, /^\d+\.\d+\.\d+$/, 'current phải là semver đọc từ package.json');
    // latest có thể null nếu GitHub không tới được — nhưng KHÔNG được ném, vì
    // dashboard gọi endpoint này mỗi lần mở trang Cấu hình.
    assert.ok(r.latest === null || /^\d+\.\d+\.\d+$/.test(r.latest));
    if (r.latest === null) assert.ok(r.error, 'không lấy được latest thì phải nói lý do');
    assert.equal(typeof r.canSelfUpdate, 'boolean');
  });

  test('hasUpdate chỉ true khi remote THỰC SỰ mới hơn', async () => {
    const r = await checkUpdate();
    if (r.latest) assert.equal(r.hasUpdate, cmpVersion(r.latest, r.current) > 0);
    else assert.equal(r.hasUpdate, false, 'không biết latest thì không được báo có bản mới');
  });

  test('repo này là git checkout nên tự cập nhật được', () => {
    assert.equal(isGitCheckout(), true);
  });
});
