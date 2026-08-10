import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Lý do account hỏng — nối `runs` với trạng thái account.
 *
 * Sự cố có thật trên production: 133 account `status_agy=failed` mà KHÔNG chỗ nào nói vì
 * sao. `store.setStatus()` chỉ ghi chữ 'failed' vào accounts.csv; `runner.ts` có sẵn
 * `msg` nhưng không truyền xuống, và accounts.csv cũng không có cột nào để lưu.
 * Người vận hành thấy "hỏng 133 cái" rồi bó tay.
 *
 * Lý do vẫn nằm trong bảng `runs` (`updateRun(runId,'failed',msg)` có lưu) — đo thật:
 * 133 × `antigravity_no_code`, 133 × `kiro_no_code`, 32 × `human_timeout`. Chỉ là chưa
 * ai nối hai nguồn lại. Hai hàm này làm việc đó.
 *
 * AGY_HOME sang thư mục tạm TRƯỚC mọi import — xem test/data-safety.test.ts.
 */
const TMP = mkdtempSync(resolve(tmpdir(), 'agy-reasons-'));
process.env.AGY_HOME = TMP;

const { db, lastRunErrors, failureReasons } = await import('../../src/store/db.js');

after(() => rmSync(TMP, { recursive: true, force: true }));

/** Ghi thẳng vào bảng runs — không qua runner để test không phụ thuộc Playwright. */
function run(email: string, flow: string, status: string, error: string | null, ts = '2026-08-01T00:00:00Z') {
  db.prepare(
    `INSERT INTO runs (email, flow, status, error, started_at) VALUES (?,?,?,?,?)`,
  ).run(email, flow, status, error, ts);
}

before(() => {
  db.exec('DELETE FROM runs');
  /**
   * a@x: agy hỏng 2 lần, lý do khác nhau → phải lấy lần GẦN NHẤT (id lớn hơn).
   *
   * Chèn theo thứ tự tự nhiên: `loi_cu` trước, `antigravity_no_code` sau. Nếu truy vấn
   * bỏ điều kiện `MAX(id)`, nó trả CẢ HAI dòng và `Map.set` để dòng SQL trả sau thắng —
   * SQLite quét theo id tăng dần nên vẫn tình cờ ra đúng kết quả. Vì vậy phép thử thật
   * nằm ở test 'chỉ trả MỘT dòng cho mỗi (account, flow)' bên dưới, không phải ở đây.
   */
  run('a@x', 'agy', 'failed', 'loi_cu');
  run('a@x', 'agy', 'failed', 'antigravity_no_code');
  // a@x: kiro cũng hỏng, lý do khác → hai flow độc lập nhau
  run('a@x', 'kiro', 'failed', 'kiro_no_code');
  // b@x: hỏng rồi THÀNH CÔNG → không được coi là đang hỏng nữa
  run('b@x', 'agy', 'failed', 'antigravity_no_code');
  run('b@x', 'agy', 'ok', null);
  // c@x, d@x: cùng lý do với a@x → gom nhóm phải đếm được
  run('c@x', 'agy', 'failed', 'antigravity_no_code');
  run('d@x', 'agy', 'failed', 'human_timeout');
  // e@x: failed nhưng không ghi lý do → không được tính vào bảng xếp hạng
  run('e@x', 'agy', 'failed', null);
});

