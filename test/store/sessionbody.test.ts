import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Lưu NỘI DUNG từng phiên gửi/nhận.
 *
 * Vì sao cần: `gateway_usage` có 14 cột nhưng KHÔNG cột nào chứa nội dung. Thứ gần nhất là
 * `err` — cắt còn 300 ký tự và chỉ ghi khi thất bại. Live Log thì stream-and-forget:
 * không buffer, không replay, trình duyệt giữ 500 dòng rồi F5 là mất.
 *
 * Hệ quả: gặp lỗi thật thì không biết client gửi gì, nên không biết vì sao upstream từ
 * chối. Suốt đợt chẩn đoán vừa rồi phải tải log về rồi đoán từ metadata.
 *
 * ─── Ràng buộc dung lượng, KHÔNG phải chi tiết phụ ────────────────────────────
 *
 * Đo kích thước request thật trên production (mẫu 500 dòng):
 *
 *     promptTokens      trung vị 4.746 · p90 68.224 · lớn nhất 136.053
 *     completionTokens  trung vị   262 · p90  1.659 · lớn nhất   4.932
 *
 * Lưu nguyên văn ⇒ trung vị ~20 KB/phiên, p90 **273 KB/phiên**. Với 3.000 phiên/ngày là
 * 57 MB/ngày ≈ **1,7 GB/tháng**. Nên mặc định CHỈ ghi khi lỗi — 11 lỗi/3 ngày là gần như
 * miễn phí, mà mỗi cái đều đáng đọc; còn 13.000 phiên thành công thì không ai mở ra xem.
 */

const TMP = mkdtempSync(resolve(tmpdir(), 'agy-sb-'));
process.env.AGY_HOME = TMP;

let db: typeof import('../../src/store/db.js');

before(async () => {
  db = await import('../../src/store/db.js');
});
after(() => rmSync(TMP, { recursive: true, force: true }));

describe('nenGhiThan — ba mức, mặc định chỉ ghi khi lỗi', () => {
  test('off: không ghi gì, kể cả khi lỗi', () => {
    assert.equal(db.nenGhiThan('off', true), false);
    assert.equal(db.nenGhiThan('off', false), false);
  });

  test('error (mặc định): chỉ ghi phiên LỖI', () => {
    assert.equal(db.nenGhiThan('error', false), true, 'phiên lỗi phải ghi');
    assert.equal(db.nenGhiThan('error', true), false, 'phiên thành công KHÔNG ghi');
  });

  test('all: ghi mọi phiên', () => {
    assert.equal(db.nenGhiThan('all', true), true);
    assert.equal(db.nenGhiThan('all', false), true);
  });

  test('giá trị lạ → coi như "error", không tự bật ghi hết', () => {
    // Cấu hình hỏng không được biến thành 1,7 GB/tháng.
    assert.equal(db.nenGhiThan('linh tinh' as never, true), false);
    assert.equal(db.nenGhiThan(undefined as never, false), true);
  });
});

describe('catThan — cắt có trần, giữ được cả đầu lẫn cuối', () => {
  test('ngắn hơn trần thì giữ nguyên', () => {
    const s = 'xin chào';
    const r = db.catThan(s, 64);
    assert.equal(r.text, s);
    assert.equal(r.truncated, false);
    assert.equal(r.bytes, Buffer.byteLength(s));
  });

  test('dài hơn trần thì cắt, và GIỮ CẢ HAI ĐẦU', () => {
    /**
     * Giữ đầu để biết request bắt đầu bằng gì (system prompt, model), giữ cuối vì lỗi
     * hầu như luôn nằm ở message cuối — cắt mất đuôi là mất đúng chỗ cần đọc.
     */
    const s = 'A'.repeat(5000) + 'CUOI_CUNG';
    const r = db.catThan(s, 1);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length < s.length);
    assert.ok(r.text.startsWith('A'), 'phải giữ phần đầu');
    assert.ok(r.text.includes('CUOI_CUNG'), 'phải giữ phần cuối');
    assert.match(r.text, /cắt/, 'phải nói rõ đã cắt bao nhiêu');
  });

  test('bytes luôn là kích thước GỐC, không phải sau khi cắt', () => {
    const s = 'B'.repeat(10_000);
    const r = db.catThan(s, 1);
    assert.equal(r.bytes, 10_000, 'phải giữ kích thước thật để biết đã mất bao nhiêu');
  });
});

