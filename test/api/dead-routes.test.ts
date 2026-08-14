import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Endpoint đã XOÁ vì không còn ai gọi — chốt lại để không bị thêm về.
 *
 * Cách xác định "không ai gọi": grep đường dẫn trong `web/src/`, `bin/agyproxy.mjs`,
 * `src/mcp/` và `test/`. Chỉ xoá cái ra 0 hit ở CẢ BỐN nơi.
 *
 * Bẫy đã tránh: `/api/settings` trông như mồ côi nếu chỉ grep `web/src/` (dashboard không
 * gọi), nhưng CLI `agyproxy model --big/--small` dùng nó (`bin/agyproxy.mjs:771`). Grep
 * thiếu một nơi là xoá nhầm thứ đang chạy.
 */

const ROOT = resolve(import.meta.dirname, '../..');

function code(f: string): string {
  return readFileSync(resolve(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** File khai báo route của backend. */
const NGUON = ['src/routes.ts', 'src/gateway/admin.ts', 'src/gateway/adminTest.ts'];

describe('endpoint mồ côi đã được xoá', () => {
  const daXoa: Array<[string, string]> = [
    ['/api/summary', 'đã bị /api/overview thay thế'],
    ['/api/config', 'đường ghi config thứ ba, 0 caller'],
    ['/api/run-pipeline', 'UI chỉ dùng /api/run và /api/auto-run'],
    ['/api/export/antigravity', 'không có trang nào gọi'],
    ['/api/export/kiro', 'không có trang nào gọi'],
    ['/api/export/accounts', 'không có trang nào gọi'],
  ];

  for (const [duong, vi] of daXoa) {
    test(`${duong} không còn được đăng ký (${vi})`, () => {
      for (const f of NGUON) {
        const s = code(f);
        // Khớp đúng chuỗi trong lời gọi app.get/post/... để không bắt nhầm comment hay
        // đường dẫn dài hơn (`/api/config` vs `/api/gateway/config`).
        const re = new RegExp(`app\\.(get|post|patch|delete)\\('${duong.replace(/\//g, '\\/')}'`);
        assert.doesNotMatch(s, re, `${f} còn đăng ký ${duong}`);
      }
    });
  }

  test('test-bulk (alias của /check) đã gỡ', () => {
    assert.doesNotMatch(code('src/gateway/adminTest.ts'), /accounts\/test-bulk/);
  });
});

describe('endpoint CÒN DÙNG không được xoá nhầm', () => {
  /**
   * Hai đường này chỉ có CLI hoặc MCP gọi, không có dashboard — dễ bị coi là mồ côi.
   */
  const phaiCon: Array<[string, string, string]> = [
    ['/api/settings', 'src/routes.ts', 'CLI: agyproxy model --big/--small'],
    ['/api/overview', 'src/routes.ts', 'dashboard Tổng quan + MCP'],
  ];

  for (const [duong, f, ai] of phaiCon) {
    test(`${duong} vẫn còn (${ai})`, () => {
      assert.match(code(f), new RegExp(`app\\.(get|post|patch)\\('${duong.replace(/\//g, '\\/')}'`));
    });
  }

  test('/api/gateway/accounts/wake vẫn còn — CLI dùng', () => {
    assert.match(code('src/gateway/admin.ts'), /accounts\/wake/);
  });
});

describe('tàn dư OmniRoute đã dọn', () => {
  test('không còn biến môi trường OMNIROUTE_*', () => {
    /**
     * OmniRoute đã gỡ khỏi code nhưng biến môi trường còn nằm lại trong `.env.example` và
     * `docker-compose.yml` — người đọc tưởng vẫn phải cấu hình nó.
     */
    for (const f of ['.env.example', 'docker-compose.yml']) {
      let s = '';
      try { s = readFileSync(resolve(ROOT, f), 'utf8'); } catch { continue; }
      assert.doesNotMatch(s, /OMNIROUTE_URL|OMNIROUTE_PASSWORD/, `${f} còn biến OmniRoute`);
    }
  });

  test('/api/summary — nơi chứa hai trường OmniRoute chết — đã xoá', () => {
    // `connectionCount = 0` và `omniOk = false` chỉ tồn tại để "client cũ đọc không vỡ",
    // mà không còn client nào.
    assert.doesNotMatch(code('src/routes.ts'), /const omniOk/);
  });
});
