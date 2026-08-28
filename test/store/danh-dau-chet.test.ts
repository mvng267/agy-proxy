import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { danhDauChet, docKhoang, LY_DO_XOA } from '../../src/store/danhDauChet.js';
import type { Account } from '../../src/store/models.js';

function acc(p: Partial<Account> = {}): Account {
  return {
    email: 'a@b.c', password: '', totp_secret: '', proxy: '', profile_dir: '', tz: '', locale: '',
    status_google: 'new', status_gweb: 'new', status_agy: 'failed', status_agycli: 'new',
    status_gcli: 'new', status_kiro: 'failed', status_nous: 'new',
    last_run: '', note: '', fingerprint: '',
    ...p,
  } as Account;
}

describe('danhDauChet', () => {
  test('đặt agy+kiro về needs_human và ghi lý do', () => {
    const r = danhDauChet(acc(), LY_DO_XOA);
    assert.ok(r);
    assert.equal(r.status_agy, 'needs_human');
    assert.equal(r.status_kiro, 'needs_human');
    assert.equal(r.note, LY_DO_XOA);
  });

  /**
   * Flow chưa từng chạy phải ở nguyên 'new'. Đánh dấu cả google/gweb/gcli làm
   * `/api/health` dựng lên ba provider "total 47" như thể có dùng — đã gây đúng chuyện đó.
   */
  test('không đụng flow chưa dùng', () => {
    const r = danhDauChet(acc(), LY_DO_XOA);
    assert.ok(r);
    assert.equal(r.status_google, 'new');
    assert.equal(r.status_gcli, 'new');
    assert.equal(r.status_nous, 'new');
  });

  test('gỡ dấu thừa ở flow không dùng', () => {
    const r = danhDauChet(acc({ status_gcli: 'needs_human' }), LY_DO_XOA);
    assert.ok(r);
    assert.equal(r.status_gcli, 'new', 'dấu lỡ đặt lần trước phải được gỡ');
    assert.equal(r.status_agy, 'needs_human');
  });

  test('không đụng account gốc', () => {
    const goc = acc();
    danhDauChet(goc, LY_DO_XOA);
    assert.equal(goc.status_agy, 'failed', 'phải trả bản sao, không sửa tại chỗ');
  });

  /**
   * Mốc quan trọng nhất: chạy lại lệnh không được ghi CSV lần nữa. Mỗi lần ghi accounts.csv
   * là một lần đua ghi đè với tiến trình khác — đã mất account 1-3 đúng theo cách đó.
   */
  test('lần hai trả null — không ghi lại', () => {
    const lan1 = danhDauChet(acc(), LY_DO_XOA);
    assert.ok(lan1);
    assert.equal(danhDauChet(lan1, LY_DO_XOA), null);
  });

  test('chỉ đánh dấu flow được chỉ định', () => {
    const r = danhDauChet(acc(), LY_DO_XOA, ['agy']);
    assert.ok(r);
    assert.equal(r.status_agy, 'needs_human');
    assert.equal(r.status_kiro, 'failed', 'kiro không nằm trong danh sách thì giữ nguyên');
  });
});

describe('docKhoang', () => {
  test('số lẻ, khoảng, và danh sách trộn', () => {
    assert.deepEqual(docKhoang('56'), [56]);
    assert.deepEqual(docKhoang('3-6'), [3, 4, 5, 6]);
    assert.deepEqual(docKhoang('56,300-302'), [56, 300, 301, 302]);
  });

  test('300-346 đúng 47 số', () => {
    assert.equal(docKhoang('300-346').length, 47);
  });

  test('từ chối chuỗi hỏng và khoảng ngược', () => {
    assert.throws(() => docKhoang('abc'));
    assert.throws(() => docKhoang('10-3'));
  });
});