describe('locBiMat — không ghi khoá xuống đĩa', () => {
  test('xoá authorization / x-api-key / cookie', () => {
    /**
     * Thân phiên được lưu xuống đĩa và hiện lên dashboard. Header xác thực lọt vào đó là
     * rò khoá — và `credentials.csv` của repo này đã đủ nhạy cảm rồi.
     */
    const v = db.locBiMat({
      model: 'kr/claude-sonnet-4.5',
      headers: { authorization: 'Bearer sk-that', 'x-api-key': 'agy-that', cookie: 'sid=1', 'content-type': 'application/json' },
    });
    const s = JSON.stringify(v);
    assert.doesNotMatch(s, /sk-that/);
    assert.doesNotMatch(s, /agy-that/);
    assert.doesNotMatch(s, /sid=1/);
    assert.match(s, /content-type/, 'header vô hại phải giữ lại');
  });

  test('không phân biệt hoa thường', () => {
    const v = db.locBiMat({ headers: { Authorization: 'Bearer x', 'X-Api-Key': 'y' } });
    assert.doesNotMatch(JSON.stringify(v), /Bearer x|"y"/);
  });

  test('giữ nguyên phần còn lại của body', () => {
    const v = db.locBiMat({ model: 'm', messages: [{ role: 'user', content: 'noi dung that' }] }) as Record<string, unknown>;
    assert.match(JSON.stringify(v), /noi dung that/);
    assert.equal(v.model, 'm');
  });
});

describe('ghi và đọc thân phiên', () => {
  test('ghi rồi đọc lại đúng theo requestId', () => {
    db.ghiThanPhien({
      requestId: 'req-1', ts: Date.now(),
      reqBody: '{"messages":[{"role":"user","content":"hỏi"}]}',
      resBody: '{"text":"đáp"}',
      truncated: false, bytes: 42,
    });
    const r = db.thanPhien('req-1');
    assert.ok(r, 'phải đọc lại được');
    assert.match(r!.reqBody ?? '', /hỏi/);
    assert.match(r!.resBody ?? '', /đáp/);
    assert.equal(r!.bytes, 42);
  });

  test('requestId không tồn tại → undefined, không ném', () => {
    assert.equal(db.thanPhien('khong-co'), undefined);
  });

  test('ghi hai lần cùng requestId thì KHÔNG nhân đôi', () => {
    // Combo nhiều bước dùng chung requestId — không được sinh N dòng thân.
    db.ghiThanPhien({ requestId: 'req-2', ts: Date.now(), reqBody: 'a', resBody: '1', truncated: false, bytes: 1 });
    db.ghiThanPhien({ requestId: 'req-2', ts: Date.now(), reqBody: 'b', resBody: '2', truncated: false, bytes: 1 });
    const n = db.db.prepare('SELECT COUNT(*) n FROM session_body WHERE request_id = ?').get('req-2') as { n: number };
    assert.equal(n.n, 1);
  });
});

describe('pruneSessionBody — bảng mới PHẢI dọn được ngay từ đầu', () => {
  test('xoá dòng quá hạn, giữ dòng mới', () => {
    /**
     * `combo_runs`, `runs`, `run_logs` hiện KHÔNG có hàm prune nào và phình vô hạn
     * (`combo_runs` đã 19.180 dòng trên production). Bảng này không lặp lại vết đó.
     */
    const cu = Date.now() - 30 * 86400_000;
    db.ghiThanPhien({ requestId: 'cu-1', ts: cu, reqBody: 'x', resBody: 'y', truncated: false, bytes: 1 });
    db.ghiThanPhien({ requestId: 'moi-1', ts: Date.now(), reqBody: 'x', resBody: 'y', truncated: false, bytes: 1 });

    const n = db.pruneSessionBody(7);
    assert.ok(n >= 1, 'phải xoá ít nhất dòng 30 ngày tuổi');
    assert.equal(db.thanPhien('cu-1'), undefined, 'dòng cũ phải mất');
    assert.ok(db.thanPhien('moi-1'), 'dòng mới phải còn');
  });

  test('days <= 0 nghĩa là giữ vĩnh viễn — không xoá gì', () => {
    // Cùng quy ước với `pruneUsage` để người vận hành không phải nhớ hai luật.
    db.ghiThanPhien({ requestId: 'giu-1', ts: 1, reqBody: 'x', resBody: 'y', truncated: false, bytes: 1 });
    assert.equal(db.pruneSessionBody(0), 0);
    assert.ok(db.thanPhien('giu-1'));
  });
});
