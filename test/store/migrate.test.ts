import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, addColumnIfMissing } from '../../src/store/db.js';

/**
 * Runner migration phải IDEMPOTENT: DB đang chạy production chưa có khoá `schemaVersion`
 * nên bị coi là v0 và toàn bộ migration sẽ chạy lại trên dữ liệu đã có sẵn cột.
 * Test dùng ':memory:' để không đụng DB thật.
 */

/**
 * Dựng DB tối thiểu đủ cho các migration chạy. Cột phải khớp schema thật ở
 * src/store/db.ts — migration v3 tạo index trên (api_key_id, ts) nên `ts` là bắt buộc.
 */
function mkDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, email TEXT);
    CREATE TABLE quota_history (id INTEGER PRIMARY KEY, ts INTEGER);
    CREATE TABLE gateway_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL DEFAULT 0,
      email TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 1,
      ms INTEGER NOT NULL DEFAULT 0
    );
  `);
  return d;
}

const version = (d: DatabaseSync) =>
  Number((d.prepare(`SELECT value FROM settings WHERE key='schemaVersion'`).get() as any)?.value ?? 0);

test('runMigrations: lần đầu chạy hết, lần hai không chạy lại', () => {
  const d = mkDb();
  const first = runMigrations(d);
  assert.ok(first.length > 0, 'lần đầu phải chạy ít nhất 1 migration');
  const v = version(d);

  const second = runMigrations(d);
  assert.deepEqual(second, [], 'lần hai không được chạy migration nào');
  assert.equal(version(d), v, 'schemaVersion không đổi ở lần hai');
  d.close();
});

test('runMigrations: thêm đúng cột và không ném khi cột đã tồn tại', () => {
  const d = mkDb();
  runMigrations(d);
  const runsCols = (d.prepare(`PRAGMA table_info(runs)`).all() as any[]).map((c) => c.name);
  const qhCols = (d.prepare(`PRAGMA table_info(quota_history)`).all() as any[]).map((c) => c.name);
  assert.ok(runsCols.includes('proxy'));
  assert.ok(qhCols.includes('probe_ok'));

  // Ép chạy lại từ v0 trên DB ĐÃ có cột — đây là đúng tình huống DB production.
  d.prepare(`DELETE FROM settings WHERE key='schemaVersion'`).run();
  assert.doesNotThrow(() => runMigrations(d));
  d.close();
});

test('migration prefix model: chỉ thêm agy/ cho id chưa có prefix', () => {
  const d = mkDb();
  d.prepare(`INSERT INTO gateway_usage (model) VALUES (?)`).run('gemini-2.5-flash');
  d.prepare(`INSERT INTO gateway_usage (model) VALUES (?)`).run('kr/claude-sonnet-4.5');
  runMigrations(d);

  const models = (d.prepare(`SELECT model FROM gateway_usage ORDER BY id`).all() as any[]).map((r) => r.model);
  assert.deepEqual(models, ['agy/gemini-2.5-flash', 'kr/claude-sonnet-4.5']);
  d.close();
});

test('migration prefix model: KHÔNG chạy lại khi cờ cũ đã có (DB migrate trước khi có runner)', () => {
  const d = mkDb();
  d.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('migratedUsageModelPrefix','1',0)`).run();
  d.prepare(`INSERT INTO gateway_usage (model) VALUES (?)`).run('bare-model');
  runMigrations(d);
  const m = (d.prepare(`SELECT model FROM gateway_usage`).get() as any).model;
  assert.equal(m, 'bare-model', 'cờ cũ phải chặn migration chạy lại');
  d.close();
});

test('v3: tạo bảng api_keys + cột attribution, dữ liệu usage cũ vẫn hợp lệ', () => {
  const d = mkDb();
  // Dòng usage "cũ" ghi TRƯỚC migration — sau migration phải còn nguyên, cột mới = NULL.
  d.prepare(`INSERT INTO gateway_usage (ts, email, model) VALUES (?,?,?)`).run(1000, 'a@x', 'agy/x');
  runMigrations(d);

  const usageCols = (d.prepare(`PRAGMA table_info(gateway_usage)`).all() as any[]).map((c) => c.name);
  for (const c of ['api_key_id', 'combo', 'endpoint', 'status', 'request_id', 'stream']) {
    assert.ok(usageCols.includes(c), `thiếu cột ${c}`);
  }

  const keyCols = (d.prepare(`PRAGMA table_info(api_keys)`).all() as any[]).map((c) => c.name);
  assert.deepEqual(keyCols.sort(), ['created_at', 'enabled', 'hash', 'id', 'last_used', 'name', 'note', 'prefix']);

  const old = d.prepare(`SELECT * FROM gateway_usage WHERE ts = 1000`).get() as any;
  assert.equal(old.model, 'agy/x', 'dòng cũ phải còn nguyên');
  assert.equal(old.api_key_id, null, 'cột mới phải NULL, không phá dữ liệu cũ');
  d.close();
});

test('addColumnIfMissing: trả true lần đầu, false lần sau', () => {
  const d = mkDb();
  assert.equal(addColumnIfMissing(d, 'runs', 'note', 'TEXT'), true);
  assert.equal(addColumnIfMissing(d, 'runs', 'note', 'TEXT'), false);
  d.close();
});
