import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * AGY_HOME sang thư mục tạm TRƯỚC MỌI IMPORT của src/.
 *
 * `paths.ts` đọc biến này lúc NẠP MODULE, và `store` là singleton. Đặt env bên trong test
 * là quá muộn — module đã trỏ vào ~/.agyproxy và test sẽ đọc-ghi 498 account THẬT.
 * Đã suýt xảy ra khi viết file này: bản đầu đặt env trong `test()` và đọc ra 498 account.
 * Xem test/data-safety.test.ts.
 */
const TMP = mkdtempSync(resolve(tmpdir(), 'agy-nous-'));
process.env.AGY_HOME = TMP;
// CSV nằm ở $AGY_HOME/data, không phải thẳng $AGY_HOME.
const TMP_DATA = resolve(TMP, 'data');
mkdirSync(TMP_DATA, { recursive: true });

const { FLOW_KEYS, FLOW_LABEL, ACCOUNT_HEADERS, statusField } = await import('../../src/store/models.js');
const { FLOWS, PIPELINE } = await import('../../src/flows/index.js');

/**
 * Flow `nous` — đăng ký Nous Research bằng tài khoản Google qua device-code.
 *
 * Dùng device-code chứ không tự động điền form portal: đây là API chính thức (hermes-cli
 * dùng đúng đường này), không phụ thuộc DOM trang đăng ký, không phải đoán selector. Đã
 * xác minh gọi thật 11/08/2026 — endpoint trả user_code, verification_uri_complete,
 * expires_in 600, interval 5.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const doc = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');

describe('đăng ký flow', () => {
  test('nous có trong FLOWS, FLOW_KEYS, FLOW_LABEL', () => {
    assert.ok(FLOWS.nous, 'thiếu trong FLOWS thì runSingle không chạy được');
    assert.ok(FLOW_KEYS.includes('nous'));
    assert.equal(FLOW_LABEL.nous, 'Nous Research');
  });

  test('CHƯA vào PIPELINE — chạy tay trước, đo rồi mới hàng loạt', () => {
    /**
     * PIPELINE chạy cho MỌI account. Đưa flow chưa kiểm chứng vào đó là mở 700 phiên
     * browser cùng lúc trên một luồng chưa ai chạy thật lần nào.
     */
    assert.ok(!PIPELINE.includes('nous'), 'nous vào PIPELINE quá sớm');
  });

  test('statusField trỏ đúng cột', () => {
    assert.equal(statusField('nous'), 'status_nous');
    assert.ok(ACCOUNT_HEADERS.includes('status_nous'));
  });

  test('status_nous đặt SAU các cột cũ', () => {
    /**
     * accounts.csv thật đang 2.7 MB / 498 account. Chèn cột vào GIỮA thì mọi giá trị sau
     * đó lệch một ô — fingerprint nhảy sang note, proxy nhảy sang profile_dir, hỏng cả
     * file trong một lần ghi.
     */
    const i = ACCOUNT_HEADERS.indexOf('status_nous');
    assert.ok(i > ACCOUNT_HEADERS.indexOf('status_kiro'), 'phải sau status_kiro');
    assert.ok(i > ACCOUNT_HEADERS.indexOf('fingerprint') || ACCOUNT_HEADERS.indexOf('fingerprint') > i);
    // Cụ thể: mọi cột TRƯỚC nó phải giữ nguyên thứ tự cũ.
    const cuTruoc = ['email', 'password', 'totp_secret', 'proxy', 'profile_dir', 'tz', 'locale',
      'status_google', 'status_gweb', 'status_agy', 'status_agycli', 'status_gcli', 'status_kiro'];
    assert.deepEqual(ACCOUNT_HEADERS.slice(0, cuTruoc.length), cuTruoc, 'thứ tự cột cũ bị xáo');
  });
});

