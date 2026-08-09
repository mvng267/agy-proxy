import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

/**
 * Lớp kết nối tới agyproxy — dùng chung cho CLI và MCP server.
 *
 * Tách ra khỏi `bin/agyproxy.mjs` vì file đó chạy ngay khi import (dispatcher `switch(cmd)`
 * nằm ở cấp module), nên MCP server import vào là kích hoạt CLI. Quan trọng hơn: nếu chép
 * logic auth sang chỗ thứ hai thì hai bản sẽ trôi lệch — CLI sửa mà MCP không, hoặc ngược
 * lại. Ở đây KHÔNG đọc `process.argv`, mọi thứ nhận qua tham số để cả hai phía dùng được.
 *
 * Thứ tự ưu tiên (cao → thấp):
 *   tham số truyền vào  →  env AGY_URL/AGY_TOKEN  →  ~/.agyproxy/cli.json  →  DB cục bộ
 */

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');

/** Thư mục dữ liệu. Ưu tiên AGY_HOME, rồi ./data nếu chạy trong repo, cuối cùng ~/.agyproxy. */
export function agyHome() {
  if (process.env.AGY_HOME) return resolve(process.env.AGY_HOME);
  if (existsSync(resolve(ROOT, 'data'))) return ROOT;
  return resolve(homedir(), '.agyproxy');
}

const configFile = () => resolve(agyHome(), 'cli.json');

export function readCliConfig() {
  try { return JSON.parse(readFileSync(configFile(), 'utf8')); } catch { return {}; }
}

export function writeCliConfig(cfg) {
  mkdirSync(dirname(configFile()), { recursive: true });
  // 0600: file chứa token toàn quyền điều khiển gateway — không để user khác cùng máy đọc.
  writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/** Base URL của server, không có dấu `/` cuối. */
export function baseUrl({ url, host, port } = {}) {
  const explicit = url || process.env.AGY_URL || readCliConfig().url;
  if (explicit) return String(explicit).replace(/\/+$/, '');
  const h = host || process.env.AGY_REMOTE_HOST;
  const p = port || process.env.PORT || '7788';
  if (h) return `http://${h}:${p}`;
  return `http://127.0.0.1:${p}`;
}

/** Đang trỏ tới server trên máy khác? Lệnh vòng đời (start/stop/logs) không áp dụng. */
export const isRemote = (opts) =>
  !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(baseUrl(opts));

/**
 * Thông tin đăng nhập. Mật khẩu dashboard lưu dạng hash nên không dùng lại được;
 * ở đây dùng token CLI riêng (sinh + lưu trong bảng `settings`).
 *
 * Trả `{ user, pass }`, hoặc `{ error }` khi ở xa mà chưa có token — để phía gọi tự
 * quyết định báo lỗi thế nào (CLI in ra rồi thoát, MCP trả về cho agent).
 */
export function dashCreds(opts = {}) {
  const tok = opts.token || process.env.AGY_TOKEN;
  if (tok) return { user: opts.user || process.env.AGY_USER || '', pass: tok };

  const cfg = readCliConfig();
  if (cfg.token) return { user: cfg.user || '', pass: cfg.token };

  // Máy khác thì không có DB để đọc — báo rõ thay vì rơi về '123456' rồi nhận 401 khó hiểu.
  if (isRemote(opts)) {
    return {
      error:
        `Chưa có token cho ${baseUrl(opts)}.\n` +
        `  Chạy trên MÁY CHỦ:  agyproxy token\n` +
        `  Rồi trên máy này:   agyproxy connect ${baseUrl(opts)} --token <token>`,
    };
  }

  let pass = '', user = '';
  try {
    const db = new DatabaseSync(resolve(agyHome(), 'data/state.db'));
    const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
    user = get('dashboardUser') || '';
    let t = get('cliToken');
    if (!t) {
      t = randomBytes(24).toString('base64url');
      db.prepare(
        'INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run('cliToken', t, Date.now());
    }
    pass = t;
    db.close();
  } catch { /* không mở được DB — rơi xuống .env bên dưới */ }

  if (!pass) {
    try {
      const env = readFileSync(resolve(ROOT, '.env'), 'utf8');
      pass = (env.match(/^DASHBOARD_PASSWORD=(.*)$/m)?.[1] ?? '').trim();
      user = user || (env.match(/^DASHBOARD_USER=(.*)$/m)?.[1] ?? '').trim();
    } catch { /* không có .env */ }
  }
  return { user, pass: pass || '123456' };
}

/**
 * Gọi API agyproxy. Trả `{ ok, status, data }` — KHÔNG ném lỗi và KHÔNG in ra stdout.
 *
 * Điều thứ hai là bắt buộc với MCP: stdio transport dùng chính stdout làm kênh JSON-RPC,
 * một dòng `console.log` lạc vào đó là hỏng cả phiên. Phía CLI tự lo việc in.
 */
export async function callApi(method, path, body, opts = {}) {
  const creds = dashCreds(opts);
  if (creds.error) return { ok: false, status: 0, data: { error: creds.error } };

  const url = `${baseUrl(opts)}${path.startsWith('/') ? path : '/' + path}`;
  const headers = {
    'user-agent': opts.userAgent || 'agyproxy-client',
    accept: 'application/json',
    authorization: 'Basic ' + Buffer.from(`${creds.user}:${creds.pass}`).toString('base64'),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let r;
  try {
    r = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (e) {
    return { ok: false, status: 0, data: { error: `Không gọi được ${url}: ${e.message}` } };
  }

  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}
