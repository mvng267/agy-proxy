import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * `setStatus` không được dập trạng thái do TIẾN TRÌNH KHÁC vừa ghi.
 *
 * Vì sao cần test này: `saveAccounts()` ghi ĐÈ cả file từ map trong bộ nhớ. `upsertAccount`
 * và `upsertCredential` đã nạp lại trước khi ghi vì lý do đó, nhưng `setStatus` bị bỏ sót —
 * mà nó cũng gọi `saveAccounts()`.
 *
 * Tình huống thật suýt mất dữ liệu: app chạy liên tục 4,8 tiếng giữ ảnh chụp cũ trong bộ
 * nhớ; script ngoài đánh dấu 47 tài khoản đã bị xoá khỏi Workspace là `needs_human`. Chỉ cần
 * một flow trong app chạy xong gọi `setStatus`, cả 47 dấu biến mất khỏi CSV — và không ai
 * biết, vì dashboard vẫn xanh.
 *
 * Dựng lại bằng một tiến trình: cho store nạp, rồi ghi thẳng vào CSV — đúng thứ tiến trình
 * kia gây ra từ góc nhìn của store này.
 */

const TMP = mkdtempSync(resolve(tmpdir(), 'agy-setst-'));
process.env.AGY_HOME = TMP;

let store: typeof import('../../src/store/index.js').store;
let CSV_PATH: string;

before(async () => {
  ({ store } = await import('../../src/store/index.js'));
  CSV_PATH = resolve(TMP, 'data', 'accounts.csv');
});
after(() => rmSync(TMP, { recursive: true, force: true }));

/** Đọc cột status_agy của một email thẳng từ file. */
function trangThaiTrongFile(email: string): string {
  const t = readFileSync(CSV_PATH, 'utf8');
  const [head, ...dong] = t.split('\n').filter((l) => l.trim());
  const cols = head!.split(',');
  const iEmail = cols.indexOf('email');
  const iAgy = cols.indexOf('status_agy');
  const d = dong.find((l) => l.split(',')[iEmail] === email);
  return d ? d.split(',')[iAgy]! : '(không có)';
}

describe('setStatus song song', () => {
  test('giữ nguyên needs_human mà tiến trình khác vừa ghi', () => {
    store.upsertAccount({ email: 'a@x.vn' });
    store.upsertAccount({ email: 'chet@x.vn' });

    /**
     * Tiến trình KHÁC đánh dấu chet@x.vn là needs_human.
     *
     * Phải ghi THẲNG vào file, không qua `store.upsertAccount` — upsert cập nhật luôn map
     * trong bộ nhớ, nên map hết cũ và lỗi không tái lập (bản test đầu đã pass cả khi gỡ bản
     * vá đúng vì lý do này). Ghi thẳng file mới đúng thứ store này nhìn thấy từ tiến trình kia.
     */
    const t = readFileSync(CSV_PATH, 'utf8');
    const [head, ...dong] = t.split('\n').filter((l) => l.trim());
    const cols = head!.split(',');
    const iEmail = cols.indexOf('email');
    const iAgy = cols.indexOf('status_agy');
    const moi = dong.map((l) => {
      const o = l.split(',');
      if (o[iEmail] === 'chet@x.vn') o[iAgy] = 'needs_human';
      return o.join(',');
    });
    writeFileSync(CSV_PATH, [head, ...moi].join('\n') + '\n');
    assert.equal(trangThaiTrongFile('chet@x.vn'), 'needs_human', 'tiền đề: dấu đã nằm trong file');

    // App (map trong bộ nhớ cũ) hoàn tất một flow cho account KHÁC.
    store.setStatus('a@x.vn', 'agy', 'ok');

    assert.equal(trangThaiTrongFile('a@x.vn'), 'ok', 'trạng thái vừa đặt phải được ghi');
    assert.equal(
      trangThaiTrongFile('chet@x.vn'),
      'needs_human',
      'setStatus không được dập dấu của tiến trình khác',
    );
  });

  test('không tạo account mới cho email lạ', () => {
    store.setStatus('khongton@x.vn', 'agy', 'ok');
    assert.equal(trangThaiTrongFile('khongton@x.vn'), '(không có)');
  });
});
