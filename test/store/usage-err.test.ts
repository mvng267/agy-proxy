import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Lưu thông điệp lỗi nguyên văn + giữ usage vĩnh viễn.
 *
 * Vì sao cần: `gateway_usage` trước đây chỉ lưu MÃ SỐ. Nhìn "429" không phân biệt được
 * ba tình huống đòi ba cách xử lý khác hẳn nhau — đều đã gặp thật trên production:
 *   "Individual quota reached, resets in 83h34m"  → account cạn, chờ là xong
 *   "exhausted your capacity on this model"       → trần theo MODEL, đổi account vô ích
 *   "max_tokens: 131072 > 128000"                 → lỗi ở REQUEST, thử 20 account vẫn hỏng
 * Muốn biết là cái nào phải mò Live Log — vốn giữ 500 dòng trong RAM và mất khi F5.
 *
 * AGY_HOME sang thư mục tạm TRƯỚC mọi import — xem test/data-safety.test.ts.
 */
const TMP = mkdtempSync(resolve(tmpdir(), 'agy-err-'));
process.env.AGY_HOME = TMP;

const { db, recordGatewayUsage, usageLogs, pruneUsage, bocLoi } = await import('../../src/store/db.js');

const NOW = Date.now();
const GIO = 3600_000;
const ROOT = resolve(import.meta.dirname, '../..');

after(() => rmSync(TMP, { recursive: true, force: true }));

const ghi = (o: Record<string, unknown>) =>
  recordGatewayUsage({
    ts: NOW - GIO, email: 'a@t', model: 'agy/x', promptTokens: 1, completionTokens: 0, ms: 10,
    ...o,
  } as never);

before(() => {
  db.exec('DELETE FROM gateway_usage');
  ghi({ ok: false, status: 429, err: 'Individual quota reached, resets in 83h34m' });
  ghi({ ok: false, status: 429, err: 'You have exhausted your capacity on this model' });
  ghi({ ok: true, status: 200 });
});

describe('cột err', () => {
  const doc = () => usageLogs(NOW - 2 * GIO, NOW, {}, 100, 0).rows as Array<Record<string, unknown>>;

  test('giữ nguyên văn thông điệp, không chỉ mã số', () => {
    const rows = doc();
    assert.equal(rows.length, 3);
    const msgs = rows.map((r) => r.err ?? '');
    assert.ok(msgs.some((m) => String(m).includes('resets in 83h34m')), 'mất chi tiết thời gian reset');
    assert.ok(msgs.some((m) => String(m).includes('capacity on this model')));
  });

  test('HAI dòng cùng mã 429 vẫn phân biệt được nhau', () => {
    // Đây chính là điều mã số không làm được — và là lý do có cột này.
    const b429 = doc().filter((r) => r.status === 429);
    assert.equal(b429.length, 2);
    assert.notEqual(b429[0]!.err, b429[1]!.err, 'hai lỗi 429 khác bản chất mà lưu giống nhau thì vô dụng');
  });

  test('request THÀNH CÔNG không lưu err', () => {
    // Ghi err cho dòng ok chỉ tổ phình bảng và làm nhiễu bộ lọc "chỉ xem lỗi".
    const ok = doc().find((r) => r.ok === 1)!;
    assert.equal(ok.err, null);
  });

  test('dòng ok=false nhưng gọi không kèm err → null, không crash', () => {
    ghi({ ok: false, status: 500 });
    const r = doc().find((x) => x.status === 500)!;
    assert.equal(r.err, null);
  });

  test('CẮT 300 ký tự: trang HTML lỗi không được phình bảng', () => {
    /**
     * Đã gặp thật: `Kiro refresh 403: <!DOCTYPE HTML…` kèm nguyên trang. Không cắt thì
     * mỗi lỗi loại này tốn vài KB, mà lúc hỏng hàng loạt là hàng trăm dòng một lúc.
     */
    ghi({ ok: false, status: 403, err: '<!DOCTYPE HTML>' + 'x'.repeat(5000) });
    const r = doc().find((x) => x.status === 403)!;
    assert.equal(String(r.err).length, 300);
    assert.ok(String(r.err).startsWith('<!DOCTYPE HTML>'), 'cắt phần ĐUÔI, giữ phần đầu để còn nhận dạng');
  });
});

describe('giữ usage vĩnh viễn', () => {
  test('pruneUsage(0) KHÔNG xoá gì', () => {
    const truoc = (db.prepare('SELECT COUNT(*) n FROM gateway_usage').get() as { n: number }).n;
    assert.ok(truoc > 0);
    // Dòng cũ 10 năm vẫn phải sống sót — đó chính là ý nghĩa của "vĩnh viễn".
    ghi({ ts: NOW - 3650 * 86400_000, ok: true, status: 200 });
    assert.equal(pruneUsage(0), 0);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM gateway_usage').get() as { n: number }).n, truoc + 1);
  });

  test('pruneUsage(n) với n>0 vẫn dọn được — người dùng vẫn tự đặt hạn được', () => {
    assert.ok(pruneUsage(30) > 0, 'dòng 10 năm tuổi phải bị dọn khi đặt hạn 30 ngày');
  });

  test('mặc định cấu hình là 0 (vĩnh viễn), không phải 90', () => {
    const cfg = readFileSync(resolve(ROOT, 'src/config.ts'), 'utf8');
    const m = cfg.match(/usageRetentionDays: num\(.*$/m);
    assert.ok(m, 'không tìm thấy khai báo usageRetentionDays');
    assert.match(m![0], /, 0\),$/, `mặc định phải là 0 = giữ vĩnh viễn, đang là: ${m![0]}`);
  });

  test('quota_history thì NGƯỢC LẠI — vẫn dọn theo hạn', () => {
    /**
     * quota_history sinh 12.311 dòng/ngày (gấp 4 lần usage) mà chỉ dùng vẽ biểu đồ xu
     * hướng, không dùng chẩn đoán. Giữ vĩnh viễn cả hai là đổi disk lấy thứ không cần.
     */
    const bg = readFileSync(resolve(ROOT, 'src/gateway/background.ts'), 'utf8');
    assert.match(bg, /pruneQuotaHistory\(config\.gateway\.quota\?\.historyDays \?\? 90\)/);
  });
});

