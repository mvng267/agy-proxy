import { DatabaseSync } from 'node:sqlite';
import { STATE_DB } from '../paths.js';

/**
 * State runtime (không phải nguồn backup — cái đó là CSV).
 * Giữ lịch sử run + log để dashboard hiển thị và để đếm cap/ngày.
 */
export const db = new DatabaseSync(STATE_DB);

// WAL + busy_timeout: cho phép nhiều tiến trình (server + CLI + test) cùng đọc/ghi
// mà không bị "database is locked".
try {
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;`);
} catch {
  /* filesystem không hỗ trợ WAL → dùng mặc định */
}

db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    flow TEXT NOT NULL,
    status TEXT NOT NULL,          -- queued|running|paused_needs_human|ok|failed
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    proxy TEXT                     -- label proxy (hoặc 'direct') để throttle theo IP
  );
  CREATE TABLE IF NOT EXISTS run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,           -- info|warn|error|challenge
    msg TEXT NOT NULL,
    screenshot TEXT
  );
  CREATE TABLE IF NOT EXISTS gateway_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,             -- epoch ms
    email TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 1,   -- 1 thành công, 0 lỗi
    ms INTEGER NOT NULL DEFAULT 0
  );
  -- Cấu hình lưu bền (thay settings.json): mọi thay đổi từ UI sống qua restart
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- Phiên đăng nhập (thu hồi được)
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    ua TEXT
  );
  -- Log đăng nhập (thành công/thất bại) + chống brute-force
  CREATE TABLE IF NOT EXISTS auth_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    ip TEXT,
    ua TEXT,
    ok INTEGER NOT NULL,
    reason TEXT
  );
  -- Lịch sử hạn mức theo thời gian
  CREATE TABLE IF NOT EXISTS quota_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    email TEXT NOT NULL,
    tier TEXT,
    gemini_pct INTEGER,
    third_pct INTEGER,
    models_json TEXT
  );
  -- Combo: chuỗi model gọi được như 1 id, tự fallback
  CREATE TABLE IF NOT EXISTS combos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    strategy TEXT NOT NULL,
    targets_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- Vết chạy combo: vì sao trượt bước nào (hiện trên UI)
  CREATE TABLE IF NOT EXISTS combo_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, combo TEXT NOT NULL, step INTEGER NOT NULL,
    model TEXT NOT NULL, ok INTEGER NOT NULL, status INTEGER, ms INTEGER, reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_combo_runs_ts ON combo_runs(ts);
  CREATE INDEX IF NOT EXISTS idx_runs_email ON runs(email);
  CREATE INDEX IF NOT EXISTS idx_logs_run ON run_logs(run_id);
  CREATE INDEX IF NOT EXISTS idx_usage_ts ON gateway_usage(ts);
  CREATE INDEX IF NOT EXISTS idx_qh_ts ON quota_history(ts);
  CREATE INDEX IF NOT EXISTS idx_qh_email ON quota_history(email, ts);
  CREATE INDEX IF NOT EXISTS idx_authlog_ts ON auth_log(ts);
`);

// ---------------------------------------------------------------------------
// Migration có version
// ---------------------------------------------------------------------------

/** DB tối thiểu mà runner cần — nhận tham số để test được với ':memory:'. */
type MigDb = Pick<DatabaseSync, 'exec' | 'prepare'>;

/**
 * Thêm cột nếu CHƯA có, kiểm bằng PRAGMA thay vì try/catch quanh ALTER TABLE.
 * Cách cũ nuốt MỌI lỗi — kể cả disk full hay DB lock — nên hỏng thật cũng im lặng.
 */
export function addColumnIfMissing(d: MigDb, table: string, col: string, decl: string): boolean {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === col)) return false;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  return true;
}

function schemaVersion(d: MigDb): number {
  const r = d.prepare(`SELECT value FROM settings WHERE key = 'schemaVersion'`).get() as { value?: string } | undefined;
  return Number(r?.value ?? 0) || 0;
}

