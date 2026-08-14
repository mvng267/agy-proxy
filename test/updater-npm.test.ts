import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { kieuCaiDat, coBanMoi } from '../src/updater.js';

/**
 * Bản cài bằng `npm i -g` cũng phải tự cập nhật được từ dashboard.
 *
 * Bản trước: `canSelfUpdate = isGitCheckout()` = `existsSync(ROOT/.git)`. Gói npm không
 * có `.git`, nên `canSelfUpdate` luôn false → `UpdatePanel` ẩn nút Cập nhật
 * (`UpdatePanel.tsx:116`) và chỉ hiện dòng chữ "chạy `agyproxy update` trên máy chủ".
 *
 * Nghĩa là publish npm xong thì mọi máy cài theo cách đó MẤT nút cập nhật — đúng thứ
 * người dùng muốn có. Hai kiểu cài cần hai cách cập nhật khác nhau, không phải một cách
 * và một lời từ chối:
 *
 *   git checkout  →  git pull --ff-only + npm install + build web
 *   npm global    →  npm i -g agy-proxy@latest
 *
 * Dữ liệu KHÔNG bị ảnh hưởng ở cả hai: `AGY_HOME` mặc định là `~/.agyproxy`, tách hẳn
 * khỏi thư mục mã (`paths.ts`). Cập nhật mã không đụng credentials.csv / state.db.
 */

describe('kieuCaiDat — nhận ra mình được cài kiểu gì', () => {
  test('thư mục có .git → "git"', () => {
    // Chính repo này.
    assert.equal(kieuCaiDat(resolve(import.meta.dirname, '..')), 'git');
  });

  test('thư mục không có .git → "npm"', () => {
    assert.equal(kieuCaiDat('/tmp'), 'npm');
  });
});

describe('cả hai kiểu cài đều tự cập nhật được', () => {
  test('bản npm KHÔNG bị coi là "không tự cập nhật được"', () => {
    /**
     * Đây là điểm chốt. Trước đây gói npm rơi thẳng vào nhánh từ chối:
     *   push({ step:'kiểm tra', ok:false, detail:'không phải bản cài từ git…' })
     */
    const src = readFileSync(resolve(import.meta.dirname, '../src/updater.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    assert.doesNotMatch(
      src,
      /canSelfUpdate:\s*isGitCheckout\(\)/,
      'canSelfUpdate không được buộc vào việc có .git',
    );
    assert.match(src, /npm.*install.*-g|['"]-g['"]/, 'phải có nhánh cập nhật bằng npm -g');
  });

  test('nhánh npm cài thẳng từ GitHub, KHÔNG qua registry', () => {
    /**
     * Gói này không publish lên npm công khai — nó quản lý 700 account, và npm không cho
     * xoá bản đã publish. `github:owner/repo` lấy đúng nhánh main, không cần registry.
     */
    const src = readFileSync(resolve(import.meta.dirname, '../src/updater.ts'), 'utf8');
    assert.match(src, /github:\$\{REPO\}|github:mvng267\/agy-proxy/, 'phải cài từ github:');
  });

  test('npm KHÔNG chạy bên trong chính thư mục nó sắp ghi đè', () => {
    // `npm i -g` ghi đè lên ROOT — chạy npm với cwd=ROOT là tự rút thảm dưới chân.
    const src = readFileSync(resolve(import.meta.dirname, '../src/updater.ts'), 'utf8');
    const i = src.indexOf('capNhatNpm');
    const than = src.slice(i, i + 1400);
    assert.match(than, /cwd:\s*homedir\(\)/, 'phải đặt cwd ngoài ROOT');
  });
});

describe('so sánh phiên bản vẫn đúng cho bản npm', () => {
  test('bản npm không có SHA → so bằng VERSION', () => {
    /**
     * Gói npm không có git nên `localSha` là null. Khi đó phải quay về so version —
     * không thì bản npm không bao giờ biết có bản mới.
     */
    assert.equal(
      coBanMoi({ localSha: null, remoteSha: 'bbb222', localVersion: '2.19.0', remoteVersion: '2.20.0' }),
      true,
    );
    assert.equal(
      coBanMoi({ localSha: null, remoteSha: 'bbb222', localVersion: '2.19.0', remoteVersion: '2.19.0' }),
      false,
    );
  });

  test('bản git vẫn so bằng COMMIT (không thoái lui)', () => {
    // Giữ nguyên hành vi đã sửa: cùng version mà khác commit thì vẫn là có bản mới.
    assert.equal(
      coBanMoi({ localSha: 'aaa111', remoteSha: 'bbb222', localVersion: '2.19.0', remoteVersion: '2.19.0', behind: 3 }),
      true,
    );
  });
});
