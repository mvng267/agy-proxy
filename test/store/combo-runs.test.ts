import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Đọc lịch sử chạy combo — TỪNG BƯỚC.
 *
 * `combo_runs` ghi đủ chi tiết từ lâu (engine.ts ghi ở cả nhánh thành công lẫn nhánh trượt)
 * nhưng hàm đọc DUY NHẤT là `comboStatsRows`, chỉ trả hai con số tổng. Production có 19.180
 * dòng nằm im, và khi đọc được ra thì lộ ngay:
 *
 *   bước 0  agy/gemini-3.5-flash-low         12.245 lần ·  56% trượt · p95 63s
 *   bước 1  agy/gemini-3.5-flash-extra-low    6.828 lần · 100% trượt · p95 54s
 *
 * Bước 1 CHƯA THÀNH CÔNG lần nào mà vẫn tốn ~54 giây cho mỗi request đi qua nó. Không có
 * hàm này thì không cách nào biết.
 *
 * AGY_HOME sang thư mục tạm TRƯỚC mọi import — xem test/data-safety.test.ts.
 */
const TMP = mkdtempSync(resolve(tmpdir(), 'agy-cr-'));
process.env.AGY_HOME = TMP;

const { db, recordComboRun, comboRuns, comboStepStats, comboRunFacets } =
  await import('../../src/store/db.js');

const ROOT = resolve(import.meta.dirname, '../..');
const NOW = Date.now();
const GIO = 3600_000;

after(() => rmSync(TMP, { recursive: true, force: true }));

before(() => {
  db.exec('DELETE FROM combo_runs');
  const ghi = (o: Parameters<typeof recordComboRun>[0], ts = NOW - GIO) => {
    recordComboRun(o);
    // recordComboRun tự đặt ts = now; ép về mốc test để lọc theo khoảng kiểm được.
    db.prepare('UPDATE combo_runs SET ts = ? WHERE id = (SELECT MAX(id) FROM combo_runs)').run(ts);
  };

  // Hình dạng THẬT: bước 0 hay trượt, bước 1 luôn trượt, bước 2 cứu được.
  for (let i = 0; i < 6; i++) ghi({ combo: 'combo/t', step: 0, model: 'agy/a', ok: false, status: 429, ms: 50, reason: 'quota' });
  for (let i = 0; i < 4; i++) ghi({ combo: 'combo/t', step: 0, model: 'agy/a', ok: true, ms: (i + 1) * 1000 });
  for (let i = 0; i < 5; i++) ghi({ combo: 'combo/t', step: 1, model: 'agy/b', ok: false, status: 429, ms: 30 });
  for (let i = 0; i < 3; i++) ghi({ combo: 'combo/t', step: 2, model: 'kr/c', ok: true, ms: 500 });
  ghi({ combo: 'combo/khac', step: 0, model: 'kr/c', ok: true, ms: 200 });
  // Ngoài khoảng — không được lọt vào kết quả.
  ghi({ combo: 'combo/cu', step: 0, model: 'agy/a', ok: true, ms: 100 }, NOW - 40 * 24 * GIO);
});

