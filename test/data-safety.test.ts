import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * LƯỚI AN TOÀN DỮ LIỆU — canary, không phải test tính năng.
 *
 * Sự cố có thật: `test/backup.test.ts` gọi `restoreBackup()` mà không cô lập `AGY_HOME`,
 * nên `npm test` ghi thẳng vào `~/.agyproxy/data/credentials.csv` — file giữ 700 credential
 * thật. Phát hiện ra vì mtime của accounts.csv và credentials.csv đổi đúng lúc chạy test.
 * Dữ liệu còn nguyên là do restore chính snapshot vừa dựng nên nội dung trùng, KHÔNG phải
 * do thiết kế. Đúng test đó cũng đang FAIL với `ENOENT: rename credentials.csv.tmp`.
 *
 * Hai lớp bảo vệ ở đây:
 *  1. Quét tĩnh: file test nào import thứ ghi xuống đĩa thì phải cô lập AGY_HOME.
 *     Bắt được lỗi NGAY KHI viết test mới, không cần đợi mất dữ liệu.
 *  2. Kiểm mtime: dữ liệu thật không được đổi trong lúc chạy suite.
 */

const ROOT = resolve(import.meta.dirname, '..');
const REAL_DATA = resolve(homedir(), '.agyproxy', 'data');

/** Thứ ghi xuống đĩa khi gọi. Import những cái này = phải cô lập. */
const GHI_XUONG_DIA = ['restoreBackup', 'store.save', 'flushPersist', 'savePersist'];

/** Đã cô lập nếu đặt AGY_HOME trước khi nạp src/ (test/live gọi server ngoài, không tính). */
const DA_CO_LAP = /process\.env\.AGY_HOME\s*=|AGY_HOME:/;

function fileTest(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...fileTest(p));
    else if (e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('an toàn dữ liệu', () => {
  test('test nào ghi xuống đĩa cũng phải cô lập AGY_HOME', () => {
    const pham: string[] = [];

    for (const f of fileTest(resolve(ROOT, 'test'))) {
      // Bỏ comment trước khi soi — chính comment giải thích luật cũng chứa các tên hàm này.
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      const ghi = GHI_XUONG_DIA.filter((h) => src.includes(h));
      if (ghi.length && !DA_CO_LAP.test(src)) {
        pham.push(`${f.slice(ROOT.length + 1)} — gọi ${ghi.join(', ')} mà không đặt AGY_HOME`);
      }
    }

    assert.deepEqual(
      pham,
      [],
      `Test sau sẽ ghi vào dữ liệu THẬT ở ~/.agyproxy/data (700 credential):\n  ${pham.join('\n  ')}\n\n` +
        `Cách sửa: đặt process.env.AGY_HOME = mkdtempSync(...) TRƯỚC mọi import của src/ ` +
        `(paths.ts đọc env lúc import → phải dùng await import() động). Xem test/backup.test.ts.`,
    );
  });

  test('credential thật không bị suite XOÁ hay làm hỏng', async () => {
    const f = resolve(REAL_DATA, 'credentials.csv');
    if (!existsSync(f)) return; // máy CI chưa có dữ liệu thật — không có gì để bảo vệ

    /**
     * Đo SỐ DÒNG, không đo nội dung byte.
     *
     * Bản trước so nguyên nội dung trước/sau, dựa trên giả định "server ghi lại y nguyên
     * nội dung cũ". Giả định đó SAI: server đang chạy refresh access token liên tục, nên
     * nội dung đổi thật — đo được trên máy dev, file đổi kích thước mỗi 8 giây kể cả khi
     * KHÔNG chạy test nào. Canary báo đỏ oan, và một canary hay báo oan thì người ta bắt
     * đầu bỏ qua nó — nguy hiểm hơn là không có.
     *
     * Thứ thật sự cần bảo vệ là ĐỪNG MẤT credential. Test ghi đè vào dữ liệu thật sẽ làm
     * số dòng tụt hẳn (ghi 1-2 credential của test lên 700 dòng thật); token refresh thì
     * không bao giờ đổi số dòng.
     */
    const demDong = (b: Buffer) => b.toString('utf8').split('\n').filter((x) => x.trim()).length;
    const truoc = demDong(readFileSync(f));
    await new Promise((r) => setTimeout(r, 300));
    const sau = demDong(readFileSync(f));

    assert.equal(
      sau,
      truoc,
      `SỐ DÒNG credentials.csv đổi trong lúc chạy test (${truoc} → ${sau}) — có test đang ghi ` +
        `vào dữ liệu THẬT. Tìm test chưa cô lập AGY_HOME.`,
    );
    assert.ok(sau > 0, 'credentials.csv rỗng — dữ liệu thật đã bị xoá');
  });
});
