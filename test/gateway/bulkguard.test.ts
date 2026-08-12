import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mucTieuBulk } from '../../src/gateway/poolScore.js';

/**
 * Thao tác hàng loạt: mặc định "cả pool" là quá nguy hiểm để ngầm định.
 *
 * `POST /api/gateway/accounts/bulk` hiện có:
 *
 *   const list = emails && emails.length ? emails : pool.list().map((a) => a.email);
 *   ...
 *   a.enabled = !!enabled;
 *
 * Body rỗng `{}` → `enabled` là `undefined` → `!!undefined` = `false` cho TOÀN BỘ 703
 * account. Không xác nhận, không dry-run, không ghi ai làm. Một request lạc là cả pool tắt.
 *
 * Frontend CÓ dùng dạng "không emails = tất cả" một cách cố ý (toast ghi "tất cả"), nên
 * không bỏ được tính năng — chỉ bắt nói rõ ý định bằng cờ `all: true`.
 */

describe('mucTieuBulk — không bao giờ ngầm hiểu "cả pool"', () => {
  test('có emails → dùng đúng danh sách đó', () => {
    const r = mucTieuBulk(['a@t', 'b@t'], false, ['a@t', 'b@t', 'c@t']);
    assert.deepEqual(r.keys, ['a@t', 'b@t']);
  });

  test('không emails, không cờ all → TỪ CHỐI', () => {
    // Đây là body `{}` — request lạc, hoặc client cũ quên trường.
    const r = mucTieuBulk(undefined, false, ['a@t', 'b@t']);
    assert.equal(r.keys.length, 0);
    assert.ok(r.loi, 'phải trả lý do từ chối');
  });

  test('không emails NHƯNG có all:true → cho phép cả pool', () => {
    // Người dùng bấm "Tắt tất cả" thật — hợp lệ, chỉ cần nói rõ.
    const r = mucTieuBulk(undefined, true, ['a@t', 'b@t']);
    assert.deepEqual(r.keys, ['a@t', 'b@t']);
    assert.equal(r.loi, undefined);
  });

  test('emails rỗng + all:true → vẫn là cả pool', () => {
    const r = mucTieuBulk([], true, ['a@t']);
    assert.deepEqual(r.keys, ['a@t']);
  });

  test('emails rỗng, không all → từ chối', () => {
    assert.ok(mucTieuBulk([], false, ['a@t']).loi);
  });
});

const ROOT = resolve(import.meta.dirname, '../..');
function code(f: string): string {
  return readFileSync(resolve(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('bulk phải chạm được account của MỌI provider', () => {
  test('không còn hard-code provider agy khi tra account', () => {
    /**
     * `pool.get(e, 'agy')` hard-code provider. Danh sách ở trên lấy `a.email` (không có
     * prefix), nên với 351 email có CẢ HAI provider, thao tác luôn trúng bản `agy` và
     * KHÔNG BAO GIỜ đụng được account Kiro.
     *
     * Người dùng bấm "tắt hết", thấy báo thành công, rồi 351 account Kiro vẫn chạy.
     */
    const s = code('src/gateway/admin.ts');
    const i = s.indexOf("app.post('/api/gateway/accounts/bulk'");
    assert.ok(i > 0, 'không tìm thấy endpoint bulk');
    const than = s.slice(i, i + 900);
    assert.doesNotMatch(than, /pool\.get\([^)]*'agy'\)/, "bulk còn hard-code provider 'agy'");
  });

  test('bulk dùng KHOÁ GHÉP provider:email để không nhập nhằng', () => {
    // 147 email Kiro trùng email Antigravity — email trần không đủ để định danh.
    const s = code('src/gateway/admin.ts');
    const i = s.indexOf("app.post('/api/gateway/accounts/bulk'");
    const than = s.slice(i, i + 900);
    assert.match(than, /\.key/, 'phải dùng key ghép, không phải email trần');
  });
});

describe('frontend gửi cờ all khi thật sự muốn cả pool', () => {
  test('Pool.tsx gửi all:true thay vì bỏ trống emails', () => {
    const s = code('web/src/components/pages/Pool.tsx');
    assert.match(s, /all:\s*true|\.all\s*=\s*true/, 'Pool.tsx phải nói rõ ý định "cả pool"');
  });
});