describe('comboRuns — dòng thô, phân trang server', () => {
  test('trả đúng số dòng trong khoảng, bỏ dòng ngoài khoảng', () => {
    const r = comboRuns(NOW - 2 * GIO, NOW);
    assert.equal(r.total, 19, 'dòng 40 ngày trước không được lọt vào');
    assert.equal(r.rows.length, 19);
  });

  test('phân trang: limit + offset', () => {
    const p1 = comboRuns(NOW - 2 * GIO, NOW, {}, 5, 0);
    const p2 = comboRuns(NOW - 2 * GIO, NOW, {}, 5, 5);
    assert.equal(p1.rows.length, 5);
    assert.equal(p2.rows.length, 5);
    assert.equal(p1.total, p2.total, 'total KHÔNG đổi theo trang');
    assert.notDeepEqual(p1.rows[0], p2.rows[0], 'hai trang phải khác nhau');
  });

  test('limit bị chặn trên 500 — không cho kéo cả bảng về', () => {
    // 19.180 dòng trên production; không chặn thì một request kéo hết là treo trình duyệt.
    assert.ok(comboRuns(NOW - 2 * GIO, NOW, {}, 99_999, 0).rows.length <= 500);
  });

  test('lọc theo combo', () => {
    assert.equal(comboRuns(NOW - 2 * GIO, NOW, { combo: 'combo/khac' }).total, 1);
  });

  test('lọc CHỈ bước trượt — câu hỏi hay dùng nhất', () => {
    const r = comboRuns(NOW - 2 * GIO, NOW, { ok: '0' });
    assert.equal(r.total, 11, '6 bước 0 + 5 bước 1');
    assert.ok(r.rows.every((x) => x.ok === 0));
  });

  test('lọc chỉ bước thành công', () => {
    assert.equal(comboRuns(NOW - 2 * GIO, NOW, { ok: '1' }).total, 8);
  });

  test('ok rỗng hoặc giá trị lạ → KHÔNG lọc (không loại nhầm hết)', () => {
    for (const v of ['', 'abc', '2']) {
      assert.equal(comboRuns(NOW - 2 * GIO, NOW, { ok: v }).total, 19, `ok='${v}' không được lọc`);
    }
  });

  test('lọc theo model và status', () => {
    assert.equal(comboRuns(NOW - 2 * GIO, NOW, { model: 'agy/b' }).total, 5);
    assert.equal(comboRuns(NOW - 2 * GIO, NOW, { status: '429' }).total, 11);
  });

  test('nhiều tiêu chí là AND, không phải OR', () => {
    const r = comboRuns(NOW - 2 * GIO, NOW, { combo: 'combo/t', model: 'agy/a', ok: '1' });
    assert.equal(r.total, 4, 'OR sẽ ra nhiều hơn hẳn');
  });

  test('sắp xếp mới nhất trước', () => {
    const rows = comboRuns(NOW - 2 * GIO, NOW).rows;
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1]!.ts >= rows[i]!.ts, 'thứ tự phải giảm dần theo thời gian');
    }
  });
});

describe('comboStepStats — BƯỚC NÀO hay trượt', () => {
  const tim = (step: number, model: string) =>
    comboStepStats(NOW - 2 * GIO, NOW).find((s) => s.combo === 'combo/t' && s.step === step && s.model === model)!;

  test('gộp theo (combo, bước, model)', () => {
    const s = tim(0, 'agy/a');
    assert.equal(s.runs, 10, '6 trượt + 4 thành công');
    assert.equal(s.fails, 6);
  });

  test('bước trượt 100% lộ ra rõ — đây là bước VÔ DỤNG', () => {
    /**
     * Chính là ca đã tìm thấy trên production: bước 1 gọi 6.828 lần, không lần nào thành
     * công, mà vẫn tốn ~54 giây p95 cho mỗi request đi qua.
     */
    const s = tim(1, 'agy/b');
    assert.equal(s.runs, 5);
    assert.equal(s.fails, 5);
    assert.equal(s.fails / s.runs, 1);
  });

  test('p50/p95 tính trên bước THÀNH CÔNG', () => {
    /**
     * Bước trượt trả về gần như tức thì (429 mất 50ms). Gộp vào sẽ kéo số xuống và che
     * mất việc model đang chậm — đúng thứ cần nhìn thấy.
     */
    const s = tim(0, 'agy/a');
    // 4 mẫu thành công: 1000, 2000, 3000, 4000 → p50 = phần tử thứ 3, p95 = thứ 4.
    assert.equal(s.p50, 3000);
    assert.equal(s.p95, 4000);
    assert.ok(s.p50 > 50, 'lẫn bước trượt 50ms vào là méo số');
  });

  test('bước KHÔNG có lần nào thành công → p95 = 0, không crash', () => {
    const s = tim(1, 'agy/b');
    assert.equal(s.p95, 0, 'không có mẫu thì không bịa ra số');
  });

  test('không trộn hai combo vào một dòng', () => {
    const all = comboStepStats(NOW - 2 * GIO, NOW);
    assert.ok(all.some((s) => s.combo === 'combo/khac'));
    assert.equal(all.filter((s) => s.combo === 'combo/t').length, 3, 'combo/t có 3 (bước, model)');
  });

  test('lọc combo áp cho cả thống kê', () => {
    const s = comboStepStats(NOW - 2 * GIO, NOW, { combo: 'combo/khac' });
    assert.equal(s.length, 1);
  });
});

