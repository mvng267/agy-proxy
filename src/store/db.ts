import { DatabaseSync } from 'node:sqlite';
import { STATE_DB } from '../config.js';

/**
 * State runtime (không phải nguồn backup — cái đó là CSV).
 * Giữ lịch sử run + log để dashboard hiển thị và để đếm cap/ngày.
 */
export const db = new DatabaseSync(STATE_DB);

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
  CREATE INDEX IF NOT EXISTS idx_runs_email ON runs(email);
  CREATE INDEX IF NOT EXISTS idx_logs_run ON run_logs(run_id);
  CREATE INDEX IF NOT EXISTS idx_usage_ts ON gateway_usage(ts);
`);

// Migration: thêm cột proxy cho DB cũ (bỏ qua nếu đã có).
try {
  db.exec(`ALTER TABLE runs ADD COLUMN proxy TEXT`);
} catch {
  /* cột đã tồn tại */
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

export function usageRows(from: number, to: number): UsageRow[] {
  return db
    .prepare(`SELECT ts, email, model, prompt_tokens AS promptTokens, completion_tokens AS completionTokens, ok, ms FROM gateway_usage WHERE ts >= ? AND ts < ? ORDER BY ts ASC`)
    .all(from, to) as any[];
}
