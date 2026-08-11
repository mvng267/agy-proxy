import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * `quota_history` phải TÁCH THEO PROVIDER.
 *
 * Bảng chỉ khoá theo `email`, mà MỖI email có CẢ HAI credential — đo trên production:
 * credentials.csv có 351 dòng `agy` + 351 dòng `kiro`. Nên bản ghi mới nhất của một email
 * đè lên bản ghi provider kia, và mọi truy vấn "quota mới nhất mỗi account" chỉ thấy MỘT
 * NỬA pool.
 *
 * Nặng hơn: `quotaSeries` gộp cả hai vào một trung bình. Đo thật 11/08/2026 — biểu đồ vẽ
 * "Gemini 45%" trong khi agy còn 1% và kr còn 91%. Trung bình cộng của hai bể có hạn mức
 * và chu kỳ reset khác hẳn nhau thì không mô tả cái gì cả, mà lại làm người xem tưởng
 * quota còn thoải mái đúng lúc một bể đã cạn.
 *
 * AGY_HOME sang thư mục tạm TRƯỚC mọi import — xem test/data-safety.test.ts.
 */
const TMP = mkdtempSync(resolve(tmpdir(), 'agy-qp-'));
process.env.AGY_HOME = TMP;

const { db, recordQuota, quotaSeries, quotaForAccount, runMigrations, addColumnIfMissing } =
  await import('../../src/store/db.js');

const ROOT = resolve(import.meta.dirname, '../..');
const NOW = Date.now();
const GIO = 3600_000;

after(() => rmSync(TMP, { recursive: true, force: true }));

before(() => {
  db.exec('DELETE FROM quota_history');
  // Cùng MỘT email, hai provider — đúng hình dạng dữ liệu thật trên production.
  recordQuota({ ts: NOW - GIO, email: 'a@t', provider: 'agy', tier: 'Antigravity Starter Quota', geminiPct: 1, thirdPct: 27 });
  recordQuota({ ts: NOW - GIO, email: 'a@t', provider: 'kr', tier: 'KIRO FREE', geminiPct: 91, thirdPct: null });
  recordQuota({ ts: NOW - GIO, email: 'b@t', provider: 'agy', tier: 'Antigravity Starter Quota', geminiPct: 3, thirdPct: 31 });
  recordQuota({ ts: NOW - GIO, email: 'b@t', provider: 'kr', tier: 'KIRO FREE', geminiPct: 89, thirdPct: null });
});

describe('quotaSeries — tách theo provider', () => {
  test('KHÔNG gộp hai provider vào một trung bình', () => {
    /**
     * Đây chính là bug. Gộp agy(1,3) với kr(91,89) cho trung bình 46% — con số không mô tả
     * bể nào cả, mà nhìn vào tưởng quota còn thoải mái.
     */
    const s = quotaSeries(NOW - 2 * GIO, NOW, 'hour');
    const agy = s.find((x) => x.provider === 'agy')!;
    const kr = s.find((x) => x.provider === 'kr')!;
    assert.ok(agy, 'thiếu dòng agy');
    assert.ok(kr, 'thiếu dòng kr');
    assert.equal(agy.gemini, 2, 'agy: TB của 1% và 3%');
    assert.equal(kr.gemini, 90, 'kr: TB của 91% và 89%');
    assert.notEqual(agy.gemini, kr.gemini, 'hai provider phải cho hai số khác nhau');
  });

  test('không có provider nào cho ra con số gộp 46%', () => {
    // Bảo hiểm trực tiếp chống việc quay lại cách gộp cũ.
    for (const x of quotaSeries(NOW - 2 * GIO, NOW, 'hour')) {
      assert.notEqual(x.gemini, 46, 'đây là trung bình GỘP — bug đã quay lại');
    }
  });

  test('lọc theo một provider', () => {
    const s = quotaSeries(NOW - 2 * GIO, NOW, 'hour', 'agy');
    assert.equal(s.length, 1);
    assert.equal(s[0]!.provider, 'agy');
    assert.equal(s[0]!.gemini, 2);
  });

  test('mỗi điểm mang provider của nó', () => {
    for (const x of quotaSeries(NOW - 2 * GIO, NOW, 'hour')) {
      assert.ok(x.provider, 'điểm không có provider thì UI không biết vẽ vào đường nào');
    }
  });
});

describe('quotaForAccount — một email có HAI đường quota', () => {
  test('không lọc → trả cả hai provider (giữ tương thích)', () => {
    const r = quotaForAccount('a@t', NOW - 2 * GIO, NOW);
    assert.equal(r.length, 2);
  });

  test('lọc provider → chỉ đường của provider đó', () => {
    // Không lọc thì agy 1% và kr 91% vẽ chung một nét, nhìn như dao động loạn xạ.
    const agy = quotaForAccount('a@t', NOW - 2 * GIO, NOW, 'agy');
    assert.equal(agy.length, 1);
    assert.equal(agy[0]!.gemini_pct, 1);
    const kr = quotaForAccount('a@t', NOW - 2 * GIO, NOW, 'kr');
    assert.equal(kr[0]!.gemini_pct, 91);
  });

  test('hàng trả về có cột provider', () => {
    assert.equal(quotaForAccount('a@t', NOW - 2 * GIO, NOW, 'kr')[0]!.provider, 'kr');
  });
});