function setSchemaVersion(d: MigDb, v: number): void {
  d.prepare(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run('schemaVersion', String(v), Date.now());
}

/**
 * Danh sách migration theo thứ tự version tăng dần.
 *
 * Mỗi `up` PHẢI idempotent: DB đang chạy chưa có khoá `schemaVersion` nên coi như v0,
 * runner sẽ chạy lại toàn bộ — trên DB đã có sẵn cột/dữ liệu thì vẫn phải an toàn.
 */
const MIGRATIONS: Array<{ v: number; name: string; up: (d: MigDb) => void }> = [
  {
    v: 1,
    name: 'cột proxy cho runs + probe_ok cho quota_history',
    up: (d) => {
      addColumnIfMissing(d, 'runs', 'proxy', 'TEXT');
      addColumnIfMissing(d, 'quota_history', 'probe_ok', 'INTEGER');
    },
  },
  {
    v: 2,
    // Bắt buộc vì agy có claude-sonnet-4-6 còn Kiro có claude-sonnet-4 — không prefix thì
    // báo cáo trộn 2 provider. KHÔNG dùng trigger/normalize lúc đọc (test ghi id trần sau khi load).
    name: 'thêm prefix agy/ cho model id cũ trong gateway_usage',
    up: (d) => {
      // Giữ cờ cũ: DB đã migrate trước khi có runner thì bỏ qua, tránh chạy lại vô ích.
      const done = d.prepare(`SELECT value FROM settings WHERE key = 'migratedUsageModelPrefix'`).get();
      if (done) return;
      d.exec(`UPDATE gateway_usage SET model = 'agy/' || model WHERE model NOT LIKE '%/%'`);
      d.prepare(
        `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      ).run('migratedUsageModelPrefix', '1', Date.now());
    },
  },
  {
    v: 3,
    name: 'bảng api_keys + cột attribution cho gateway_usage',
    up: (d) => {
      // Nhiều API key có nhãn, mỗi key một user. Chỉ để ĐỊNH DANH cho báo cáo —
      // không giới hạn hạn mức, không phân quyền model.
      d.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          prefix     TEXT NOT NULL,
          hash       TEXT NOT NULL,
          enabled    INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          last_used  INTEGER,
          note       TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_apikeys_prefix ON api_keys(prefix);
      `);

      // Mọi cột NULL-able → 7746 dòng usage cũ vẫn hợp lệ, không cần backfill.
      // request_id nối các bước combo của CÙNG một request client (combo lỗi 3 bước
      // rồi thành công tạo 4 dòng — trước đây không cách nào biết chúng cùng gốc).
      addColumnIfMissing(d, 'gateway_usage', 'api_key_id', 'TEXT');
      addColumnIfMissing(d, 'gateway_usage', 'combo', 'TEXT');
      addColumnIfMissing(d, 'gateway_usage', 'endpoint', 'TEXT');
      addColumnIfMissing(d, 'gateway_usage', 'status', 'INTEGER');
      addColumnIfMissing(d, 'gateway_usage', 'request_id', 'TEXT');
      addColumnIfMissing(d, 'gateway_usage', 'stream', 'INTEGER');

      // Chỉ index cột thực sự dùng để lọc. KHÔNG index endpoint/status:
      // chọn lọc kém, chỉ tốn chi phí ghi.
      d.exec(`
        CREATE INDEX IF NOT EXISTS idx_usage_key_ts   ON gateway_usage(api_key_id, ts);
        CREATE INDEX IF NOT EXISTS idx_usage_combo_ts ON gateway_usage(combo, ts);
        CREATE INDEX IF NOT EXISTS idx_usage_req      ON gateway_usage(request_id);
      `);
    },
  },
];

/** Chạy mọi migration chưa áp dụng. Trả về danh sách version đã chạy. */
export function runMigrations(d: MigDb): number[] {
  const from = schemaVersion(d);
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.v <= from) continue;
    m.up(d);
    setSchemaVersion(d, m.v);
    ran.push(m.v);
  }
  return ran;
}

// Chạy lúc load module. Bọc try/catch: migration lỗi KHÔNG được làm server không lên được —
// ghi lỗi ra stderr rồi để lần khởi động sau thử lại.
try {
  runMigrations(db);
} catch (e) {
  console.error('[migration] lỗi:', e instanceof Error ? e.message : e);
}

