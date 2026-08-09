import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * MCP server — allowlist tool cho AI agent điều khiển agyproxy.
 *
 * Test này khoá ranh giới an toàn. Rủi ro thật: `agyproxy routes` sinh danh sách endpoint
 * bằng cách QUÉT source, nên mỗi route backend thêm mới tự động xuất hiện ở đó. Nếu MCP
 * dùng blocklist thì route mới sẽ tự lọt vào tay agent — kể cả route nguy hiểm chưa kịp
 * phân loại. Vì vậy phải là allowlist, và test phải chặn việc vô tình thêm nhầm.
 */

const ROOT = resolve(import.meta.dirname, '..');

describe('MCP allowlist', () => {
  test('chỉ expose tool đã duyệt; không tool nào chạm endpoint nguy hiểm', async () => {
    const { TOOLS } = await import('../src/mcp/tools.mjs');

    // Dựng đường dẫn thật của từng tool bằng tham số mẫu, rồi soi.
    const paths = TOOLS.map((t: any) => {
      const sample: Record<string, unknown> = { email: 'a@b.vn', rotation: 'smart', hours: 6, range: '7d', groupBy: 'day' };
      const { method, path, body } = t.call(sample);
      return { name: t.name, method, path, body, write: !!t.write };
    });

    /**
     * Ba nhóm bị chặn có chủ đích:
     *  - mất quyền / mất dữ liệu: đổi mật khẩu, xoá, backup, lộ key nguyên văn
     *  - gián đoạn dịch vụ: restart, update, tắt gateway, bulk toàn pool
     *  - tốn kém / tự hại: quét cả pool (~14 phút, bị upstream chặn tốc độ), chạy automation
     */
    const CAM = [
      /\/api\/security\/password/,
      /\/api\/backup\//,
      /\/api\/credentials/,
      /reveal=1/,
      /\/api\/system\/(restart|update)/,
      /\/api\/gateway\/accounts\/bulk/,
      /\/api\/gateway\/accounts\/check/,
      /\/api\/gateway\/keys/,
      /\/api\/run$|\/api\/auto-run|\/api\/run-pipeline/,
      /\/api\/(gateway|omniroute)\/chat/,
    ];

    for (const p of paths) {
      for (const re of CAM) {
        assert.doesNotMatch(p.path, re, `tool \`${p.name}\` chạm endpoint bị cấm: ${p.path}`);
      }
      assert.notEqual(p.method, 'DELETE', `tool \`${p.name}\` dùng DELETE — không tool nào được xoá gì`);
    }

    // `regenerateKey` làm mọi client đang dùng chết ngay; `enabled:false` tắt gateway.
    for (const p of paths) {
      const b = JSON.stringify(p.body ?? {});
      assert.doesNotMatch(b, /regenerateKey/, `tool \`${p.name}\` sinh lại API key`);
      assert.doesNotMatch(b, /"enabled":\s*false/, `tool \`${p.name}\` tắt gateway`);
    }
  });

  test('tool ghi được đánh dấu đúng — client MCP dựa vào đó để hỏi xác nhận', async () => {
    const { TOOLS, READ_ONLY, WRITE_TOOLS } = await import('../src/mcp/tools.mjs');
    assert.equal(READ_ONLY.length + WRITE_TOOLS.length, TOOLS.length);
    assert.ok(READ_ONLY.length >= 8, `phải có đủ tool đọc để agent chẩn đoán, có ${READ_ONLY.length}`);

    // Mọi tool ghi phải dùng POST/PATCH; mọi tool đọc phải là GET. Đánh dấu sai thì client
    // MCP tưởng tool ghi là chỉ đọc và gọi tự do.
    for (const t of TOOLS as any[]) {
      const { method } = t.call({ email: 'a@b.vn', rotation: 'smart' });
      if (t.write) assert.ok(['POST', 'PATCH'].includes(method), `${t.name}: ghi mà method ${method}`);
      else assert.equal(method, 'GET', `${t.name}: đánh dấu chỉ đọc mà method ${method}`);
    }
  });

  test('entry MCP không in ra stdout — stdio là kênh JSON-RPC', () => {
    // Một dòng console.log lạc vào stdout là hỏng cả phiên, client báo lỗi parse rất khó truy.
    const src = readFileSync(resolve(ROOT, 'bin/agyproxy-mcp.mjs'), 'utf8');
    assert.doesNotMatch(src, /console\.log\(/, 'MCP entry phải dùng console.error, không console.log');
    assert.match(src, /console\.error\(/, 'phải có thông báo khởi động qua stderr');
  });

  test('client.mjs không đọc process.argv — dùng chung được cho cả CLI và MCP', () => {
    // Nếu nó đọc argv thì MCP server sẽ diễn giải nhầm tham số của chính nó.
    // Bỏ comment trước khi soi — chính comment giải thích luật cũng chứa chữ `process.argv`.
    const src = readFileSync(resolve(ROOT, 'src/mcp/client.mjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /process\.argv/, 'client.mjs phải nhận cấu hình qua tham số');
    assert.doesNotMatch(src, /console\.log\(/, 'client.mjs không được in ra stdout');
  });
});
