import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Gói npm phải chạy được — nghĩa là phải CÓ dashboard.
 *
 * `package.json` khai `files: ["bin","src","public",…]`, nhưng:
 *   · `public/` KHÔNG TỒN TẠI (code đã đổi sang `web/dist` từ lâu)
 *   · `web/dist` — thứ server thật sự serve — KHÔNG có trong danh sách
 *
 * Đo bằng `npm pack --dry-run`: 70 file, **0 file `web/dist`**. Mà `paths.ts` khai
 * `PUBLIC_DIR = resolve(ROOT, 'web/dist')` và `index.ts` đăng ký static từ đó.
 *
 * Hệ quả: nhánh `npm install -g github:mvng267/agy-proxy` sẵn có trong CLI dẫn tới bản
 * KHÔNG CÓ giao diện — mở dashboard ra là 404 toàn bộ. Đây là lỗi đang chạy, không phải
 * giả định.
 */

const ROOT = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  files?: string[]; license?: string; repository?: unknown; version: string;
};

describe('package.json — danh sách file đóng gói', () => {
  test('có web/dist (dashboard)', () => {
    assert.ok(
      pkg.files?.some((f) => f === 'web/dist' || f === 'web'),
      'thiếu web/dist → bản npm không có dashboard',
    );
  });

  test('không khai thư mục không tồn tại', () => {
    for (const f of pkg.files ?? []) {
      // Bỏ qua mẫu glob và file lẻ; chỉ soi đường dẫn thư mục thật.
      if (f.includes('*')) continue;
      assert.ok(existsSync(resolve(ROOT, f)), `files khai "${f}" nhưng không tồn tại`);
    }
  });
});

describe('npm pack thật sự chứa dashboard', () => {
  test('tarball có file web/dist', () => {
    /**
     * Soi `files` chưa đủ: `.npmignore`, `.gitignore` và mẫu glob đều có thể loại thư mục
     * ra ở phút chót. Hỏi thẳng npm là cách duy nhất chắc chắn.
     */
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20,
    });
    const j = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const files = j[0]?.files?.map((f) => f.path) ?? [];

    const dist = files.filter((p) => p.startsWith('web/dist/'));
    assert.ok(dist.length > 0, `tarball có ${files.length} file nhưng 0 file web/dist`);

    // index.html là thứ `index.ts` đọc trực tiếp — thiếu nó thì trang trắng.
    assert.ok(files.includes('web/dist/index.html'), 'thiếu web/dist/index.html');
  });

  test('KHÔNG đóng gói dữ liệu hay bí mật', () => {
    /**
     * `files` là danh sách cho phép nên rủi ro thấp, nhưng gói này chứa mã quản lý 700
     * account — nhầm một lần là lộ vĩnh viễn (npm không cho xoá bản đã publish).
     */
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20,
    });
    const j = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const files = j[0]?.files?.map((f) => f.path) ?? [];

    for (const p of files) {
      assert.doesNotMatch(p, /credentials\.csv|accounts\.csv|state\.db|gateway\.json/, `đóng gói dữ liệu: ${p}`);
      // `.env.example` thì được — nó chỉ có giá trị mẫu.
      assert.ok(p !== '.env' && !p.endsWith('.bak-cred'), `đóng gói file bí mật: ${p}`);
    }
  });
});

describe('siêu dữ liệu tối thiểu để publish', () => {
  test('có license', () => {
    assert.ok(pkg.license, 'thiếu license → npm hiện "không có giấy phép"');
    assert.ok(existsSync(resolve(ROOT, 'LICENSE')), 'thiếu file LICENSE');
  });

  test('có repository', () => {
    assert.ok(pkg.repository, 'thiếu repository → npm không link được về GitHub');
  });
});

describe('không lộ địa chỉ máy chủ thật', () => {
  test('README và CLI dùng placeholder, không phải IP production', () => {
    /**
     * IP nội bộ của máy production từng nằm 7 chỗ trong README. Repo đã public nên nó
     * không "bí mật", nhưng publish npm là đẩy thêm một kênh phát tán nữa — và tài liệu
     * chỉ vào máy thật thì người đọc dễ gõ nhầm vào đó.
     */
    for (const f of ['README.md', 'bin/agyproxy.mjs']) {
      const s = readFileSync(resolve(ROOT, f), 'utf8');
      assert.doesNotMatch(s, /100\.112\.240\.4/, `${f} còn IP máy chủ thật`);
    }
  });
});
