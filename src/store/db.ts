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

// Migration: thêm cột proxy cho DB cũ (bỏ qua nếu đã có).
try {
  db.exec(`ALTER TABLE runs ADD COLUMN proxy TEXT`);
} catch {
  /* cột đã tồn tại */
}
try {
  db.exec(`ALTER TABLE quota_history ADD COLUMN probe_ok INTEGER`);
} catch {
  /* cột đã tồn tại */
}

/**
 * Migration MỘT LẦN lúc load module: model id cũ chưa có prefix → 'agy/…'.
 * Bắt buộc vì agy có claude-sonnet-4-6 còn Kiro có claude-sonnet-4 — không prefix thì
 * báo cáo trộn 2 provider. KHÔNG dùng trigger/normalize lúc đọc (test ghi id trần sau khi load).
 */
try {
  const done = db.prepare(`SELECT value FROM settings WHERE key = 'migratedUsageModelPrefix'`).get() as any;
  if (!done) {
    db.exec(`UPDATE gateway_usage SET model = 'agy/' || model WHERE model NOT LIKE '%/%'`);
    db.prepare(
      `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run('migratedUsageModelPrefix', '1', Date.now());
  }
} catch {
  /* bảng chưa sẵn sàng → lần chạy sau thử lại */
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
}
export function recordGatewayUsage(r: UsageRow): void {
  db.prepare(
    `INSERT INTO gateway_usage (ts, email, model, prompt_tokens, completion_tokens, ok, ms) VALUES (?,?,?,?,?,?,?)`,
  ).run(r.ts, r.email, r.model, r.promptTokens | 0, r.completionTokens | 0, r.ok ? 1 : 0, r.ms | 0);
}

const AGG = `COUNT(*) AS requests, COALESCE(SUM(prompt_tokens),0) AS tokIn, COALESCE(SUM(completion_tokens),0) AS tokOut`;

export function usageTotals(from: number, to: number): { requests: number; tokIn: number; tokOut: number; accounts: number } {
  const row = db
    .prepare(`SELECT ${AGG}, COUNT(DISTINCT email) AS accounts FROM gateway_usage WHERE ts >= ? AND ts < ?`)
    .get(from, to) as any;
  return { requests: row.requests, tokIn: row.tokIn, tokOut: row.tokOut, accounts: row.accounts };
}

/** Chuỗi thời gian theo ngày hoặc tuần (mốc YYYY-MM-DD hoặc YYYY-Www). */
export function usageSeries(from: number, to: number, groupBy: 'day' | 'week'): { bucket: string; requests: number; tokIn: number; tokOut: number }[] {
  // ts epoch ms → chuỗi ngày/tuần theo local: dùng strftime với ts/1000 (unixepoch).
  const fmt = groupBy === 'week' ? "%Y-W%W" : "%Y-%m-%d";
  return db
    .prepare(
      `SELECT strftime('${fmt}', ts/1000, 'unixepoch', 'localtime') AS bucket, ${AGG}
       FROM gateway_usage WHERE ts >= ? AND ts < ? GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(from, to) as any[];
}

export function usageByModel(from: number, to: number): { model: string; requests: number; tokIn: number; tokOut: number }[] {
  return db
    .prepare(`SELECT model, ${AGG} FROM gateway_usage WHERE ts >= ? AND ts < ? GROUP BY model ORDER BY requests DESC`)
    .all(from, to) as any[];
}

export function usageByAccount(from: number, to: number): { email: string; requests: number; tokIn: number; tokOut: number }[] {
  return db
    .prepare(`SELECT email, ${AGG} FROM gateway_usage WHERE ts >= ? AND ts < ? GROUP BY email ORDER BY requests DESC`)
    .all(from, to) as any[];
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

export function usageRows(from: number, to: number): UsageRow[] {
  return db
    .prepare(`SELECT ts, email, model, prompt_tokens AS promptTokens, completion_tokens AS completionTokens, ok, ms FROM gateway_usage WHERE ts >= ? AND ts < ? ORDER BY ts ASC`)
    .all(from, to) as any[];
}
