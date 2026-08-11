import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { STATE_DB } from '../paths.js';

/**
 * State runtime (không phải nguồn backup — cái đó là CSV).
 * Giữ lịch sử run + log để dashboard hiển thị và để đếm cap/ngày.
 */
export const db = new DatabaseSync(STATE_DB);
// Bảng settings chứa secret (sessionSecret, hash mật khẩu, API key) → chỉ chủ file đọc được.
try { chmodSync(STATE_DB, 0o600); } catch { /* fs không hỗ trợ chmod → bỏ qua */ }

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
  {
    v: 4,
    // Trước đây lịch sử metrics chỉ nằm trong RAM: MetricsRecorder giữ cửa sổ trượt 5
    // phút ở server, còn trang Metrics tự tích luỹ 120 điểm trong RAM TRÌNH DUYỆT. Hệ
    // quả: 3 khung chart trên /metrics luôn trống sau mỗi lần F5, và restart server là
    // mất sạch. Bảng này làm lịch sử bền vững.
    //
    // Gộp luôn cột pool (acc_*) vào đây thay vì tạo bảng thứ hai — cùng nhịp ghi, cùng
    // trục thời gian, nên tách ra chỉ tốn thêm một lần join.
    name: 'bảng metrics_history cho chart Metrics bền vững',
    up: (d) => {
      d.exec(`
        CREATE TABLE IF NOT EXISTS metrics_history (
          ts             INTEGER PRIMARY KEY,
          rps            REAL,
          error_rate     REAL,
          p50            INTEGER,
          p95            INTEGER,
          p99            INTEGER,
          requests       INTEGER,
          errors         INTEGER,
          acc_total      INTEGER,
          acc_available  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics_history(ts);
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

/**
 * Cache prepared statement cho ĐƯỜNG NÓNG (mỗi request đều chạy): recordGatewayUsage,
 * auth theo prefix, setSetting… `db.prepare()` biên dịch lại SQL mỗi lần gọi — với SQL
 * cố định thì đó là chi phí bỏ đi. Chỉ dùng cho SQL TĨNH; SQL dựng động (usageWhere)
 * vẫn prepare trực tiếp để cache không phình theo tổ hợp filter.
 */
const stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
function prep(sql: string): ReturnType<DatabaseSync['prepare']> {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
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

/**
 * Lỗi GẦN NHẤT của mỗi account, gom theo (email, flow).
 *
 * Vì sao cần: `store.setStatus()` chỉ ghi `'failed'` vào accounts.csv và VỨT thông điệp
 * lỗi (runner.ts có sẵn `msg` nhưng không truyền xuống). Đo trên production: 133 account
 * `status_agy=failed` mà không chỗ nào nói vì sao — người vận hành thấy "hỏng 133 cái"
 * rồi bó tay. Lý do thật vẫn nằm trong bảng `runs` (`antigravity_no_code` ×133), chỉ là
 * chưa ai nối hai nguồn lại.
 *
 * Dùng id lớn nhất thay vì started_at: hai run cùng giây thì thời gian không phân định
 * được, còn id thì luôn tăng.
 */
export function lastRunErrors(): Map<string, { flow: string; error: string; ts: string }> {
  const rows = db
    .prepare(
      `SELECT r.email, r.flow, r.error, r.started_at AS ts
         FROM runs r
         JOIN (SELECT email, flow, MAX(id) AS mid
                 FROM runs WHERE status = 'failed' GROUP BY email, flow) m
           ON r.id = m.mid
        WHERE r.error IS NOT NULL AND r.error != ''`,
    )
    .all() as Array<{ email: string; flow: string; error: string; ts: string }>;
  const out = new Map<string, { flow: string; error: string; ts: string }>();
  for (const r of rows) out.set(`${r.email}:${r.flow}`, { flow: r.flow, error: r.error, ts: r.ts });
  return out;
}

/** Đếm account theo từng lý do lỗi — để biết nên sửa cái nào trước. */
export function failureReasons(): { reason: string; accounts: number; flows: string }[] {
  return db
    .prepare(
      `SELECT r.error AS reason, COUNT(DISTINCT r.email) AS accounts,
              GROUP_CONCAT(DISTINCT r.flow) AS flows
         FROM runs r
         JOIN (SELECT email, flow, MAX(id) AS mid
                 FROM runs WHERE status = 'failed' GROUP BY email, flow) m
           ON r.id = m.mid
        WHERE r.error IS NOT NULL AND r.error != ''
        GROUP BY r.error ORDER BY accounts DESC LIMIT 20`,
    )
    .all() as { reason: string; accounts: number; flows: string }[];
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
/**
 * Cache 60s cho creditsUsedThisMonth + invalidate khi usage đổi. Khai báo TRƯỚC
 * recordGatewayUsage (nơi gán đầu tiên) để không tạo bẫy TDZ nếu sau này có caller
 * chạy lúc module-init.
 */
let creditsCache: { at: number; prefix: string; data: Record<string, number> } | null = null;

export function recordGatewayUsage(r: UsageRow): void {
  creditsCache = null; // usage mới → số credit Kiro tháng này đổi
  prep(
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

/**
 * Cột gộp dùng chung cho MỌI bảng tổng hợp usage (7 hàm: totals, series, byModel,
 * byAccount, byApiKey, byCombo, byProvider).
 *
 * Bản trước chỉ đếm request + cộng token, nên `ms` và `ok` — có trong từng bản ghi từ
 * lâu — không xuất hiện ở bất kỳ tổng hợp nào. Hậu quả đo được trên production: model
 * chính chạy p50 = 42 giây, p95 = 61 giây mà trang Báo cáo không hiện ở đâu cả. Không
 * ai trả lời được "model nào chậm nhất" hay "API key nào gây nhiều lỗi nhất".
 *
 * `avgMs` và `errors` tính ngay trong SQL vì rẻ. Percentile thì SQLite không có hàm
 * sẵn — xem `PCT_MS` bên dưới.
 */
const AGG = `COUNT(*) AS requests, COALESCE(SUM(prompt_tokens),0) AS tokIn, COALESCE(SUM(completion_tokens),0) AS tokOut,
  COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS errors,
  CAST(COALESCE(AVG(CASE WHEN ok = 1 THEN ms END),0) AS INTEGER) AS avgMs`;

/**
 * Percentile độ trễ cho một nhóm — SQLite không có `percentile()`, và window function
 * trong subquery tương quan thì chậm trên bảng chục nghìn dòng.
 *
 * Cách này chạy MỘT truy vấn riêng cho toàn bộ nhóm rồi ghép vào kết quả ở JS: đọc
 * `ms` đã sắp xếp của các request THÀNH CÔNG (request lỗi thường trả rất nhanh, gộp
 * vào sẽ kéo p95 xuống và che mất vấn đề thật).
 */
function pctByKey(
  keyExpr: string,
  from: number,
  to: number,
  where: { sql: string; args: unknown[] },
): Map<string, { p50: number; p95: number }> {
  const rows = db
    .prepare(
      `SELECT ${keyExpr} AS k, ms FROM gateway_usage
        WHERE ts >= ? AND ts < ? AND ok = 1 AND ms > 0${where.sql}
        ORDER BY k, ms`,
    )
    .all(from, to, ...(where.args as any[])) as Array<{ k: string; ms: number }>;

  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byKey.get(r.k);
    if (arr) arr.push(r.ms);
    else byKey.set(r.k, [r.ms]);
  }
  const out = new Map<string, { p50: number; p95: number }>();
  for (const [k, ms] of byKey) {
    // `ms` đã sắp xếp sẵn nhờ ORDER BY — không sort lại ở JS.
    const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] ?? 0;
    out.set(k, { p50: at(0.5), p95: at(0.95) });
  }
  return out;
}

/** Bộ lọc báo cáo. Trường bỏ trống = không lọc theo tiêu chí đó. */
export interface UsageFilter {
  apiKeyId?: string;
  combo?: string;
  /** Lọc theo account. */
  email?: string;
  /** Lọc theo model (id đã prefix, vd `agy/gemini-3-flash`). */
  model?: string;
  /** Lọc theo đường vào: `/v1/messages`, `/v1/chat/completions`, `chat-test`… */
  endpoint?: string;
  /** Mã HTTP cụ thể — dùng để soi riêng 429 hay 503. */
  status?: number;
  /** `true` chỉ lấy thành công, `false` chỉ lấy lỗi. Bỏ trống = cả hai. */
  ok?: boolean;
  /** `true` chỉ lấy request stream. */
  stream?: boolean;
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
  if (f?.email) {
    sql += ' AND email = ?';
    args.push(f.email);
  }
  if (f?.model) {
    sql += ' AND model = ?';
    args.push(f.model);
  }
  if (f?.endpoint) {
    sql += ' AND endpoint = ?';
    args.push(f.endpoint);
  }
  if (f?.status !== undefined) {
    sql += ' AND status = ?';
    args.push(f.status);
  }
  if (f?.ok !== undefined) {
    sql += ' AND ok = ?';
    args.push(f.ok ? 1 : 0);
  }
  if (f?.stream !== undefined) {
    sql += ' AND stream = ?';
    args.push(f.stream ? 1 : 0);
  }
  return { sql, args };
}

export function usageTotals(from: number, to: number, f?: UsageFilter): UsageAgg & { accounts: number } {
  const w = usageWhere(f);
  const row = db
    .prepare(`SELECT ${AGG}, COUNT(DISTINCT email) AS accounts FROM gateway_usage WHERE ts >= ? AND ts < ?${w.sql}`)
    .get(from, to, ...(w.args as any[])) as any;
  // Trả nguyên hàng: liệt kê tay từng trường thì thêm cột vào AGG mà quên ở đây là
  // số liệu mới bị vứt âm thầm — đúng lỗi vừa mắc với `errors`/`avgMs`.
  return {
    requests: row.requests, tokIn: row.tokIn, tokOut: row.tokOut,
    errors: row.errors, avgMs: row.avgMs, accounts: row.accounts,
  };
}

/** Chuỗi thời gian theo ngày hoặc tuần (mốc YYYY-MM-DD hoặc YYYY-Www). */
export function usageSeries(
  from: number,
  to: number,
  groupBy: 'hour' | 'day' | 'week',
  f?: UsageFilter,
): (UsageAgg & { bucket: string })[] {
  // ts epoch ms → chuỗi giờ/ngày/tuần theo local: strftime với ts/1000 (unixepoch).
  // Mức 'hour' cần cho khoảng ngắn: gộp theo ngày cho 24 giờ thì chart chỉ có 1-2 cột.
  const fmt = groupBy === 'week' ? "%Y-W%W" : groupBy === 'hour' ? "%Y-%m-%d %H:00" : "%Y-%m-%d";
  const w = usageWhere(f);
  return db
    .prepare(
      `SELECT strftime('${fmt}', ts/1000, 'unixepoch', 'localtime') AS bucket, ${AGG}
       FROM gateway_usage WHERE ts >= ? AND ts < ?${w.sql} GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(from, to, ...(w.args as any[])) as any[];
}

/** Một hàng tổng hợp: đếm + token + CHẤT LƯỢNG (lỗi, độ trễ). */
export interface UsageAgg {
  requests: number;
  tokIn: number;
  tokOut: number;
  /** Số request thất bại — để tính tỉ lệ lỗi mà không phải gọi thêm truy vấn. */
  errors: number;
  /** Độ trễ trung bình của request THÀNH CÔNG (request lỗi trả rất nhanh, gộp vào sẽ méo). */
  avgMs: number;
  p50?: number;
  p95?: number;
}

export function usageByModel(from: number, to: number, f?: UsageFilter): (UsageAgg & { model: string })[] {
  const w = usageWhere(f);
  const rows = db
    .prepare(`SELECT model, ${AGG} FROM gateway_usage WHERE ts >= ? AND ts < ?${w.sql} GROUP BY model ORDER BY requests DESC`)
    .all(from, to, ...(w.args as any[])) as any[];
  const pct = pctByKey('model', from, to, w);
  for (const r of rows) Object.assign(r, pct.get(r.model) ?? { p50: 0, p95: 0 });
  return rows;
}

export function usageByAccount(from: number, to: number, f?: UsageFilter): (UsageAgg & { email: string })[] {
  const w = usageWhere(f);
  const rows = db
    .prepare(`SELECT email, ${AGG} FROM gateway_usage WHERE ts >= ? AND ts < ?${w.sql} GROUP BY email ORDER BY requests DESC`)
    .all(from, to, ...(w.args as any[])) as any[];
  const pct = pctByKey('email', from, to, w);
  for (const r of rows) Object.assign(r, pct.get(r.email) ?? { p50: 0, p95: 0 });
  return rows;
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
  creditsCache = null; // retention < 1 tháng có thể xoá cả dòng tháng này
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
  return prep(`SELECT * FROM api_keys WHERE prefix = ?`).get(prefix) as any;
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
  prep(`UPDATE api_keys SET last_used = ? WHERE id = ?`).run(now, id);
}

// ---------- combos ----------
export interface ComboRow { id: string; name: string; strategy: string; targets_json: string; enabled: number; created_at: number; updated_at: number }

/**
 * Revision tăng mỗi lần combo đổi TRONG process này — cho tầng trên (engine.listCombos)
 * cache kết quả parse mà vẫn thấy thay đổi ngay lập tức. Process khác ghi DB (CLI)
 * không bump được số này → tầng cache phải kèm TTL ngắn làm lưới an toàn.
 */
let comboRev = 0;
export function comboRevision(): number {
  return comboRev;
}

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
  comboRev++;
}
export function deleteComboRow(id: string): void {
  db.prepare(`DELETE FROM combos WHERE id = ?`).run(id);
  comboRev++;
}
export function recordComboRun(r: { combo: string; step: number; model: string; ok: boolean; status?: number; ms?: number; reason?: string }): void {
  prep(`INSERT INTO combo_runs (ts,combo,step,model,ok,status,ms,reason) VALUES (?,?,?,?,?,?,?,?)`)
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
/**
 * Trang Pool poll /api/gateway/accounts mỗi 10s và mỗi lần đều GROUP BY cả tháng
 * usage — trong khi kết quả chỉ đổi khi có request Kiro mới → cache (xem creditsCache).
 */
export function creditsUsedThisMonth(prefix = 'kr/'): Record<string, number> {
  if (creditsCache && creditsCache.prefix === prefix && Date.now() - creditsCache.at < 60_000) {
    return creditsCache.data;
  }
  const d = new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const rows = prep(`SELECT email, COUNT(*) AS n FROM gateway_usage WHERE ok = 1 AND model LIKE ? AND ts >= ? GROUP BY email`)
    .all(prefix + '%', monthStart) as { email: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.email] = r.n;
  creditsCache = { at: Date.now(), prefix, data: out };
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
  prep(
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
  prep(`INSERT INTO quota_history (ts, email, tier, gemini_pct, third_pct, models_json, probe_ok) VALUES (?,?,?,?,?,?,?)`)
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

// ── Lịch sử metrics ────────────────────────────────────────────────────────
// Nguồn cho 3 chart trang /metrics. Trước đây chúng đọc RAM trình duyệt nên F5 là trắng.

export interface MetricsPoint {
  ts: number;
  rps?: number | null;
  errorRate?: number | null;
  p50?: number | null;
  p95?: number | null;
  p99?: number | null;
  requests?: number | null;
  errors?: number | null;
  accTotal?: number | null;
  accAvailable?: number | null;
}

/** Ghi 1 điểm. `ts` là PRIMARY KEY nên ghi trùng mốc sẽ đè, không sinh dòng thừa. */
export function recordMetrics(p: MetricsPoint): void {
  prep(
    `INSERT INTO metrics_history (ts, rps, error_rate, p50, p95, p99, requests, errors, acc_total, acc_available)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(ts) DO UPDATE SET
       rps=excluded.rps, error_rate=excluded.error_rate, p50=excluded.p50, p95=excluded.p95,
       p99=excluded.p99, requests=excluded.requests, errors=excluded.errors,
       acc_total=excluded.acc_total, acc_available=excluded.acc_available`,
  ).run(
    p.ts, p.rps ?? null, p.errorRate ?? null, p.p50 ?? null, p.p95 ?? null, p.p99 ?? null,
    p.requests ?? null, p.errors ?? null, p.accTotal ?? null, p.accAvailable ?? null,
  );
}

/**
 * Chuỗi metrics theo thời gian.
 *
 * `raw` trả thẳng từng điểm (dùng cho cửa sổ ngắn — vài giờ, độ phân giải 1 phút);
 * `minute`/`hour` gộp lại cho cửa sổ dài, tránh đẩy hàng chục nghìn điểm xuống trình duyệt.
 * Latency lấy MAX chứ không AVG: trung bình của phân vị là số vô nghĩa, còn đỉnh p99
 * trong khoảng mới là thứ cần nhìn.
 */
export function metricsSeries(
  from: number,
  to: number,
  groupBy: 'raw' | 'minute' | 'hour' = 'raw',
): Array<{ bucket: string; ts: number; rps: number; errorRate: number; p50: number; p95: number; p99: number; accTotal: number; accAvailable: number }> {
  if (groupBy === 'raw') {
    return db
      .prepare(
        `SELECT ts, ts AS bucket, rps, error_rate AS errorRate, p50, p95, p99,
                acc_total AS accTotal, acc_available AS accAvailable
         FROM metrics_history WHERE ts >= ? AND ts < ? ORDER BY ts ASC`,
      )
      .all(from, to) as any[];
  }
  const fmt = groupBy === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d %H:%M';
  return db
    .prepare(
      `SELECT strftime('${fmt}', ts/1000, 'unixepoch', 'localtime') AS bucket,
              MIN(ts) AS ts,
              ROUND(AVG(rps), 3) AS rps, ROUND(AVG(error_rate), 4) AS errorRate,
              MAX(p50) AS p50, MAX(p95) AS p95, MAX(p99) AS p99,
              MAX(acc_total) AS accTotal, ROUND(AVG(acc_available)) AS accAvailable
       FROM metrics_history WHERE ts >= ? AND ts < ? GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(from, to) as any[];
}

export function metricsHistoryCount(): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM metrics_history`).get() as any)?.n ?? 0);
}

export function pruneMetricsHistory(days = 90): number {
  const r = db.prepare(`DELETE FROM metrics_history WHERE ts < ?`).run(Date.now() - days * 86400_000);
  return Number(r.changes ?? 0);
}

/**
 * Mẫu (ts, ms, ok, model) MỚI NHẤT cho histogram/tỉ lệ lỗi — LIMIT ngay trong SQL.
 * Trước đây /api/gateway/stats gọi usageRows() kéo TOÀN BỘ bản ghi tới 90 ngày vào JS
 * rồi mới slice(-3000): bảng lớn thì mỗi lần mở trang Báo cáo là một lần quét thừa.
 */
export function usageSamples(from: number, limit: number): { ts: number; ms: number; ok: number; model: string }[] {
  const rows = db
    .prepare(`SELECT ts, ms, ok, model FROM gateway_usage WHERE ts >= ? ORDER BY ts DESC LIMIT ?`)
    .all(from, limit) as any[];
  return rows.reverse(); // trả theo thời gian tăng dần như slice(-N) cũ
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

/**
 * Từng request một, PHÂN TRANG phía server và mới nhất trước.
 *
 * Khác `usageRows` (dùng cho xuất CSV, trả toàn bộ theo thứ tự tăng dần): bảng chi tiết
 * trên dashboard không được kéo cả chục nghìn dòng về trình duyệt.
 */
export function usageLogs(
  from: number,
  to: number,
  f?: UsageFilter,
  limit = 100,
  offset = 0,
): { rows: UsageRow[]; total: number } {
  const w = usageWhere(f);
  const where = `WHERE ts >= ? AND ts < ?${w.sql}`;
  const total = (
    db.prepare(`SELECT COUNT(*) n FROM gateway_usage ${where}`).get(from, to, ...(w.args as any[])) as any
  ).n as number;
  const rows = db
    .prepare(
      `SELECT ts, email, model, prompt_tokens AS promptTokens, completion_tokens AS completionTokens, ok, ms,
              api_key_id AS apiKeyId, combo, endpoint, status, request_id AS requestId, stream
       FROM gateway_usage ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`,
    )
    .all(from, to, ...(w.args as any[]), Math.max(1, Math.min(500, limit)), Math.max(0, offset)) as any[];
  return { rows, total };
}

/**
 * Các giá trị CÓ THẬT trong khoảng thời gian, kèm số lần xuất hiện.
 *
 * Dùng dựng dropdown lọc: chỉ liệt kê thứ thực sự có dữ liệu, thay vì bắt người dùng
 * đoán mã lỗi hay tên endpoint rồi lọc ra bảng rỗng.
 */
export function usageFacets(
  from: number,
  to: number,
  f?: UsageFilter,
): {
  endpoints: { value: string; n: number }[];
  statuses: { value: number; n: number }[];
  models: { value: string; n: number }[];
} {
  const w = usageWhere(f);
  const where = `WHERE ts >= ? AND ts < ?${w.sql}`;
  const args = [from, to, ...(w.args as any[])];
  const nhom = (col: string, extra = '') =>
    db
      .prepare(
        `SELECT ${col} AS value, COUNT(*) n FROM gateway_usage ${where}${extra}
         GROUP BY ${col} ORDER BY n DESC LIMIT 40`,
      )
      .all(...args) as any[];
  return {
    endpoints: nhom('endpoint', " AND endpoint IS NOT NULL AND endpoint != ''"),
    statuses: nhom('status', ' AND status IS NOT NULL'),
    models: nhom('model'),
  };
}

// ---------------------------------------------------------------------------
// Backup/restore theo BẢNG — dùng để chuyển toàn bộ hệ thống giữa các server.
//
// Trước đây backup chỉ gom accounts/credentials/settings/combos, thiếu 8/10 bảng.
// Nghiêm trọng nhất là `api_keys`: chuyển server là mất sạch key của người dùng, và
// vì key lưu dạng hash nên KHÔNG dựng lại được — phải phát key mới cho từng người.
// ---------------------------------------------------------------------------

/** Bảng đi theo backup, kèm ghi chú vì sao. */
export const BACKUP_TABLES = {
  /** Định danh người dùng. Hash không tái tạo được → mất là phải phát lại key. */
  api_keys: 'core',
  /** Lịch sử dùng: nguồn của trang Báo cáo. Mất là mất hết số liệu tích luỹ. */
  gateway_usage: 'history',
  /** Lịch sử quota theo thời gian — vẽ biểu đồ xu hướng. */
  quota_history: 'history',
  /** Lịch sử rps/latency/error + sức khoẻ pool — nguồn 3 chart trang Metrics. */
  metrics_history: 'history',
  /** Lần chạy flow (login/warmup) + log của chúng. */
  runs: 'history',
  run_logs: 'history',
  combo_runs: 'history',
} as const;

export type BackupTable = keyof typeof BACKUP_TABLES;

/**
 * KHÔNG backup: `sessions` (cookie đăng nhập của riêng máy đó, mang sang máy khác là
 * lỗ hổng) và `auth_log` (nhật ký đăng nhập theo IP của máy cũ, vô nghĩa ở máy mới —
 * tệ hơn là mang theo lịch sử đăng nhập sai sẽ khoá nhầm người dùng ở máy mới).
 */
export const BACKUP_SKIP_TABLES = ['sessions', 'auth_log', 'settings', 'combos'] as const;

export function dumpTable(table: BackupTable, limit?: number): Record<string, unknown>[] {
  if (!(table in BACKUP_TABLES)) throw new Error(`bảng không nằm trong danh sách backup: ${table}`);
  const sql = limit
    ? `SELECT * FROM ${table} ORDER BY rowid DESC LIMIT ${Number(limit)}`
    : `SELECT * FROM ${table}`;
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } catch {
    return []; // bảng chưa tồn tại (DB cũ) → bỏ qua thay vì làm hỏng cả backup
  }
}

/**
 * Nạp lại một bảng. `replace` xoá sạch trước; mặc định là chèn thêm và BỎ QUA dòng
 * trùng khoá chính (INSERT OR IGNORE) để gộp dữ liệu hai máy không bị vỡ.
 */
export function loadTable(table: BackupTable, rows: Record<string, unknown>[], replace = false): number {
  if (!(table in BACKUP_TABLES)) throw new Error(`bảng không nằm trong danh sách backup: ${table}`);
  if (!rows?.length) return 0;
  const d = db;
  // Cột trong file backup có thể lệch schema hiện tại (bản cũ/mới) → chỉ lấy cột CÓ THẬT.
  let cols: string[];
  try {
    cols = (d.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => String(c.name));
  } catch {
    return 0;
  }
  if (!cols.length) return 0;
  const use = cols.filter((c) => c in rows[0]!);
  if (!use.length) return 0;

  if (replace) d.prepare(`DELETE FROM ${table}`).run();
  const stmt = d.prepare(
    `INSERT OR IGNORE INTO ${table} (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`,
  );
  let n = 0;
  d.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(...use.map((c) => (r[c] === undefined ? null : (r[c] as any))));
      n++;
    }
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  return n;
}
