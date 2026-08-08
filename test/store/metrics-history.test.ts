import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

/**
 * `metrics_history` + luật "gộp thô quá thì tự hạ mức mịn hơn".
 *
 * Bug thật đã đo trên production: bảng `quota_history` có 14.633 điểm nhưng TẤT CẢ rơi
 * vào cùng một ngày, nên gộp theo ngày trả về ĐÚNG 1 điểm — và một điểm thì không vẽ
 * thành đường. Khung "Xu hướng toàn pool" vì thế luôn trống dù dữ liệu đầy ắp, khiến
 * người xem tưởng job nạp quota hỏng. Cùng dữ liệu đó gộp theo giờ cho 14 điểm.
 *
 * Test dùng ':memory:' và SQL y hệt bản thật thay vì import store — store mở DB thật
 * lúc import, không cô lập được.
 */

function mkDb() {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE metrics_history (
      ts INTEGER PRIMARY KEY, rps REAL, error_rate REAL,
      p50 INTEGER, p95 INTEGER, p99 INTEGER,
      requests INTEGER, errors INTEGER, acc_total INTEGER, acc_available INTEGER
    );
    CREATE TABLE quota_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, email TEXT NOT NULL,
      tier TEXT, gemini_pct INTEGER, third_pct INTEGER, models_json TEXT, probe_ok INTEGER
    );
  `);
  return d;
}

/** Bản sao SQL của `quotaSeries` — giữ đồng bộ với src/store/db.ts. */
const quotaSeries = (d: DatabaseSync, from: number, to: number, groupBy: 'hour' | 'day') =>
  d.prepare(
    `SELECT strftime('${groupBy === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d'}', ts/1000, 'unixepoch', 'localtime') AS bucket,
            ROUND(AVG(gemini_pct)) AS gemini, COUNT(*) AS n
     FROM quota_history WHERE ts >= ? AND ts < ? GROUP BY bucket ORDER BY bucket ASC`,
  ).all(from, to) as any[];

describe('gộp chuỗi thời gian: thô quá thì chart trống', () => {
  test('nhiều nghìn điểm dồn trong 1 ngày → gộp NGÀY ra 1 điểm, gộp GIỜ ra nhiều', () => {
    const d = mkDb();
    // Mô phỏng đúng hình dạng dữ liệu production: dày đặc trong ~14 giờ của một ngày.
    const base = Date.UTC(2026, 7, 8, 3, 0, 0);
    const ins = d.prepare(`INSERT INTO quota_history (ts, email, gemini_pct) VALUES (?,?,?)`);
    for (let h = 0; h < 14; h++) {
      for (let i = 0; i < 50; i++) ins.run(base + h * 3600_000 + i * 1000, `a${i}@x.vn`, 80 + (h % 15));
    }
    const from = base - 7 * 86400_000;
    const to = base + 86400_000;

    const byDay = quotaSeries(d, from, to, 'day');
    const byHour = quotaSeries(d, from, to, 'hour');

    assert.equal(byDay.length, 1, 'gộp ngày phải ra đúng 1 điểm — đây là gốc của khung trống');
    assert.ok(byHour.length >= 10, `gộp giờ phải ra nhiều điểm, có ${byHour.length}`);
    // Luật ở admin.ts: <3 điểm thì hạ xuống mức mịn hơn.
    assert.ok(byDay.length < 3 && byHour.length > byDay.length, 'điều kiện tự hạ mức phải đúng');
    d.close();
  });
});

describe('metrics_history', () => {
  test('ts là PRIMARY KEY: ghi trùng mốc phút thì ĐÈ, không sinh dòng thừa', () => {
    const d = mkDb();
    const up = d.prepare(
      `INSERT INTO metrics_history (ts, rps, requests) VALUES (?,?,?)
       ON CONFLICT(ts) DO UPDATE SET rps=excluded.rps, requests=excluded.requests`,
    );
    // Job nền làm tròn ts về mốc phút; hai lần chụp trong cùng phút phải gộp làm một,
    // nếu không mỗi lần restart server lại thêm một điểm lệch nhịp vào cùng thời khắc.
    up.run(60_000, 1.5, 10);
    up.run(60_000, 2.5, 20);
    const rows = d.prepare(`SELECT * FROM metrics_history`).all() as any[];
    assert.equal(rows.length, 1, 'phải chỉ còn 1 dòng');
    assert.equal(rows[0].rps, 2.5, 'giá trị mới phải đè giá trị cũ');
    d.close();
  });

  test('gộp: latency lấy MAX chứ không AVG', () => {
    const d = mkDb();
    const ins = d.prepare(`INSERT INTO metrics_history (ts, p99) VALUES (?,?)`);
    const t = Date.UTC(2026, 7, 8, 10, 0, 0);
    ins.run(t, 100); ins.run(t + 60_000, 5000); ins.run(t + 120_000, 100);

    const r = d.prepare(
      `SELECT MAX(p99) AS peak, ROUND(AVG(p99)) AS mean FROM metrics_history`,
    ).get() as any;
    // Trung bình của phân vị là số vô nghĩa và làm phẳng mất đỉnh — 5000ms là thứ cần
    // nhìn thấy, không phải 1733ms.
    assert.equal(r.peak, 5000);
    assert.notEqual(r.mean, r.peak, 'AVG che mất đỉnh — lý do dùng MAX');
    d.close();
  });
});