export interface RunRow {
  id: number;
  email: string;
  flow: string;
  status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export function createRun(email: string, flow: string, proxy = 'direct'): number {
  const stmt = db.prepare(
    `INSERT INTO runs (email, flow, status, started_at, proxy) VALUES (?, ?, 'running', ?, ?)`,
  );
  const info = stmt.run(email, flow, new Date().toISOString(), proxy);
  return Number(info.lastInsertRowid);
}

export function updateRun(id: number, status: string, error?: string): void {
  const finished = status === 'ok' || status === 'failed' ? new Date().toISOString() : null;
  db.prepare(`UPDATE runs SET status = ?, error = ?, finished_at = ? WHERE id = ?`).run(
    status,
    error ?? null,
    finished,
    id,
  );
}

export function addLog(
  runId: number,
  level: string,
  msg: string,
  screenshot?: string,
): void {
  db.prepare(
    `INSERT INTO run_logs (run_id, ts, level, msg, screenshot) VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, new Date().toISOString(), level, msg, screenshot ?? null);
}

export function getRun(id: number): RunRow | undefined {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as unknown as RunRow | undefined;
}

export function recentRuns(limit = 50): RunRow[] {
  return db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT ?`).all(limit) as unknown as RunRow[];
}

export function runLogs(runId: number): unknown[] {
  return db.prepare(`SELECT * FROM run_logs WHERE run_id = ? ORDER BY id ASC`).all(runId);
}

const LOGIN_FLOWS = "('google','agy','kiro')";

/** Tổng số login thành công (mọi flow có đăng nhập) trong 24h — cho hiển thị. */
export function loginsLast24h(): number {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE flow IN ${LOGIN_FLOWS} AND status = 'ok' AND started_at >= ?`,
    )
    .get(since) as unknown as { n: number };
  return row.n;
}

/** Số login thành công theo TỪNG proxy/IP trong 24h — cho throttle chống checkpoint chain. */
export function loginsLast24hByProxy(proxy: string): number {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE flow IN ${LOGIN_FLOWS} AND status = 'ok' AND proxy = ? AND started_at >= ?`,
    )
    .get(proxy, since) as unknown as { n: number };
  return row.n;
}