describe('comboRunFacets — dropdown chỉ liệt kê thứ CÓ THẬT', () => {
  test('trả combo/model/status kèm số lần', () => {
    const f = comboRunFacets(NOW - 2 * GIO, NOW);
    assert.equal(f.combos.length, 2);
    assert.equal(f.models.length, 3);
    // node:sqlite trả object null-prototype → deepEqual với object literal luôn lệch.
    assert.equal(f.statuses.length, 1);
    assert.equal(f.statuses[0]!.value, 429);
    assert.equal(f.statuses[0]!.n, 11);
  });

  test('status NULL không lọt vào danh sách', () => {
    // Mời người dùng lọc theo "null" là bẫy — bảng sẽ rỗng mà không hiểu vì sao.
    const f = comboRunFacets(NOW - 2 * GIO, NOW);
    assert.ok(f.statuses.every((s) => s.value != null));
  });
});

describe('endpoint + frontend', () => {
  const doc = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');

  test('GET /api/combos/runs có mặt', () => {
    assert.match(doc('src/gateway/admin.ts'), /app\.get\('\/api\/combos\/runs'/);
  });

  test('endpoint trả cả rows, steps và facets', () => {
    const i = doc('src/gateway/admin.ts').indexOf("'/api/combos/runs'");
    const seg = doc('src/gateway/admin.ts').slice(i, i + 1400);
    for (const k of ['rows', 'total', 'steps:', 'facets:']) {
      assert.ok(seg.includes(k), `endpoint thiếu ${k}`);
    }
  });

  test('frontend KHAI BÁO calls/fallbacks — backend tính sẵn mà từng bị vứt', () => {
    /**
     * `admin.ts` trả hai số này cho mỗi combo từ lâu; interface cũ không khai nên chúng
     * biến mất. Production: `translate-question` 11.703 gọi / 6.828 trượt không hiện ở đâu.
     */
    const src = doc('web/src/components/pages/Combo.tsx');
    assert.match(src, /calls\?: number/);
    assert.match(src, /fallbacks\?: number/);
    assert.match(src, /key: "calls"/, 'khai báo thôi chưa đủ — phải có cột hiển thị');
  });

  test('autoVariants là MẢNG, không phải boolean', () => {
    /**
     * Backend trả `["auto","auto/fast","auto/quota","auto/stable"]`. Khai boolean rồi
     * render `? "On" : "Off"` thì mảng luôn truthy → thẻ KPI luôn hiện "On", vô nghĩa.
     */
    // BỎ COMMENT trước khi soi: lời giải thích "bản trước render ? On : Off" cũng chứa
    // đúng chuỗi đó, soi cả comment là bắt nhầm văn bản của mình.
    const src = doc('web/src/components/pages/Combo.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.match(src, /autoVariants\?: string\[\]/);
    assert.doesNotMatch(src, /autoVariants \? "On" : "Off"/, 'vẫn render như cờ boolean');
  });

  test('đường kẻ cạnh nút mở/đóng sidebar đã bỏ', () => {
    const app = doc('web/src/App.tsx');
    assert.doesNotMatch(app, /<Separator orientation="vertical"/);
    assert.doesNotMatch(app, /from "@\/components\/ui\/separator"/, 'import thừa còn sót');
  });

  test('nút chạy thử dùng /api/gateway/chat sẵn có, không thêm endpoint', () => {
    // Endpoint đó ĐÃ trả `steps[]` (model, ok, ms, error) — đúng thứ cần.
    const src = doc('web/src/components/pages/Combo.tsx');
    assert.match(src, /\/api\/gateway\/chat/);
    assert.match(src, /steps: j\.steps \?\? \[\]/);
  });
});
