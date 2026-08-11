import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Bảng tổng hợp usage phải mang cả CHẤT LƯỢNG, không chỉ số đếm.
 *
 * Bản trước hằng số `AGG` chỉ có `COUNT(*)` + `SUM(token)`, nên `ms` và `ok` — ghi cho
 * mọi request từ lâu — không xuất hiện ở bất kỳ tổng hợp nào. Hậu quả đo được trên
 * production: `agy/claude-sonnet-4-6` có 2581/3338 request LỖI (77%) và p95 = 19 giây,
 * mà trang Báo cáo chỉ hiện "3338 request" — nhìn vào tưởng mọi thứ bình thường.
 *
 * AGY_HOME sang thư mục tạm TRƯỚC mọi import — xem test/data-safety.test.ts.
 */
const TMP = mkdtempSync(resolve(tmpdir(), 'agy-agg-'));
process.env.AGY_HOME = TMP;

const { db, recordGatewayUsage, usageByModel, usageByAccount, usageSeries, usageTotals } =
  await import('../../src/store/db.js');

const NOW = Date.now();
const GIO = 3600_000;

after(() => rmSync(TMP, { recursive: true, force: true }));

before(() => {
  db.exec('DELETE FROM gateway_usage');
  const add = (o: Partial<Parameters<typeof recordGatewayUsage>[0]> & { ms: number; ok: boolean }) =>
    recordGatewayUsage({
      ts: NOW - GIO, email: 'a@t', model: 'agy/x', promptTokens: 10, completionTokens: 5,
      ...o,
    } as any);

  // model 'agy/x': 10 thành công với ms 100..1000, + 5 lỗi (ms nhỏ, như 429 thật)
  for (let i = 1; i <= 10; i++) add({ ms: i * 100, ok: true });
  for (let i = 0; i < 5; i++) add({ ms: 20, ok: false, status: 429 });
  // model 'agy/y': toàn thành công, nhanh
  for (let i = 0; i < 4; i++) add({ model: 'agy/y', ms: 50, ok: true });
  // account thứ hai để kiểm tách nhóm
  add({ email: 'b@t', model: 'agy/y', ms: 900, ok: true });
});

describe('usageByModel — có tỉ lệ lỗi và độ trễ', () => {
  test('đếm ĐÚNG số lỗi, không lẫn vào requests', () => {
    const x = usageByModel(NOW - 2 * GIO, NOW).find((r) => r.model === 'agy/x')!;
    assert.equal(x.requests, 15, 'requests là TỔNG, gồm cả lỗi');
    assert.equal(x.errors, 5);
  });

  test('avgMs chỉ tính request THÀNH CÔNG', () => {
    /**
     * Request lỗi (429/401) trả về gần như tức thì. Gộp chúng vào trung bình sẽ kéo
     * con số xuống và che mất việc model đang chậm — đúng thứ ta cần nhìn thấy.
     * 10 request ok: 100..1000 → trung bình 550. Nếu tính cả 5 lỗi (20ms) → 373.
     */
    const x = usageByModel(NOW - 2 * GIO, NOW).find((r) => r.model === 'agy/x')!;
    assert.equal(x.avgMs, 550, 'lẫn request lỗi vào là méo số');
  });

  test('p50/p95 tính trên request thành công, đã sắp xếp', () => {
    const x = usageByModel(NOW - 2 * GIO, NOW).find((r) => r.model === 'agy/x')!;
    // 10 mẫu: floor(10*0.5)=5 → phần tử thứ 6 = 600; floor(10*0.95)=9 → thứ 10 = 1000.
    assert.equal(x.p50, 600);
    assert.equal(x.p95, 1000);
  });

  test('mỗi model một nhóm riêng, không trộn', () => {
    const rows = usageByModel(NOW - 2 * GIO, NOW);
    const y = rows.find((r) => r.model === 'agy/y')!;
    assert.equal(y.requests, 5);
    assert.equal(y.errors, 0);
    assert.notEqual(y.p95, rows.find((r) => r.model === 'agy/x')!.p95, 'hai model phải có p95 khác nhau');
  });

  test('model không có request thành công → p95 = 0, không crash', () => {
    recordGatewayUsage({ ts: NOW - GIO, email: 'c@t', model: 'agy/toanloi', promptTokens: 1, completionTokens: 0, ok: false, ms: 5, status: 500 } as any);
    const z = usageByModel(NOW - 2 * GIO, NOW).find((r) => r.model === 'agy/toanloi')!;
    assert.equal(z.requests, 1);
    assert.equal(z.errors, 1);
    assert.equal(z.p95, 0, 'không có mẫu thành công thì không bịa ra số');
    assert.equal(z.avgMs, 0);
  });
});

describe('usageByAccount — cùng bộ số', () => {
  test('tách theo account, kèm p95', () => {
    const rows = usageByAccount(NOW - 2 * GIO, NOW);
    const a = rows.find((r) => r.email === 'a@t')!;
    assert.equal(a.errors, 5);
    assert.ok(a.p95! > 0);
    const b = rows.find((r) => r.email === 'b@t')!;
    assert.equal(b.requests, 1);
    assert.equal(b.p95, 900);
  });
});

describe('usageSeries — gộp theo giờ', () => {
  test("groupBy='hour' cho bucket dạng YYYY-MM-DD HH:00", () => {
    // Gộp theo ngày cho khoảng 24 giờ thì chart chỉ có 1-2 cột — vô dụng.
    const s = usageSeries(NOW - 2 * GIO, NOW, 'hour');
    assert.ok(s.length > 0);
    assert.match(s[0]!.bucket, /^\d{4}-\d{2}-\d{2} \d{2}:00$/);
  });

  test("groupBy='day' vẫn cho bucket dạng ngày", () => {
    const s = usageSeries(NOW - 2 * GIO, NOW, 'day');
    assert.match(s[0]!.bucket, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('series cũng mang errors và avgMs', () => {
    const s = usageSeries(NOW - 2 * GIO, NOW, 'hour');
    assert.ok(s.some((x) => x.errors > 0), 'thiếu errors thì không vẽ được tỉ lệ lỗi theo thời gian');
    assert.ok(s.every((x) => typeof x.avgMs === 'number'));
  });
});

describe('usageTotals', () => {
  test('tổng gồm errors và avgMs', () => {
    const t = usageTotals(NOW - 2 * GIO, NOW) as any;
    assert.equal(t.errors, 6, '5 lỗi của agy/x + 1 của agy/toanloi');
    assert.ok(t.avgMs > 0);
  });
});
