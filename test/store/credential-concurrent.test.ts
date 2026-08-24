import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * `upsertCredential` không được xoá credential do TIẾN TRÌNH KHÁC vừa ghi.
 *
 * Vì sao cần test này: `saveCredentials()` ghi ĐÈ cả file từ mảng trong bộ nhớ. Tiến trình
 * nạp CSV lúc file còn ít dòng sẽ xoá sạch mọi dòng thêm sau đó. Đã mất **19 credential
 * thật** đúng theo cách này — chạy một job lẻ song song với một đợt 20 account, mỗi cái
 * phải đăng nhập lại và tốn một lượt trong trần login/24h.
 *
 * Cách dựng lại tình huống mà không cần hai tiến trình: ghi thẳng vào CSV sau khi store đã
 * nạp — đó chính xác là thứ tiến trình kia gây ra từ góc nhìn của store này.
 */

const TMP = mkdtempSync(resolve(tmpdir(), 'agy-cred-'));
process.env.AGY_HOME = TMP;

let store: typeof import('../../src/store/index.js').store;
let CSV_PATH: string;

before(async () => {
  ({ store } = await import('../../src/store/index.js'));
  CSV_PATH = resolve(TMP, 'data', 'credentials.csv');
});
after(() => rmSync(TMP, { recursive: true, force: true }));

const ghi = (email: string, target = 'agy', value = 'v-' + email) =>
  store.upsertCredential({ email, target, value, expires_at: '', omniroute_connection_id: '', updated_at: '' });

const demTrongFile = (): string[] =>
  readFileSync(CSV_PATH, 'utf8')
    .split('\n')
    .slice(1)
    .filter((l) => l.trim())
    .map((l) => l.split(',')[0]!);

describe('upsertAccount — không nuốt dòng của tiến trình khác', () => {
  const ghiAcc = (email: string) => store.upsertAccount({ email, password: 'x' });
  const ACC = () => resolve(TMP, 'data', 'accounts.csv');
  const emailsAcc = (): string[] =>
    readFileSync(ACC(), 'utf8').split('\n').slice(1).filter((l) => l.trim()).map((l) => l.split(',')[0]!);

  test('giữ account được ghi thẳng vào file sau khi store đã nạp', () => {
    ghiAcc('x@t');
    const cu = readFileSync(ACC(), 'utf8').trimEnd();
    // Mô phỏng tiến trình khác thêm account — đúng thứ đã xoá mất account 1-3 thật.
    writeFileSync(ACC(), cu + '\ny@t,pw,,,,,,new,new,new,new,new,new,new,,\n');

    ghiAcc('z@t');

    const em = emailsAcc().sort();
    assert.ok(em.includes('y@t'), 'account của tiến trình khác KHÔNG được biến mất');
    assert.deepEqual(em, ['x@t', 'y@t', 'z@t']);
  });
});

describe('upsertCredential — không nuốt dòng của tiến trình khác', () => {
  test('giữ nguyên dòng được ghi thẳng vào file sau khi store đã nạp', () => {
    ghi('a@t');
    assert.deepEqual(demTrongFile(), ['a@t']);

    // Mô phỏng tiến trình khác thêm dòng — store hiện tại chưa biết gì về nó.
    const cu = readFileSync(CSV_PATH, 'utf8').trimEnd();
    writeFileSync(CSV_PATH, cu + '\nb@t,agy,v-b@t,,,,unknown,\n');

    ghi('c@t');

    const emails = demTrongFile().sort();
    assert.ok(emails.includes('b@t'), 'dòng của tiến trình khác KHÔNG được biến mất');
    assert.deepEqual(emails, ['a@t', 'b@t', 'c@t']);
  });

  test('vẫn cập nhật đúng chỗ, không tạo bản trùng', () => {
    ghi('a@t', 'agy', 'gia-tri-moi');
    const rows = readFileSync(CSV_PATH, 'utf8').split('\n').filter((l) => l.startsWith('a@t,'));
    assert.equal(rows.length, 1, 'phải cập nhật tại chỗ, không thêm dòng mới');
    assert.match(rows[0]!, /gia-tri-moi/);
  });

  test('cùng email khác target là HAI credential riêng', () => {
    // Một account có cả `agy` lẫn `kiro` — gộp nhầm là mất một provider.
    ghi('d@t', 'agy');
    ghi('d@t', 'kiro');
    const rows = readFileSync(CSV_PATH, 'utf8').split('\n').filter((l) => l.startsWith('d@t,'));
    assert.equal(rows.length, 2);
  });
});
