import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROVIDER_IDS, PROVIDERS } from '../../src/gateway/providers/index.js';

/**
 * Giao diện KHÔNG được khoá cứng danh sách provider.
 *
 * Phát hiện khi thêm provider Nous: cả trang Pool lẫn trang Quota đều liệt kê tay
 * `[['agy','Antigravity'], ['kr','Kiro']]`, nên account của provider thứ ba nằm trong pool
 * mà **không có tab nào để xem** — chúng biến mất khỏi giao diện dù backend phục vụ bình
 * thường. OpenRouter đã ở trong repo từ lâu và cũng chịu đúng lỗi này mà không ai để ý.
 *
 * Nặng hơn ở cột hạn mức: bản trước giả định "không phải kr thì có bể Claude". Đúng với
 * agy, sai với Nous — Nous có BỐN bể theo nhịp (request/token × phút/giờ), không bể nào
 * tên Claude. Giả định kiểu đó khiến provider mới hiện số của bể không tồn tại.
 */

const ROOT = resolve(import.meta.dirname, '../..');

/** Bỏ comment trước khi soi — chính lời giải thích cũng nhắc tên provider. */
function code(f: string): string {
  return readFileSync(resolve(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const POOL = 'web/src/components/pages/Pool.tsx';
const QUOTA = 'web/src/components/pages/Quota.tsx';

describe('tab provider dựng từ DỮ LIỆU, không liệt kê tay', () => {
  test('Pool: không còn mảng cứng [agy, kr]', () => {
    const s = code(POOL);
    assert.doesNotMatch(
      s,
      /\[\s*\[\s*["']agy["'][^\]]*\]\s*,\s*\[\s*["']kr["']/,
      'còn liệt kê tay hai provider — provider thứ ba không có tab',
    );
    assert.match(s, /tabProvider/, 'phải dựng danh sách từ dữ liệu');
  });

  test('Quota: không còn mảng cứng [all, agy, kr]', () => {
    const s = code(QUOTA);
    assert.doesNotMatch(s, /\[\s*\[\s*["']all["'][^\]]*\]\s*,\s*\[\s*["']agy["']/);
    assert.match(s, /tabProvider/);
  });

  test('Pool dựng tab từ chính danh sách account trong pool', () => {
    // Dùng `new Set(accounts.map(...))` → provider nào có account thì có tab, tự động.
    assert.match(code(POOL), /new Set\(accounts\.map\(a => a\.provider/);
  });

  test('Quota dựng tab từ byProvider của API', () => {
    assert.match(code(QUOTA), /Object\.values\(summary\?\.byProvider/);
  });

  test('state provider của Pool không khoá cứng union hai giá trị', () => {
    /**
     * `useState<"agy" | "kr">` làm TypeScript chặn mọi provider mới ngay từ khâu biên
     * dịch — sửa tab mà quên chỗ này thì không build được.
     */
    assert.doesNotMatch(code(POOL), /useState<"agy" \| "kr">/);
  });
});

describe('cột hạn mức đọc từ dữ liệu quota, không đoán theo tên provider', () => {
  test('Quota: bể thứ hai lấy từ groups[1], không giả định "không phải kr thì có Claude"', () => {
    const s = code(QUOTA);
    assert.match(s, /a\.quota\?\.groups \?\? \[\]/, 'phải đọc groups thật');
    assert.doesNotMatch(
      s,
      /a\.provider === "kr"\s*\?\s*<span[^>]*>—/,
      'còn quyết định hiện dấu gạch bằng cách so tên provider',
    );
  });

  test('Pool: nhãn cột lấy từ tên bể thật', () => {
    assert.match(code(POOL), /nhanQuota/);
  });

  test('nhãn dự phòng phủ MỌI provider đang có, không chỉ agy/kr', () => {
    // Provider không có nhãn thì hiện chính id — thà xấu còn hơn giấu mất cả nhóm account.
    const s = code(POOL);
    const nhan = s.match(/const NHAN: Record<string, string> = \{([^}]*)\}/)?.[1] ?? '';
    for (const id of PROVIDER_IDS) {
      assert.ok(nhan.includes(`${id}:`), `thiếu nhãn cho provider '${id}' (${PROVIDERS[id].label})`);
    }
    assert.match(s, /NHAN\[id\] \?\? id/, 'phải có đường lui khi provider chưa có nhãn');
  });
});