describe('lastRunErrors — lý do gần nhất theo (account, flow)', () => {
  test('lấy lần GẦN NHẤT, không phải lần đầu', () => {
    const m = lastRunErrors();
    assert.equal(
      m.get('a@x:agy')?.error, 'antigravity_no_code',
      'phải lấy lỗi mới nhất — hiện lỗi cũ làm người vận hành sửa nhầm chỗ',
    );
  });

  test('hai flow của cùng account độc lập nhau', () => {
    const m = lastRunErrors();
    assert.equal(m.get('a@x:agy')?.error, 'antigravity_no_code');
    assert.equal(m.get('a@x:kiro')?.error, 'kiro_no_code');
  });

  test('run thành công SAU khi hỏng thì vẫn còn trong map', () => {
    // Hàm này chỉ trả lỗi gần nhất của các run failed; việc account đã ok hay chưa do
    // `status_*` trong accounts.csv quyết định. Ghép ở tầng API mới lọc theo trạng thái.
    const m = lastRunErrors();
    assert.ok(m.has('b@x:agy'), 'vẫn giữ lịch sử — API lọc theo status khi hiển thị');
  });

  test('failed không ghi lý do thì bỏ qua', () => {
    const m = lastRunErrors();
    assert.equal(m.get('e@x:agy'), undefined, 'không có lý do thì không thêm dòng rỗng');
  });

  test('một khoá cho mỗi (account, flow), không nhân bản theo số lần chạy', () => {
    const m = lastRunErrors();
    // a@x:agy, a@x:kiro, b@x:agy, c@x:agy, d@x:agy = 5 cặp, từ 7 run failed có lý do.
    assert.equal(m.size, 5, `phải gom về 5 cặp duy nhất, đang có ${m.size}`);
  });

  test('truy vấn chỉ đọc 1 dòng mỗi cặp — không quét cả lịch sử', () => {
    /**
     * `MAX(id)` chỉ ảnh hưởng KHỐI LƯỢNG đọc, không ảnh hưởng kết quả cuối: `Map.set`
     * gom trùng khoá, và SQLite quét id tăng dần nên dòng cuối ghi đè vẫn tình cờ là
     * dòng mới nhất. Vì vậy mọi phép kiểm qua giá trị Map đều KHÔNG bắt được khi bỏ
     * điều kiện này — đã thử hai cách và cả hai đều xanh trên code hỏng.
     *
     * Phải đo thẳng vào SQL: production có hàng chục nghìn run, bỏ `MAX(id)` là quét
     * toàn bảng mỗi lần mở trang Tài khoản.
     */
    const soDong = (
      db.prepare(
        `SELECT COUNT(*) n FROM runs r
           JOIN (SELECT email, flow, MAX(id) AS mid
                   FROM runs WHERE status = 'failed' GROUP BY email, flow) m
             ON r.id = m.mid
          WHERE r.error IS NOT NULL AND r.error != ''`,
      ).get() as { n: number }
    ).n;

    const tongRunLoi = (
      db.prepare(`SELECT COUNT(*) n FROM runs WHERE status='failed' AND error IS NOT NULL AND error != ''`).get() as { n: number }
    ).n;

    assert.equal(soDong, 5, 'phải đọc đúng 5 dòng (1 cho mỗi cặp)');
    assert.ok(tongRunLoi > soDong, 'phép thử chỉ có nghĩa khi có account hỏng nhiều lần');
  });
});

describe('failureReasons — xếp hạng để biết sửa cái nào trước', () => {
  test('gom theo lý do, đếm số ACCOUNT (không phải số lần chạy)', () => {
    const r = failureReasons();
    const nc = r.find((x) => x.reason === 'antigravity_no_code');
    assert.ok(nc, 'phải có antigravity_no_code');
    // a@x (2 run cùng lý do) + b@x + c@x = 3 account, KHÔNG phải 4 run.
    assert.equal(nc.accounts, 3, 'đếm account để biết sửa xong cứu được bao nhiêu cái');
  });

  test('xếp giảm dần — nhiều account nhất lên đầu', () => {
    const r = failureReasons();
    const n = r.map((x) => x.accounts);
    assert.deepEqual(n, [...n].sort((a, b) => b - a), 'không xếp hạng thì bảng vô dụng');
  });

  test('kèm flow để biết hỏng ở luồng nào', () => {
    const r = failureReasons();
    assert.match(r.find((x) => x.reason === 'kiro_no_code')!.flows, /kiro/);
  });

  test('bỏ qua run không có lý do', () => {
    const r = failureReasons();
    assert.ok(!r.some((x) => !x.reason), 'không được có dòng lý do rỗng');
  });
});