describe('CSV cũ (chưa có status_nous) đọc-ghi không lệch cột', () => {
  after(() => rmSync(TMP, { recursive: true, force: true }));

  test('đọc 16 cột → ghi 17 cột, KHÔNG mất dữ liệu', async () => {
    // Đúng hình dạng file thật: header cũ 16 cột, fingerprint là chuỗi JSON dài có dấu phẩy.
    const fp = '{"a":1,"b":"x,y,z"}';
    writeFileSync(resolve(TMP_DATA, 'accounts.csv'),
      'email,password,totp_secret,proxy,profile_dir,tz,locale,status_google,status_gweb,status_agy,status_agycli,status_gcli,status_kiro,last_run,note,fingerprint\n' +
      `a@t,pw,sec,proxy1,dir_a,Asia/Bangkok,en-US,ok,new,ok,new,new,ok,2026-08-11,ghi-chu,"${fp.replace(/"/g, '""')}"\n`);

    const { store } = await import('../../src/store/index.js');
    store.load(); // KHÔNG tự chạy lúc import — phải gọi.

    const truoc = store.listAccounts();
    assert.equal(truoc.length, 1, `phải đọc thư mục TẠM, không phải dữ liệu thật (được ${truoc.length})`);
    assert.equal(truoc[0]!.fingerprint, fp, 'fingerprint có dấu phẩy phải giữ nguyên');
    assert.equal(truoc[0]!.proxy, 'proxy1');
    assert.equal(truoc[0]!.status_kiro, 'ok');
    assert.equal(truoc[0]!.status_nous, 'new', 'cột thiếu → mặc định new, không undefined');

    // GHI LẠI — đây là lúc cột mới được thêm vào file.
    store.upsertAccount({ ...truoc[0]!, note: 'da-sua' });

    const sau = store.listAccounts();
    assert.equal(sau[0]!.fingerprint, fp, 'ghi xong fingerprint bị lệch ô');
    assert.equal(sau[0]!.proxy, 'proxy1', 'ghi xong proxy bị lệch ô');
    assert.equal(sau[0]!.status_kiro, 'ok');
    assert.equal(sau[0]!.note, 'da-sua');

    // CSV ghi ra dùng CRLF — bỏ \r trước khi so, không thì lệch đúng một ký tự.
    const header = readFileSync(resolve(TMP_DATA, 'accounts.csv'), 'utf8').split('\n')[0]!.replace(/\r$/, '');
    assert.ok(header.includes('status_nous'), 'file mới phải có cột status_nous');
    // Thứ tự cột do ACCOUNT_HEADERS quyết định — khẳng định theo NÓ, không đoán.
    assert.equal(header, ACCOUNT_HEADERS.join(','), 'header ghi ra phải khớp ACCOUNT_HEADERS');
    assert.ok(header.indexOf('status_nous') > header.indexOf('status_kiro'), 'cột mới phải sau cột cũ');
  });
});

describe('flow dùng lại hạ tầng sẵn có, không viết lại', () => {
  const SRC = doc('src/flows/nous.ts');

  test('dùng performGoogleLogin thay vì tự điền form', () => {
    // Hàm đó đã lo speedbump, TOTP, chọn đúng account — viết lại là bỏ hết những ca đó.
    assert.match(SRC, /performGoogleLogin\(ctx, page\)/);
  });

  test('dùng consentStep sẵn có cho màn chấp thuận', () => {
    assert.match(SRC, /consentStep\(ctx, page, account\.email\)/);
  });

  test('lưu credential target "nous" kèm DẤU HIỆU provider', () => {
    /**
     * Credential OpenRouter cũng là JSON. Thiếu `provider: 'nous'` thì `accepts()` của hai
     * provider tranh nhau account này và pool nạp vào nhầm chỗ → 401 hàng loạt.
     */
    assert.match(SRC, /target: 'nous'/);
    assert.match(SRC, /provider: 'nous', refreshToken/);
  });

  test('tôn trọng interval và expires_in do Portal trả về', () => {
    // Poll dày hơn `interval` thì Portal trả `slow_down`; tự đặt số là chống lại nó.
    assert.match(SRC, /dc\.interval/);
    assert.match(SRC, /dc\.expires_in/);
  });

  test('authorization_pending KHÔNG bị coi là lỗi', () => {
    // Đó là trạng thái bình thường của device-code — ném ở đó thì flow chết ngay vòng đầu.
    assert.match(SRC, /authorization_pending/);
    assert.match(SRC, /slow_down/);
  });

  test('có chặn thời gian chờ, không lặp vô hạn', () => {
    assert.match(SRC, /nous_timeout/);
    assert.match(SRC, /Math\.min\(dc\.expires_in, 600\)/);
  });
});
