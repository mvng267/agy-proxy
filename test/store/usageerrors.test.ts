import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Gom lỗi theo THÔNG ĐIỆP — trả lời "đang lỗi gì" mà không phải cuộn log thô.
 *
 * Câu hỏi vận hành số một là *đang lỗi gì*, và hiện không có đường nào trả lời: `err` chỉ
 * hiện từng dòng rời rạc. Suốt đợt chẩn đoán vừa rồi tôi phải tải log về rồi viết script
 * node gom tay — chính cách đó rút 4.977 dòng xuống 10 nhóm và tìm ra rằng 4.278 cái là
 * HTTP 429 cũ chứ không phải bug đang chạy.
 *
 * ─── Chuẩn hoá là MẤU CHỐT ─────────────────────────────────────────────────────
 *
 * Thông điệp upstream nhúng số biến thiên:
 *     "Individual quota reached. … Resets in 164h53m59s."
 *     "Individual quota reached. … Resets in 12h04m11s."
 *     "stream 429 (retry sau 567655s)"
 *
 * Gom thô ⇒ mỗi request một nhóm riêng, bảng vô dụng. Phải thay số bằng `N` trước khi gom.
 */

const TMP = mkdtempSync(resolve(tmpdir(), 'agy-ue-'));
process.env.AGY_HOME = TMP;

let db: typeof import('../../src/store/db.js');

before(async () => {
  db = await import('../../src/store/db.js');
  db.db.exec('DELETE FROM gateway_usage');
});
after(() => rmSync(TMP, { recursive: true, force: true }));

const ghi = (err: string | undefined, o: Partial<{ model: string; status: number; ok: boolean; ts: number }> = {}) =>
  db.recordGatewayUsage({
    ts: o.ts ?? Date.now(),
    email: 'a@t',
    model: o.model ?? 'agy/gemini-3.5-flash-low',
    promptTokens: 1, completionTokens: 1,
    ok: o.ok ?? false,
    ms: 10,
    status: o.status ?? 429,
    err,
  } as never);

describe('chuanHoaLoi — gom được thông điệp chỉ khác con số', () => {
  test('hai lần "Resets in …" khác nhau về MỘT nhóm', () => {
    const a = db.chuanHoaLoi('Individual quota reached. Resets in 164h53m59s.');
    const b = db.chuanHoaLoi('Individual quota reached. Resets in 12h04m11s.');
    assert.equal(a, b, 'khác giờ reset nhưng là cùng một lỗi');
  });

  test('"retry sau Ns" cũng gom được', () => {
    assert.equal(db.chuanHoaLoi('stream 429 (retry sau 567655s)'), db.chuanHoaLoi('stream 429 (retry sau 12s)'));
  });

  test('lỗi KHÁC BẢN CHẤT thì KHÔNG gom nhầm', () => {
    /**
     * Chuẩn hoá quá tay còn tệ hơn không chuẩn hoá: gộp hai lỗi khác nhau làm một thì
     * bảng nói dối.
     */
    const a = db.chuanHoaLoi('Kiro 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD: Input is too long.');
    const b = db.chuanHoaLoi('Kiro 429 INSUFFICIENT_MODEL_CAPACITY: I am experiencing high traffic.');
    assert.notEqual(a, b);
  });

  test('bóc được JSON lồng — dùng lại bocLoi', () => {
    const s = db.chuanHoaLoi('generateContent 429: { "error": { "code": 429, "message": "Individual quota reached." } }');
    assert.doesNotMatch(s, /\{/, 'phải bóc hết vỏ JSON');
    assert.match(s, /quota reached/i);
  });

  test('chuỗi rỗng / thiếu → nhãn rõ ràng, không phải chuỗi trống', () => {
    // 4.310/4.977 dòng lỗi trên production KHÔNG ghi lý do — chúng phải hiện thành một
    // nhóm có tên, không phải một ô trống không ai hiểu.
    assert.match(db.chuanHoaLoi(''), /\S/);
    assert.match(db.chuanHoaLoi(undefined as never), /\S/);
  });
});

describe('usageErrors — bảng gom lỗi', () => {
  test('gom đúng số lần, xếp nhiều nhất trước', () => {
    db.db.exec('DELETE FROM gateway_usage');
    for (let i = 0; i < 5; i++) ghi(`Individual quota reached. Resets in ${i}h30m.`);
    for (let i = 0; i < 2; i++) ghi('Kiro 429 INSUFFICIENT_MODEL_CAPACITY: high traffic.');

    const r = db.usageErrors(0, Date.now() + 1000);
    assert.equal(r.length, 2, 'phải gom thành đúng 2 nhóm');
    assert.equal(r[0]!.n, 5, 'nhóm lớn nhất phải đứng đầu');
    assert.equal(r[1]!.n, 2);
  });

  test('kèm model và mã HTTP dính lỗi đó', () => {
    db.db.exec('DELETE FROM gateway_usage');
    ghi('loi chung', { model: 'agy/a', status: 429 });
    ghi('loi chung', { model: 'kr/b', status: 400 });

    const r = db.usageErrors(0, Date.now() + 1000);
    assert.equal(r.length, 1);
    assert.deepEqual([...r[0]!.models].sort(), ['agy/a', 'kr/b']);
    assert.deepEqual([...r[0]!.statuses].sort((x, y) => x - y), [400, 429]);
  });

  test('có lanDau / lanCuoi để biết lỗi còn đang xảy ra không', () => {
    /**
     * Quan trọng hơn vẻ ngoài: production có 4.310 lỗi 429 nhưng TOÀN BỘ từ ngày 10-11/08,
     * trước bản vá. Không có mốc thời gian thì chúng trông y hệt lỗi đang cháy.
     */
    db.db.exec('DELETE FROM gateway_usage');
    const cu = Date.now() - 5 * 86400_000;
    ghi('cung mot loi', { ts: cu });
    ghi('cung mot loi', { ts: Date.now() });

    const r = db.usageErrors(0, Date.now() + 1000);
    assert.equal(r[0]!.n, 2);
    assert.ok(r[0]!.lanDau <= cu + 1000, 'lanDau phải là lần sớm nhất');
    assert.ok(r[0]!.lanCuoi > cu + 1000, 'lanCuoi phải là lần gần nhất');
  });

  test('CHỈ lấy dòng lỗi, bỏ qua phiên thành công', () => {
    db.db.exec('DELETE FROM gateway_usage');
    ghi('that bai', { ok: false });
    ghi(undefined, { ok: true });
    const r = db.usageErrors(0, Date.now() + 1000);
    assert.equal(r.reduce((s, x) => s + x.n, 0), 1);
  });

  test('tôn trọng bộ lọc dùng chung', () => {
    db.db.exec('DELETE FROM gateway_usage');
    ghi('loi agy', { model: 'agy/x' });
    ghi('loi kiro', { model: 'kr/y' });
    const r = db.usageErrors(0, Date.now() + 1000, { provider: 'kr' });
    assert.equal(r.length, 1);
    assert.match(r[0]!.err, /kiro/);
  });

  test('giữ một ví dụ NGUYÊN VĂN — chuẩn hoá làm mất chi tiết', () => {
    // Nhóm cho biết "lỗi gì", ví dụ nguyên văn cho biết "cụ thể ra sao" (reset lúc nào).
    db.db.exec('DELETE FROM gateway_usage');
    ghi('Individual quota reached. Resets in 164h53m59s.');
    const r = db.usageErrors(0, Date.now() + 1000);
    assert.match(r[0]!.viDu, /164h53m59s/);
  });
});
