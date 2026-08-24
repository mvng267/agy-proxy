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

/**
 * OmniRoute đưa lại 23/08 (từng gỡ ở 55bce31). Describe này TRƯỚC ĐÂY cấm mọi dấu vết của
 * nó; nay đổi vai: canh đúng những điều kiện khiến lần trước thất bại.
 *
 * Lần đó tích hợp bị gỡ vì OmniRoute trả `401` mọi lần khởi động và làm ngập `run_logs`
 * 303 dòng cảnh báo. Hai test dưới bảo đảm điều đó không lặp lại.
 */
describe('OmniRoute — không được kéo sập agy-proxy khi hỏng', () => {
  test('mật khẩu rỗng thì TẮT HẲN, không gọi mạng', () => {
    // Không có cửa nào khác: `dangBat()` là cổng duy nhất, và cả `dongBo` lẫn vòng nền
    // đều phải hỏi nó trước. Thiếu chốt này thì instance chưa cấu hình vẫn bắn request.
    const s = code('src/omniroute/sync.ts');
    assert.match(s, /export function dangBat\(\)[^}]*config\.omniroute\.password/s);
    assert.match(s, /if \(!dangBat\(\)\)/, 'dongBo phải thoát sớm khi chưa bật');
    assert.match(code('src/gateway/background.ts'), /!dangBat\(\)/, 'vòng nền phải hỏi dangBat');
  });

  test('lỗi OmniRoute bị nuốt, không ném ra vòng nền', () => {
    const s = code('src/omniroute/sync.ts');
    assert.match(s, /catch \(e\)/, 'dongBo phải bọc try/catch');
    assert.doesNotMatch(s, /\bthrow\b/, 'sync.ts không được ném lỗi ra ngoài');
  });
});