// ---------- gateway usage (báo cáo theo ngày/tuần/account/model) ----------
export interface UsageRow {
  ts: number;
  email: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  ok: boolean;
  ms: number;
  /** Attribution (từ schema v3) — optional để mọi call-site cũ vẫn hợp lệ. */
  apiKeyId?: string;
  /** Tên combo nếu request đi qua combo/auto (`combo/x`, `auto/fast`…). */
  combo?: string;
  endpoint?: string;
  status?: number;
  /** Nối các bước combo của CÙNG một request client. */
  requestId?: string;
  stream?: boolean;
}
export function recordGatewayUsage(r: UsageRow): void {
  db.prepare(
    `INSERT INTO gateway_usage
       (ts, email, model, prompt_tokens, completion_tokens, ok, ms,
        api_key_id, combo, endpoint, status, request_id, stream)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    r.ts, r.email, r.model, r.promptTokens | 0, r.completionTokens | 0, r.ok ? 1 : 0, r.ms | 0,
    r.apiKeyId ?? null, r.combo ?? null, r.endpoint ?? null,
    r.status ?? null, r.requestId ?? null, r.stream == null ? null : r.stream ? 1 : 0,
  );
}

const AGG = `COUNT(*) AS requests, COALESCE(SUM(prompt_tokens),0) AS tokIn, COALESCE(SUM(completion_tokens),0) AS tokOut`;

/** Bộ lọc báo cáo. Trường bỏ trống = không lọc theo tiêu chí đó. */
export interface UsageFilter {
  apiKeyId?: string;
  combo?: string;
}

/** Dựng mệnh đề WHERE động — dùng chung cho mọi hàm tổng hợp. */
function usageWhere(f?: UsageFilter): { sql: string; args: unknown[] } {
  const args: unknown[] = [];
  let sql = '';
  if (f?.apiKeyId) {
    sql += ' AND api_key_id = ?';
    args.push(f.apiKeyId);
  }
  if (f?.combo) {
    sql += ' AND combo = ?';
    args.push(f.combo);
  }
  return { sql, args };
}

export function usageTotals(from: number, to: number, f?: UsageFilter): { requests: number; tokIn: number; tokOut: number; accounts: number } {
  const w = usageWhere(f);
  const row = db
    .prepare(`SELECT ${AGG}, COUNT(DISTINCT email) AS accounts FROM gateway_usage WHERE ts >= ? AND ts < ?${w.sql}`)
    .get(from, to, ...(w.args as any[])) as any;
  return { requests: row.requests, tokIn: row.tokIn, tokOut: row.tokOut, accounts: row.accounts };
}

/** Chuỗi thời gian theo ngày hoặc tuần (mốc YYYY-MM-DD hoặc YYYY-Www). */
export function usageSeries(from: number, to: number, groupBy: 'day' | 'week', f?: UsageFilter): { bucket: string; requests: number; tokIn: number; tokOut: number }[] {
  // ts epoch ms → chuỗi ngày/tuần theo local: dùng strftime với ts/1000 (unixepoch).
  const fmt = groupBy === 'week' ? "%Y-W%W" : "%Y-%m-%d";
  const w = usageWhere(f);
  return db
    .prepare(
      `SELECT strftime('${fmt}', ts/1000, 'unixepoch', 'localtime') AS bucket, ${AGG}
       FROM gateway_usage WHERE ts >= ? AND ts < ?${w.sql} GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(from, to, ...(w.args as any[])) as any[];
}

export function usageByModel(from: number, to: number, f?: UsageFilter): { model: string; requests: number; tokIn: number; tokOut: number }[] {
  const w = usageWhere(f);
  return db
    .prepare(`SELECT model, ${AGG} FROM gateway_usage WHERE ts >= ? AND ts < ?${w.sql} GROUP BY model ORDER BY requests DESC`)
    .all(from, to, ...(w.args as any[])) as any[];
}

export function usageByAccount(from: number, to: number, f?: UsageFilter): { email: string; requests: number; tokIn: number; tokOut: number }[] {
  const w = usageWhere(f);
  return db
    .prepare(`SELECT email, ${AGG} FROM gateway_usage WHERE ts >= ? AND ts < ?${w.sql} GROUP BY email ORDER BY requests DESC`)
    .all(from, to, ...(w.args as any[])) as any[];
}

/** Thống kê theo API key — nguồn cho báo cáo "ai tiêu bao nhiêu". */
export function usageByApiKey(from: number, to: number, f?: UsageFilter): { apiKeyId: string; requests: number; tokIn: number; tokOut: number }[] {
  const w = usageWhere(f);
  return db
    .prepare(
      `SELECT COALESCE(api_key_id,'') AS apiKeyId, ${AGG} FROM gateway_usage
       WHERE ts >= ? AND ts < ?${w.sql} GROUP BY apiKeyId ORDER BY requests DESC`,
    )
    .all(from, to, ...(w.args as any[])) as any[];
}

/**
 * Thống kê theo combo. Chỉ đếm dòng CÓ combo — dòng gọi model trực tiếp không
 * thuộc combo nào nên đưa vào sẽ làm sai tỉ lệ.
 */
export function usageByCombo(from: number, to: number, f?: UsageFilter): { combo: string; requests: number; tokIn: number; tokOut: number }[] {
  const w = usageWhere(f);
  return db
    .prepare(
      `SELECT combo, ${AGG} FROM gateway_usage
       WHERE ts >= ? AND ts < ? AND combo IS NOT NULL${w.sql} GROUP BY combo ORDER BY requests DESC`,
    )
    .all(from, to, ...(w.args as any[])) as any[];
}

/**
 * Thời điểm sớm nhất có dữ liệu attribution (api_key_id/combo).
 * Dòng usage ghi TRƯỚC schema v3 không có các cột này — UI cần mốc để chú thích
 * "dữ liệu trước ngày X không có thông tin key", tránh người dùng tưởng báo cáo hỏng.
 */
export function attributionSince(): number | null {
  const r = db
    .prepare(`SELECT MIN(ts) AS ts FROM gateway_usage WHERE api_key_id IS NOT NULL`)
    .get() as { ts?: number | null } | undefined;
  return r?.ts ?? null;
}

/**
 * Xoá usage cũ hơn `days`. Bảng này TRƯỚC ĐÂY không bao giờ được dọn — chỉ lớn dần mãi.
 * Xoá theo lô để không khoá DB lâu khi bảng đã rất lớn.
 */
export function pruneUsage(days = 90): number {
  if (days <= 0) return 0;
  const cutoff = Date.now() - days * 86400_000;
  let total = 0;
  for (;;) {
    const r = db
      .prepare(`DELETE FROM gateway_usage WHERE id IN (SELECT id FROM gateway_usage WHERE ts < ? LIMIT 50000)`)
      .run(cutoff);
    const n = Number(r.changes ?? 0);
    total += n;
    if (n < 50000) break;
  }
  return total;
}

// ---------- api keys ----------
export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  enabled: number;
  created_at: number;
  last_used: number | null;
  note: string | null;
}