describe('đường đi của err từ upstream tới DB', () => {
  test('engine truyền e.message vào afterCall', () => {
    // Không có dòng này thì cột err luôn null — bảng có cột mà không bao giờ có dữ liệu.
    const eng = readFileSync(resolve(ROOT, 'src/gateway/engine.ts'), 'utf8');
    assert.match(eng, /ok: false, ms, status: e\?\.status, err: e\?\.message/);
  });

  test('CSV export có cột err, và ở CUỐI dòng', () => {
    // Chèn giữa sẽ phá script người dùng đang parse theo vị trí cột.
    // Export CSV nằm ở `reports.ts` (nhóm báo cáo), tách khỏi `admin.ts` từ đợt chia file.
    const adm = readFileSync(resolve(ROOT, 'src/gateway/reports.ts'), 'utf8');
    const head = adm.match(/const head = '([^']+)\\n';/)![1]!;
    assert.ok(head.endsWith(',err'), `err phải là cột cuối, đang là: ${head}`);
  });
});

describe('bocLoi — gỡ lớp JSON lồng nhau', () => {
  /**
   * Cắt thẳng 300 ký tự là KHÔNG đủ. Đo thật trên production 11/08: lỗi vượt trần token
   * về dưới dạng lồng BA lớp, nên 300 ký tự đầu chỉ toàn vỏ `{"error":{"code":400,…` —
   * còn câu giải thích thật thì nằm sâu bên trong và bị cắt mất. Đúng thứ tính năng này
   * sinh ra để giữ lại.
   */
  const THAT = 'generateContent 400: ' + JSON.stringify({
    error: {
      code: 400,
      status: 'INVALID_ARGUMENT',
      details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'generation_config.max_output_tokens', description: 'value out of range' }] }],
      message: JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens' },
      }),
    },
  });

  test('lỗi THẬT từ production: giữ được câu có ích, bỏ vỏ JSON', () => {
    const r = bocLoi(THAT);
    assert.match(r, /max_tokens: 200000 > 128000/, 'mất đúng phần cần nhất');
    assert.ok(!r.includes('{"error"'), `còn sót vỏ JSON: ${r}`);
  });

  test('câu có ích phải sống sót SAU khi cắt 300 ký tự', () => {
    // Đây mới là điều thật sự quan trọng — bóc mà vẫn bị cắt mất thì vô nghĩa.
    assert.doesNotMatch(THAT.slice(0, 300), /max_tokens: 200000/, 'nếu cắt thẳng vẫn giữ được thì hàm này thừa');
    assert.match(bocLoi(THAT).slice(0, 300), /max_tokens: 200000 > 128000/, 'bóc rồi mà vẫn mất thì công cốc');
  });

  test('giữ tiền tố ngoài JSON làm ngữ cảnh', () => {
    assert.match(bocLoi(THAT), /^generateContent 400: /, 'mất mã lỗi gốc thì khó lần ngược');
  });

  test('lỗi văn xuôi (không JSON) → giữ nguyên văn', () => {
    const s = 'Individual quota reached for this account, resets in 83h34m';
    assert.equal(bocLoi(s), s);
  });

  test('HTML → giữ nguyên, không crash', () => {
    const s = 'Kiro refresh 403: <!DOCTYPE HTML><html><body>Forbidden</body></html>';
    assert.equal(bocLoi(s), s);
  });

  test('JSON hỏng giữa chừng → giữ nguyên, không nuốt lỗi', () => {
    const s = 'boom 500: {"error": {"message": "chua dong ngoac';
    assert.equal(bocLoi(s), s);
  });

  test('một lớp JSON đơn giản vẫn bóc được', () => {
    assert.equal(bocLoi('{"error":{"message":"quota exhausted"}}'), 'quota exhausted');
  });

  test('không lặp vô hạn với cấu trúc tự lồng', () => {
    // Trần 6 vòng: upstream trả kiểu này thì hàm phải dừng, không treo tiến trình.
    // 12 lớp: đủ vượt trần 6 vòng. 40 lớp thì chính JSON.stringify nổ bộ nhớ lúc DỰNG
    // dữ liệu — hỏng ở test chứ không chạm tới hàm cần kiểm.
    let s = '"day la day"';
    for (let i = 0; i < 12; i++) s = JSON.stringify({ error: { message: s } });
    const t0 = Date.now();
    bocLoi(s);
    assert.ok(Date.now() - t0 < 1000, 'phải dừng nhanh, không gỡ hết 12 lớp');
  });

  test('recordGatewayUsage LƯU bản đã bóc, không lưu bản thô', () => {
    ghi({ ok: false, status: 400, err: THAT });
    const r = usageLogs(NOW - 2 * GIO, NOW, {}, 100, 0).rows.find(
      (x) => (x as Record<string, unknown>).status === 400,
    ) as Record<string, unknown>;
    assert.match(String(r.err), /max_tokens: 200000 > 128000/, 'ghi vào DB mà vẫn là JSON thô thì bóc ở đâu cũng vô ích');
  });
});