describe('migration v6 — backfill dữ liệu cũ từ tier', () => {
  /** DB giả lập trạng thái TRƯỚC migration: có dữ liệu, chưa có cột provider. */
  function dbCu() {
    const d = new DatabaseSync(':memory:');
    d.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE quota_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, email TEXT NOT NULL,
        tier TEXT, gemini_pct INTEGER, third_pct INTEGER, models_json TEXT
      );
      CREATE TABLE runs (id INTEGER PRIMARY KEY, email TEXT, flow TEXT, status TEXT, started_at TEXT);
      CREATE TABLE gateway_usage (id INTEGER PRIMARY KEY, ts INTEGER, email TEXT, model TEXT);
    `);
    const ins = d.prepare(`INSERT INTO quota_history (ts, email, tier, gemini_pct, third_pct) VALUES (?,?,?,?,?)`);
    ins.run(NOW, 'a@t', 'KIRO FREE', 91, null);
    ins.run(NOW, 'a@t', 'Antigravity Starter Quota', 1, 27);
    // 1.529 dòng trên production có tier chứa THẲNG 'agy'/'kr' — engine.ts từng ghi
    // `tier: a.provider`. Chúng cũng phải suy ra được.
    ins.run(NOW, 'b@t', 'agy', null, null);
    ins.run(NOW, 'b@t', 'kr', null, null);
    ins.run(NOW, 'c@t', 'standard-tier', 50, null); // không suy được → NULL
    return d;
  }

  test('thêm cột provider và backfill đúng từ tier', () => {
    const d = dbCu();
    runMigrations(d);
    const rows = d.prepare(`SELECT tier, provider FROM quota_history ORDER BY id`).all() as Array<{ tier: string; provider: string | null }>;
    assert.equal(rows[0]!.provider, 'kr', "'KIRO FREE' → kr");
    assert.equal(rows[1]!.provider, 'agy', "'Antigravity Starter Quota' → agy");
    assert.equal(rows[2]!.provider, 'agy', "tier chứa thẳng 'agy'");
    assert.equal(rows[3]!.provider, 'kr', "tier chứa thẳng 'kr'");
    assert.equal(rows[4]!.provider, null, 'tier lạ → NULL, KHÔNG đoán bừa');
  });

  test('KHÔNG xoá dòng nào — 5 dòng cũ còn nguyên', () => {
    // Backfill mà mất dữ liệu lịch sử thì mất luôn đường cơ sở để đối chiếu.
    const d = dbCu();
    const truoc = (d.prepare(`SELECT COUNT(*) n FROM quota_history`).get() as { n: number }).n;
    runMigrations(d);
    assert.equal((d.prepare(`SELECT COUNT(*) n FROM quota_history`).get() as { n: number }).n, truoc);
  });

  test('chạy LẠI không hỏng gì (idempotent)', () => {
    /**
     * DB đang chạy chưa có khoá `schemaVersion` nên coi như v0 và runner chạy lại TOÀN BỘ
     * migration — trên DB đã có sẵn cột vẫn phải an toàn.
     */
    const d = dbCu();
    runMigrations(d);
    d.prepare(`DELETE FROM settings WHERE key = 'schemaVersion'`).run();
    runMigrations(d); // lần hai, coi như v0
    const rows = d.prepare(`SELECT provider FROM quota_history ORDER BY id`).all() as Array<{ provider: string | null }>;
    assert.equal(rows[0]!.provider, 'kr');
    assert.equal(rows.length, 5);
  });

  test('KHÔNG ghi đè provider đã có', () => {
    // Migration chạy lại không được đạp lên dữ liệu mới ghi đúng.
    const d = dbCu();
    runMigrations(d);
    d.prepare(`UPDATE quota_history SET provider = 'no' WHERE id = 5`).run();
    d.prepare(`DELETE FROM settings WHERE key = 'schemaVersion'`).run();
    runMigrations(d);
    const r = d.prepare(`SELECT provider FROM quota_history WHERE id = 5`).get() as { provider: string };
    assert.equal(r.provider, 'no', 'đã có provider thì giữ nguyên');
  });

  test('addColumnIfMissing báo đúng khi cột đã tồn tại', () => {
    const d = dbCu();
    assert.equal(addColumnIfMissing(d, 'quota_history', 'provider', 'TEXT'), true, 'lần đầu: thêm');
    assert.equal(addColumnIfMissing(d, 'quota_history', 'provider', 'TEXT'), false, 'lần hai: đã có');
  });
});

describe('nguồn ghi — provider phải tới đúng cột', () => {
  const doc = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');

  test('pool.ts truyền provider của account', () => {
    assert.match(doc('src/gateway/pool.ts'), /provider: account\.provider/);
  });

  test('engine.ts KHÔNG còn nhét provider vào cột tier', () => {
    /**
     * `tier: a.provider` làm cột tier mang hai nghĩa — production có 1.529 dòng
     * tier='agy'/'kr' lẫn với tên gói thật.
     */
    // BỎ COMMENT trước khi soi: chính lời giải thích "trước đây nhét vào tier" cũng chứa
    // đúng chuỗi đó, nên soi cả comment là bắt nhầm văn bản của mình.
    const eng = doc('src/gateway/engine.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(eng, /tier: a\.provider/, 'vẫn ghi provider vào cột tier');
    assert.match(eng, /provider: a\.provider/);
  });
});