export function listApiKeys(): ApiKeyRow[] {
  return db.prepare(`SELECT * FROM api_keys ORDER BY created_at DESC`).all() as any[];
}

/** Tra theo prefix — index UNIQUE nên O(1) và tối đa 1 hàng, không quét cả bảng. */
export function getApiKeyByPrefix(prefix: string): ApiKeyRow | undefined {
  return db.prepare(`SELECT * FROM api_keys WHERE prefix = ?`).get(prefix) as any;
}

export function getApiKey(id: string): ApiKeyRow | undefined {
  return db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id) as any;
}

export function insertApiKey(r: Omit<ApiKeyRow, 'last_used'>): void {
  db.prepare(
    `INSERT INTO api_keys (id, name, prefix, hash, enabled, created_at, note) VALUES (?,?,?,?,?,?,?)`,
  ).run(r.id, r.name, r.prefix, r.hash, r.enabled, r.created_at, r.note ?? null);
}

export function updateApiKey(id: string, p: { name?: string; note?: string; enabled?: boolean }): boolean {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (p.name != null) { sets.push('name = ?'); args.push(p.name); }
  if (p.note != null) { sets.push('note = ?'); args.push(p.note); }
  if (p.enabled != null) { sets.push('enabled = ?'); args.push(p.enabled ? 1 : 0); }
  if (!sets.length) return false;
  args.push(id);
  const r = db.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...(args as any[]));
  return Number(r.changes ?? 0) > 0;
}

export function deleteApiKey(id: string): boolean {
  const r = db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id);
  return Number(r.changes ?? 0) > 0;
}

/**
 * Ghi thời điểm dùng gần nhất. Gọi ở đường NÓNG nên throttle 60s —
 * không cần chính xác tới giây, và tránh ghi DB mỗi request.
 */
const lastUsedWrite = new Map<string, number>();
export function touchApiKey(id: string, now = Date.now()): void {
  if (now - (lastUsedWrite.get(id) ?? 0) < 60_000) return;
  lastUsedWrite.set(id, now);
  db.prepare(`UPDATE api_keys SET last_used = ? WHERE id = ?`).run(now, id);
}

