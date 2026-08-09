#!/usr/bin/env node
/**
 * MCP server cho agyproxy — để Claude Code / Hermes điều khiển pool bằng tool-calling
 * thay vì gõ CLI.
 *
 *   agyproxy-mcp                          # dùng cấu hình ở ~/.agyproxy/cli.json
 *   AGY_URL=... AGY_TOKEN=... agyproxy-mcp
 *
 * QUY TẮC SỐNG CÒN: stdio transport dùng chính **stdout** làm kênh JSON-RPC. Một dòng
 * `console.log` lạc vào đó là hỏng cả phiên và client báo lỗi parse rất khó truy. Mọi
 * thông báo phải đi `console.error` (stderr).
 *
 * Quyền: đọc tự do + ghi an toàn (gỡ cooldown, nạp quota, kiểm tra một account, đổi
 * chiến lược xoay). Những thứ có thể mất dữ liệu, mất quyền truy cập, hoặc làm gián đoạn
 * dịch vụ đều KHÔNG được expose — xem `src/mcp/tools.mjs` để biết lý do từng nhóm.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callApi, baseUrl } from '../src/mcp/client.mjs';
import { TOOLS } from '../src/mcp/tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));

const server = new McpServer({ name: 'agyproxy', version: PKG.version });

for (const t of TOOLS) {
  server.registerTool(
    t.name,
    {
      title: t.title,
      description: t.description,
      inputSchema: t.schema,
      annotations: {
        readOnlyHint: !t.write,
        // Không tool nào trong allowlist là huỷ hoại — thứ huỷ hoại đã bị loại từ đầu.
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const { method, path, body } = t.call(args ?? {});
      const r = await callApi(method, path, body, { userAgent: 'agyproxy-mcp' });

      if (!r.ok) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `Lỗi ${r.status || ''} khi gọi ${method} ${path}\n${JSON.stringify(r.data, null, 2)}`,
          }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(r.data, null, 2) }] };
    },
  );
}

// stderr, KHÔNG stdout — xem ghi chú đầu file.
console.error(`agyproxy-mcp v${PKG.version} · ${TOOLS.length} tool · server: ${baseUrl()}`);

await server.connect(new StdioServerTransport());
