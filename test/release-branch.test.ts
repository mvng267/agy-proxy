import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG_KEYS } from '../src/config.js';
import { CONFIG_FIELDS } from '../src/configMeta.js';

/**
 * Tách nhánh phát hành khỏi nhánh phát triển.
 *
 * Trước đây mọi máy kéo thẳng từ `main`, nên MỌI commit — kể cả refactor dở dang hay bản
 * vá chưa kiểm — đều lập tức hiện thành "có bản mới" trên dashboard của máy thật. Không có
 * chỗ nào để code chín trước khi tới tay người dùng.
 *
 *   main        → nhánh làm việc, commit tự do
 *   production  → chỉ nhận bản đã phát hành (merge + tag), là thứ máy thật kéo về
 *
 * Nhánh lấy từ CẤU HÌNH chứ không khoá cứng: máy test có thể để `main` để nhận bản sớm,
 * máy thật để `production`. Khoá cứng thì muốn thử bản mới phải sửa code.
 */

const ROOT = resolve(import.meta.dirname, '..');

function code(f: string): string {
  return readFileSync(resolve(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('khoá cấu hình nhánh cập nhật', () => {
  test('có trong CONFIG_KEYS', () => {
    assert.ok(CONFIG_KEYS.includes('updateBranch'), 'thiếu khoá updateBranch');
  });

  test('có mô tả để hiện trên trang Cấu hình', () => {
    /**
     * `test/configmeta.test.ts` đã chốt "mọi khoá phải có mô tả", nhưng nhắc lại ở đây vì
     * đây chính là khoá quyết định máy nào nhận bản nào — vô hình là nguy hiểm.
     */
    const f = CONFIG_FIELDS['updateBranch'];
    assert.ok(f, 'updateBranch không có trong CONFIG_FIELDS');
    assert.ok(f.label, 'thiếu nhãn');
    assert.equal(f.type, 'string');
  });

  test('mặc định là `production`, không phải `main`', () => {
    /**
     * Mặc định phải là nhánh AN TOÀN. Ai không đụng gì tới cấu hình thì phải nhận bản đã
     * phát hành, không phải commit mới nhất của người đang code.
     */
    assert.match(code('src/config.ts'), /updateBranch[^\n]*production/);
  });
});

describe('updater đọc nhánh từ cấu hình, không khoá cứng', () => {
  const src = code('src/updater.ts');

  test('không còn chuỗi `main` khoá cứng trong lời gọi API/git', () => {
    /**
     * Sáu chỗ từng khoá cứng: contents API, raw.githubusercontent, commits API,
     * `git fetch origin main`, `rev-list HEAD..origin/main`, `log HEAD..origin/main`.
     * Sót một chỗ là hệ thống so nhánh này với nhánh kia — sai một cách âm thầm.
     */
    assert.doesNotMatch(src, /\?ref=main/, 'contents API còn khoá cứng main');
    assert.doesNotMatch(src, /githubusercontent\.com\/\$\{REPO\}\/main\//, 'raw URL còn khoá cứng main');
    assert.doesNotMatch(src, /commits\/main/, 'commits API còn khoá cứng main');
    assert.doesNotMatch(src, /origin\/main/, 'lệnh git còn khoá cứng origin/main');
    assert.doesNotMatch(src, /'origin', 'main'/, 'git fetch còn khoá cứng main');
  });

  test('có hàm lấy tên nhánh', () => {
    assert.match(src, /nhanhCapNhat|updateBranch/, 'phải đọc nhánh từ config');
  });
});

describe('script phát hành đẩy sang nhánh production', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/release.mjs'), 'utf8');

  test('có bước merge sang nhánh phát hành', () => {
    assert.match(src, /production/, 'release.mjs chưa biết tới nhánh production');
    assert.match(src, /merge/, 'thiếu bước merge');
  });

  test('vẫn có chế độ xem trước', () => {
    // Phát hành là thao tác đẩy ra ngoài — phải xem được trước khi bấm.
    assert.match(src, /--apply/);
  });

  test('không tự push khi chưa được yêu cầu', () => {
    /**
     * `--push` phải là bước RIÊNG. Tự đẩy lên GitHub ngay khi chạy script là hành động ra
     * ngoài mà người chạy chưa kịp nhìn kết quả.
     */
    assert.match(src, /PUSH|--push/);
  });
});