// ---------- combos ----------
export interface ComboRow { id: string; name: string; strategy: string; targets_json: string; enabled: number; created_at: number; updated_at: number }
export function listComboRows(): ComboRow[] {
  return db.prepare(`SELECT * FROM combos ORDER BY id`).all() as any[];
}
export function getComboRow(id: string): ComboRow | undefined {
  return db.prepare(`SELECT * FROM combos WHERE id = ?`).get(id) as any;
}
export function upsertComboRow(r: { id: string; name: string; strategy: string; targets: unknown; enabled?: boolean }): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO combos (id,name,strategy,targets_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, strategy=excluded.strategy,
       targets_json=excluded.targets_json, enabled=excluded.enabled, updated_at=excluded.updated_at`,
  ).run(r.id, r.name, r.strategy, JSON.stringify(r.targets ?? []), r.enabled === false ? 0 : 1, now, now);
}
export function deleteComboRow(id: string): void {
  db.prepare(`DELETE FROM combos WHERE id = ?`).run(id);
}
export function recordComboRun(r: { combo: string; step: number; model: string; ok: boolean; status?: number; ms?: number; reason?: string }): void {
  db.prepare(`INSERT INTO combo_runs (ts,combo,step,model,ok,status,ms,reason) VALUES (?,?,?,?,?,?,?,?)`)
    .run(Date.now(), r.combo, r.step, r.model, r.ok ? 1 : 0, r.status ?? null, r.ms ?? null, (r.reason ?? '').slice(0, 200));
}
export function comboStatsRows(sinceMs: number): { combo: string; calls: number; fallbacks: number }[] {
  return db
    .prepare(
      `SELECT combo,
              SUM(CASE WHEN step = 0 THEN 1 ELSE 0 END) AS calls,
              SUM(CASE WHEN step > 0 THEN 1 ELSE 0 END) AS fallbacks
       FROM combo_runs WHERE ts >= ? GROUP BY combo`,
    )
    .all(sinceMs) as any[];
}

/** Số liệu p95 + tỉ lệ thành công theo provider (prefix của model) trong `sinceMs`. */
export function providerStats(sinceMs: number): { provider: string; n: number; okRate: number; p95: number }[] {
  const rows = db
    .prepare(
      `SELECT substr(model, 1, instr(model, '/') - 1) AS provider, ok, ms
       FROM gateway_usage WHERE ts >= ? AND instr(model, '/') > 0`,
    )
    .all(sinceMs) as { provider: string; ok: number; ms: number }[];
  const by = new Map<string, { ok: number; n: number; ms: number[] }>();
  for (const r of rows) {
    const e = by.get(r.provider) ?? { ok: 0, n: 0, ms: [] };
    e.n++;
    if (r.ok) e.ok++;
    if (r.ms > 0) e.ms.push(r.ms);
    by.set(r.provider, e);
  }
  const out: { provider: string; n: number; okRate: number; p95: number }[] = [];
  for (const [provider, e] of by) {
    e.ms.sort((a, b) => a - b);
    const p95 = e.ms.length ? e.ms[Math.min(e.ms.length - 1, Math.floor(e.ms.length * 0.95))]! : 0;
    out.push({ provider, n: e.n, okRate: e.n ? e.ok / e.n : 0, p95 });
  }
  return out;
}

/**
 * Credit Kiro đã tiêu QUA GATEWAY NÀY trong tháng hiện tại, theo account.
 * Kiro KHÔNG có API usage (đã dò: mọi operation đều UnknownOperationException) nên
 * đây là con số ta tự đếm — KHÔNG tính request thực hiện ngoài gateway (Kiro IDE,
 * OmniRoute…), vì vậy chỉ là mức TỐI THIỂU đã dùng.
 * Gói KIRO FREE = 50 credit/tháng (lấy từ listAvailableSubscriptions).
 */
export function creditsUsedThisMonth(prefix = 'kr/'): Record<string, number> {
  const d = new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const rows = db
    .prepare(`SELECT email, COUNT(*) AS n FROM gateway_usage WHERE ok = 1 AND model LIKE ? AND ts >= ? GROUP BY email`)
    .all(prefix + '%', monthStart) as { email: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.email] = r.n;
  return out;
}

/** Usage gộp theo provider (prefix model). */
export function usageByProvider(from: number, to: number): { provider: string; requests: number; tokIn: number; tokOut: number }[] {
  return db
    .prepare(
      `SELECT COALESCE(NULLIF(substr(model, 1, instr(model,'/') - 1), ''), 'agy') AS provider,
              ${AGG} FROM gateway_usage WHERE ts >= ? AND ts < ? GROUP BY provider ORDER BY requests DESC`,
    )
    .all(from, to) as any[];
}

// ---------- settings (key-value, thay settings.json) ----------
export function getSetting(key: string): string | undefined {
  const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
  return r?.value;
}
export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}
export function deleteSetting(key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}
export function allSettings(): Record<string, string> {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as any[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ---------- sessions ----------
export interface SessionRow { id: string; created_at: number; last_seen: number; expires_at: number; ip: string | null; ua: string | null }
export function createSession(id: string, expiresAt: number, ip?: string, ua?: string): void {
  const now = Date.now();
  db.prepare(`INSERT INTO sessions (id, created_at, last_seen, expires_at, ip, ua) VALUES (?,?,?,?,?,?)`)
    .run(id, now, now, expiresAt, ip ?? null, (ua ?? '').slice(0, 200));
}
export function getSession(id: string): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
}
export function touchSession(id: string): void {
  db.prepare(`UPDATE sessions SET last_seen = ? WHERE id = ?`).run(Date.now(), id);
}
export function deleteSession(id: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}
export function deleteAllSessions(exceptId?: string): number {
  const r = exceptId
    ? db.prepare(`DELETE FROM sessions WHERE id <> ?`).run(exceptId)
    : db.prepare(`DELETE FROM sessions`).run();
  return Number(r.changes ?? 0);
}
export function listSessions(): SessionRow[] {
  return db.prepare(`SELECT * FROM sessions WHERE expires_at > ? ORDER BY last_seen DESC`).all(Date.now()) as any[];
}
export function pruneSessions(): void {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
}

// ---------- auth log + chống brute-force ----------
export function addAuthLog(ip: string, ua: string, ok: boolean, reason?: string): void {
  db.prepare(`INSERT INTO auth_log (ts, ip, ua, ok, reason) VALUES (?,?,?,?,?)`)
    .run(Date.now(), ip, (ua ?? '').slice(0, 200), ok ? 1 : 0, reason ?? null);
}
export function recentAuthLog(limit = 20): any[] {
  return db.prepare(`SELECT * FROM auth_log ORDER BY id DESC LIMIT ?`).all(limit) as any[];
}
/** Số lần đăng nhập SAI của 1 IP trong `windowMs` gần đây. */
export function failedLoginCount(ip: string, windowMs: number): number {
  const since = Date.now() - windowMs;
  const r = db.prepare(`SELECT COUNT(*) AS n FROM auth_log WHERE ip = ? AND ok = 0 AND ts >= ?`).get(ip, since) as any;
  return r?.n ?? 0;
}
/** Xoá lịch sử sai của IP (sau khi đăng nhập thành công) để mở khoá. */
export function clearFailedLogins(ip: string): void {
  db.prepare(`DELETE FROM auth_log WHERE ip = ? AND ok = 0`).run(ip);
}

// ---------- lịch sử hạn mức ----------
export interface QuotaHistoryRow { ts: number; email: string; tier: string | null; gemini_pct: number | null; third_pct: number | null }
export function recordQuota(r: { ts: number; email: string; tier?: string | null; geminiPct?: number | null; thirdPct?: number | null; models?: unknown; probeOk?: boolean }): void {
  db.prepare(`INSERT INTO quota_history (ts, email, tier, gemini_pct, third_pct, models_json, probe_ok) VALUES (?,?,?,?,?,?,?)`)
    .run(
      r.ts, r.email, r.tier ?? null, r.geminiPct ?? null, r.thirdPct ?? null,
      r.models ? JSON.stringify(r.models) : null,
      r.probeOk === undefined ? null : r.probeOk ? 1 : 0,
    );
}
/** Xu hướng TB toàn pool theo ngày/giờ. */
export function quotaSeries(from: number, to: number, groupBy: 'hour' | 'day' = 'day'): { bucket: string; gemini: number; third: number; n: number }[] {
  const fmt = groupBy === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d';
  return db
    .prepare(
      `SELECT strftime('${fmt}', ts/1000, 'unixepoch', 'localtime') AS bucket,
              ROUND(AVG(gemini_pct)) AS gemini, ROUND(AVG(third_pct)) AS third, COUNT(*) AS n
       FROM quota_history WHERE ts >= ? AND ts < ? GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(from, to) as any[];
}
/** Lịch sử của 1 account. */
export function quotaForAccount(email: string, from: number, to: number): QuotaHistoryRow[] {
  return db
    .prepare(`SELECT ts, email, tier, gemini_pct, third_pct FROM quota_history WHERE email = ? AND ts >= ? AND ts < ? ORDER BY ts ASC`)
    .all(email, from, to) as any[];
}
export function quotaHistoryCount(): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM quota_history`).get() as any;
  return r?.n ?? 0;
}
/** Dọn lịch sử cũ hơn `days` ngày (mặc định 90). Trả về số dòng đã xoá. */
export function pruneQuotaHistory(days = 90): number {
  const cutoff = Date.now() - days * 86400_000;
  const r = db.prepare(`DELETE FROM quota_history WHERE ts < ?`).run(cutoff);
  const r2 = db.prepare(`DELETE FROM auth_log WHERE ts < ?`).run(cutoff);
  return Number(r.changes ?? 0) + Number(r2.changes ?? 0);
}

export function usageRows(from: number, to: number, f?: UsageFilter): UsageRow[] {
  const w = usageWhere(f);
  return db
    .prepare(
      `SELECT ts, email, model, prompt_tokens AS promptTokens, completion_tokens AS completionTokens, ok, ms,
              api_key_id AS apiKeyId, combo, endpoint, status, request_id AS requestId, stream
       FROM gateway_usage WHERE ts >= ? AND ts < ?${w.sql} ORDER BY ts ASC`,
    )
    .all(from, to, ...(w.args as any[])) as any[];
}
