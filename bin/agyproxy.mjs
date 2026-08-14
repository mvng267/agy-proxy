#!/usr/bin/env node
/**
 * agyproxy — CLI quản lý Antigravity gateway (giống 9router).
 *   agyproxy start [-d]   chạy (thêm -d = chạy nền)
 *   agyproxy stop         dừng tiến trình nền
 *   agyproxy restart      khởi động lại
 *   agyproxy status       trạng thái + cổng + số account
 *   agyproxy logs [-f]    xem log (-f = theo dõi)
 *   agyproxy update       kiểm tra & cập nhật từ GitHub
 *   agyproxy version      phiên bản hiện tại
 */
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, statSync, readdirSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const REPO = 'mvng267/agy-proxy';

const HOME = process.env.AGY_HOME
  ? resolve(process.env.AGY_HOME)
  : existsSync(resolve(ROOT, 'data'))
    ? ROOT
    : resolve(homedir(), '.agyproxy');
mkdirSync(HOME, { recursive: true });
const PID_FILE = resolve(HOME, 'agyproxy.pid');
const LOG_FILE = resolve(HOME, 'agyproxy.log');
const ENTRY = resolve(ROOT, 'src/index.ts');
const PORT = process.env.PORT || '7788';
// --host 0.0.0.0 (hoặc env HOST) để máy khác truy cập qua IP
const argv = process.argv.slice(2);
const flagVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
// Chỉ set khi có --host / env HOST — KHÔNG mặc định, để .env tự quyết định.
const HOST_EXPLICIT = flagVal('--host') || process.env.HOST || null;
const HOST = HOST_EXPLICIT || '127.0.0.1'; // chỉ dùng để hiển thị
const OPEN = HOST === '0.0.0.0' || HOST === '::';
const hostEnv = HOST_EXPLICIT ? { HOST: HOST_EXPLICIT } : {};

// NO_COLOR (https://no-color.org): tắt ANSI khi pipe/test cần output sạch.
const c = process.env.NO_COLOR
  ? { g: (s) => `${s}`, r: (s) => `${s}`, y: (s) => `${s}`, d: (s) => `${s}`, b: (s) => `${s}` }
  : { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[90m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

/**
 * PID của tiến trình đang PHỤC VỤ, không phải PID mình đã ghi ra.
 *
 * Chỉ tin PID_FILE là sai: tiến trình thật có thể mang PID khác (loader/wrapper ở
 * giữa), khiến `status` báo "đã dừng" và `stop` không dừng được gì trong khi gateway
 * vẫn nhận request — đúng lỗi đã gặp. Cổng đang LISTEN mới là nguồn sự thật, nên khi
 * PID_FILE trượt thì dò theo cổng rồi ghi lại file cho lần sau.
 */
function readPid() {
  const fromFile = (() => {
    if (!existsSync(PID_FILE)) return null;
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (!pid) return null;
    try { process.kill(pid, 0); return pid; } catch { return null; }
  })();
  if (fromFile) return fromFile;

  const onPort = pidOnPort();
  if (onPort) {
    try { writeFileSync(PID_FILE, String(onPort)); } catch { /* chỉ là cache, thiếu không sao */ }
    return onPort;
  }
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
  return null;
}

/** Đợi server chiếm cổng rồi trả PID thật (ghi luôn vào PID_FILE). */
function waitPortPid(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const pid = pidOnPort();
    if (pid) { try { writeFileSync(PID_FILE, String(pid)); } catch {} return pid; }
    try { execFileSync('sleep', ['0.3'], { stdio: 'ignore' }); } catch { break; }
  }
  return null;
}

/** PID đang LISTEN trên PORT. null nếu không ai nghe (hoặc thiếu lsof). */
function pidOnPort() {
  try {
    const out = execFileSync('lsof', ['-ti', `:${PORT}`, '-sTCP:LISTEN'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const pid = Number(out.split('\n')[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function lanIp() {
  const ifs = networkInterfaces();
  for (const list of Object.values(ifs)) for (const n of list || []) {
    if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return null;
}

/**
 * Lệnh chạy server: `node --import tsx src/index.ts`.
 *
 * KHÔNG dùng `node_modules/.bin/tsx` — đó là shell wrapper, nó `exec` node rồi tự
 * thoát, để lại tiến trình phục vụ mồ côi (ppid=1) với PID KHÁC. `start -d` ghi PID
 * của wrapper (đã chết) vào agyproxy.pid → `readPid()` xoá file, `status` báo "đã
 * dừng" và `stop` không dừng được gì trong khi gateway vẫn đang chạy.
 * Gọi thẳng node thì PID ghi ra chính là tiến trình đang nghe cổng.
 */
function serverCmd() {
  const localTsx = resolve(ROOT, 'node_modules/tsx');
  // tsx cài local → nạp làm loader; không có thì để node tự phân giải trên PATH.
  return [process.execPath, ['--import', existsSync(localTsx) ? 'tsx' : 'tsx', ENTRY]];
}

/**
 * ─── Kết nối tới server ───────────────────────────────────────────────────────
 *
 * CLI phải chạy được ở HAI vị trí, và trước đây chỉ chạy được vị trí thứ nhất:
 *
 *   1. Cùng máy với server  → đọc token thẳng từ SQLite, gọi 127.0.0.1
 *   2. Máy khác / tool ngoài → không mở được file DB, và 127.0.0.1 là máy của
 *      chính nó chứ không phải server
 *
 * Vị trí 2 là thứ "tools control" cần. Server KHÔNG cần sửa gì: `src/auth.ts:94`
 * đã nhận cliToken qua Basic auth từ bất kỳ host nào.
 *
 * Thứ tự ưu tiên (cao → thấp), để cờ dòng lệnh luôn thắng cấu hình đã lưu:
 *   --url/--token  →  env AGY_URL/AGY_TOKEN  →  ~/.agyproxy/cli.json  →  local
 */
const CONFIG_FILE = resolve(HOME, 'cli.json');

/** In lỗi ra stderr rồi thoát mã 1 — stdout để dành cho dữ liệu (--json phải parse được). */
function die(msg) {
  console.error(c.r('✗ ') + msg);
  process.exit(1);
}

function readCliConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function writeCliConfig(cfg) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  // 0600: file chứa token toàn quyền điều khiển gateway — không để user khác trên
  // cùng máy đọc được.
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/** Base URL của server (không có dấu / cuối). */
function baseUrl() {
  const explicit = flagVal('--url') || process.env.AGY_URL || readCliConfig().url;
  if (explicit) return String(explicit).replace(/\/+$/, '');
  const h = flagVal('--host') || process.env.AGY_REMOTE_HOST;
  if (h) return `http://${h}:${flagVal('--port') || PORT}`;
  return `http://127.0.0.1:${PORT}`;
}
/** Đang trỏ tới server trên máy khác? Lệnh vòng đời (start/stop/logs) không áp dụng. */
const isRemote = () => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(baseUrl());

/**
 * Thông tin đăng nhập cho CLI. Mật khẩu trong DB đã được BĂM nên không dùng lại được;
 * CLI dùng token CLI riêng (sinh + lưu trong bảng settings) để gọi API.
 * Thứ tự: --token/env → cli.json → token CLI trong DB → .env DASHBOARD_PASSWORD → 123456.
 */
function dashCreds() {
  const tok = flagVal('--token') || process.env.AGY_TOKEN;
  if (tok) return { user: flagVal('--user') || process.env.AGY_USER || '', pass: tok };
  const cfg = readCliConfig();
  if (cfg.token) return { user: cfg.user || '', pass: cfg.token };
  // Máy khác thì không có DB để đọc — báo rõ thay vì rơi về '123456' rồi nhận 401 khó hiểu.
  if (isRemote()) {
    die(`Chưa có token cho ${baseUrl()}.\n` +
        `  Chạy trên MÁY CHỦ:  agyproxy token\n` +
        `  Rồi trên máy này:   agyproxy connect ${baseUrl()} --token <token>`);
  }
  let pass = '', user = '';
  try {
    const db = new DatabaseSync(resolve(HOME, 'data/state.db'));
    const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
    user = get('dashboardUser') || '';
    let tok = get('cliToken');
    if (!tok) {
      tok = randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('cliToken', tok, Date.now());
    }
    pass = tok;
    db.close();
  } catch {}
  if (!pass) {
    try {
      const env = readFileSync(resolve(ROOT, '.env'), 'utf8');
      pass = (env.match(/^DASHBOARD_PASSWORD=(.*)$/m)?.[1] ?? '').trim();
      user = user || (env.match(/^DASHBOARD_USER=(.*)$/m)?.[1] ?? '').trim();
    } catch {}
  }
  return { user, pass: pass || '123456' };
}

/** Gửi JSON kèm Basic auth CLI. Trước đây postJson/patchJson là 2 bản copy y hệt. */
async function sendJson(method, url, body) {
  const { user, pass } = dashCreds();
  const r = await fetch(url, {
    method,
    headers: {
      'user-agent': 'agyproxy-cli', accept: 'application/json', 'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const postJson = (url, body) => sendJson('POST', url, body);
// Các endpoint đổi cấu hình đều là PATCH.
const patchJson = (url, body) => sendJson('PATCH', url, body);

/**
 * Cấu hình 1 tool CLI. Gọi HTTP tới server (writer đã audit nằm ở src/tools/writer.ts)
 * → chỉ MỘT bản implement, không nhân đôi logic ghi file trong CLI.
 */
async function setupTool(id, opts = {}) {
  if (!readPid()) {
    console.log(c.r('✗ Server chưa chạy.') + c.d(' Chạy trước: agyproxy start -d'));
    return;
  }
  const base = `http://localhost:${PORT}`;
  const body = {};
  if (opts.model) body.model = opts.model;
  if (opts.small) body.smallModel = opts.small;
  if (opts.url) body.anthropicBaseUrl = opts.url;
  try {
    if (opts.undo) {
      const r = await postJson(`${base}/api/tools/${id}/undo`, {});
      console.log(r.ok ? c.g('✓ ') + r.detail : c.y('· ' + r.detail));
      console.log(c.d('  ' + r.path));
      return;
    }
    const p = await postJson(`${base}/api/tools/${id}/preview`, body);
    console.log(c.b(`${p.label}`) + c.d(`  ${p.path}`));
    if (!p.installed) console.log(c.y('  ⚠ Chưa thấy tool này cài trên máy — vẫn ghi được để dùng sau.'));
    if (opts.dryRun) {
      console.log(c.d('--- nội dung sẽ ghi (dry-run) ---'));
      console.log(p.after.trim());
      return;
    }
    const r = await postJson(`${base}/api/tools/${id}/apply`, body);
    console.log(c.g('✓ Đã cấu hình') + ` · model ${r.model}`);
    if (r.backup) console.log(c.d(`  backup: ${r.backup.split('/').pop()}`));
    if (p.notes) console.log(c.d('  ' + p.notes));
    console.log(c.d(`  gỡ: agyproxy setup-${id.replace('claude-profile', 'claude --profile')} --undo`));
  } catch (e) {
    console.log(c.r('✗ ') + (e?.message ?? e));
  }
}

async function httpJson(url, opts = {}) {
  const { user, pass } = dashCreds();
  const basic = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const r = await fetch(url, { headers: { 'user-agent': 'agyproxy-cli', accept: 'application/json', authorization: basic, ...(opts.headers || {}) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- auto-setup .env ----------
function autoSetupEnv() {
  const envPath = resolve(ROOT, '.env');
  const examplePath = resolve(ROOT, '.env.example');
  if (existsSync(envPath)) return;
  if (!existsSync(examplePath)) return;
  let content = readFileSync(examplePath, 'utf8');
  const apiKey = 'agy-' + randomBytes(16).toString('hex');
  const dashPass = randomBytes(12).toString('base64url');
  content = content.replace(/^GATEWAY_API_KEY=.*$/m, `GATEWAY_API_KEY=${apiKey}`);
  content = content.replace(/^DASHBOARD_PASSWORD=.*$/m, `DASHBOARD_PASSWORD=${dashPass}`);
  writeFileSync(envPath, content);
  console.log(c.g('✓ Tự tạo .env từ .env.example'));
  console.log(`  Dashboard password : ${c.b(dashPass)}`);
  console.log(`  Gateway API key    : ${c.b(apiKey)}`);
  console.log(c.y('⚠ Lưu lại mật khẩu dashboard và API key ở trên!'));
  console.log();
}

// ---------- commands ----------
function start(detached) {
  autoSetupEnv();
  const running = readPid();
  if (running) { console.log(c.y(`Đang chạy sẵn (PID ${running}) · http://localhost:${PORT}`)); return; }
  if (!detached) {
    console.log(c.d(`agyproxy v${PKG.version} · data: ${HOME}`));
    const [bin, argv] = serverCmd();
    const p = spawn(bin, argv, { stdio: 'inherit', env: { ...process.env, ...hostEnv }, cwd: ROOT });
    p.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  const out = openSync(LOG_FILE, 'a');
  const [bin, argv] = serverCmd();
  const p = spawn(bin, argv, { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...hostEnv }, cwd: ROOT });
  p.unref();
  // Ghi tạm PID spawn; sau khi server lên thì ghi đè bằng PID ĐANG NGHE CỔNG — hai
  // giá trị này có thể khác nhau và chỉ cái sau mới `stop` được.
  writeFileSync(PID_FILE, String(p.pid));
  const shown = waitPortPid(8000) ?? p.pid;
  console.log(c.g('✓ Đã chạy nền') + ` · PID ${shown} · http://localhost:${PORT}`);
  if (OPEN) console.log(c.y(`  ⚠ Mở cho máy khác (HOST=${HOST}) — nên đặt DASHBOARD_PASSWORD trong .env`));
  console.log(c.d(`  log:  agyproxy logs -f   (${LOG_FILE})`));
  console.log(c.d(`  data: ${HOME}`));
}

function stop() {
  const pid = readPid();
  if (!pid) { console.log(c.y('Không có tiến trình nền nào đang chạy.')); return; }
  try { process.kill(pid, 'SIGTERM'); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  console.log(c.g('✓ Đã dừng') + ` (PID ${pid})`);
}

async function status() {
  const remote = isRemote();
  // Từ xa thì không có PID để đọc — "sống hay chết" phải hỏi qua HTTP.
  const pid = remote ? null : readPid();
  let o = null, err = null;
  try { o = await httpJson(`${baseUrl()}/api/overview`); } catch (e) { err = e.message; }

  if (has('--json')) {
    console.log(JSON.stringify({
      version: PKG.version, url: baseUrl(), remote, pid,
      up: !!o, ...(err ? { error: err } : {}),
      ...(o ? { accounts: o.accounts, gateway: o.gateway, usage: o.usage } : {}),
    }, null, 2));
    if (!o) process.exit(1);
    return;
  }

  console.log(c.b(`agyproxy v${PKG.version}`));
  if (remote) {
    console.log(`  Server     : ${baseUrl()} ${o ? c.g('(đang chạy)') : c.r('(không trả lời)')}`);
  } else {
    console.log(`  Tiến trình : ${pid ? c.g('đang chạy') + ` (PID ${pid})` : c.r('đã dừng')}`);
    console.log(`  Dashboard  : http://localhost:${PORT}`);
    console.log(`  Gateway    : http://localhost:${PORT}/proxy/v1`);
    const lan = lanIp();
    if (lan) console.log(`  Máy khác   : http://${lan}:${PORT}${OPEN ? '' : c.d('  (đang chỉ localhost — mở bằng: agyproxy restart --host 0.0.0.0)')}`);
    console.log(`  Dữ liệu    : ${HOME}`);
  }
  if (o) {
    console.log(`  Tài khoản  : ${o.accounts.total} · pool bật ${o.gateway.enabled}/${o.gateway.total} · cooldown ${o.gateway.cooldown} · chết ${o.gateway.dead}`);
    console.log(`  Requests7d : ${o.usage.totals.requests} · tokens ${o.usage.totals.tokIn + o.usage.totals.tokOut}`);
  } else if (pid || remote) {
    console.log(c.d(`  (không lấy được số liệu: ${err})`));
  }
}

function logs(follow) {
  if (!existsSync(LOG_FILE)) { console.log(c.y('Chưa có log. Chạy: agyproxy start -d')); return; }
  const args = follow ? ['-n', '80', '-f', LOG_FILE] : ['-n', '120', LOG_FILE];
  spawn('tail', args, { stdio: 'inherit' });
}

function gitAvailable() {
  try { execFileSync('git', ['-C', ROOT, 'rev-parse', '--git-dir'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/**
 * Cập nhật — dùng CHUNG `src/updater.ts` với dashboard.
 *
 * Trước đây đây là bản thứ hai, chép gần y hệt (~65 dòng). Chúng ĐÃ lệch nhau thật:
 * dashboard dọn `web/dist` trước khi pull còn CLI thì chưa, nên `agyproxy update` trên
 * production chết với "local changes to web/dist/index.html would be overwritten". Vá
 * xong bên này thì bên kia lại thiếu thứ khác.
 *
 * CLI vẫn giữ hai việc mà dashboard không làm được: DỪNG tiến trình trước khi cập nhật
 * (tránh ghi đè file đang chạy) và KHỞI ĐỘNG LẠI sau khi xong.
 */
/**
 * Nạp `src/updater.ts` từ CLI (chạy bằng `node` thuần, không hiểu TypeScript).
 *
 * `tsx/esm/api` cho phép đăng ký loader ngay trong tiến trình, thay vì phải chạy lại
 * chính mình dưới `node --import tsx`.
 */
async function napUpdater() {
  const { register } = await import('tsx/esm/api');
  const unregister = register();
  try {
    return await import(pathToFileURL(resolve(ROOT, 'src/updater.ts')).href);
  } finally {
    unregister();
  }
}

async function update(check) {
  const { checkUpdate, runUpdate } = await napUpdater();

  console.log(c.d(`Hiện tại: v${PKG.version} · kiểm tra ${REPO}…`));
  const info = await checkUpdate();
  if (info.error && !info.hasUpdate) {
    console.log(c.r('✗ Không kiểm tra được: ') + info.error);
    return;
  }
  if (!info.hasUpdate) {
    console.log(c.g(`✓ Đang dùng bản mới nhất (v${info.current})`));
    return;
  }

  // So theo COMMIT nên phải nói rõ thiếu gì — version thường không đổi giữa các bản vá.
  console.log(c.y(`→ Thiếu ${info.behind ?? '?'} commit` + (info.latest !== info.current ? ` · v${info.latest}` : '')));
  for (const l of info.commits ?? []) console.log(c.d('    ' + l));
  if (check) { console.log(c.d('  Chạy: agyproxy update')); return; }

  if (!info.canSelfUpdate) {
    console.log(c.r('✗ Bản cài không phải git checkout.'));
    console.log(c.d(`  Cài lại: npm i -g github:${REPO}`));
    return;
  }

  const wasRunning = readPid();
  if (wasRunning) { console.log(c.d('  Dừng tiến trình để cập nhật…')); stop(); }

  const steps = await runUpdate((s) => {
    console.log((s.ok ? c.g('  ✓ ') : c.r('  ✗ ')) + s.step + (s.detail ? c.d(' — ' + s.detail) : ''));
  });

  if (!steps.every((s) => s.ok)) {
    console.log(c.r('✗ Cập nhật không hoàn tất.'));
    // Vẫn khởi động lại: bước lùi trong runUpdate đã đưa cây mã về trạng thái chạy được.
  }
  if (wasRunning) { console.log(c.d('  Khởi động lại…')); start(true); }
}

// ---------- service (tự chạy khi reboot): systemd (Linux) | launchd (macOS) ----------
const IS_MAC = process.platform === 'darwin';
const SVC_LABEL = 'com.agyproxy';
const PLIST = resolve(homedir(), 'Library/LaunchAgents', `${SVC_LABEL}.plist`);
const UNIT_DIR = resolve(homedir(), '.config/systemd/user');
const UNIT = resolve(UNIT_DIR, 'agyproxy.service');

function svcExecArgs() {
  // node --import tsx src/index.ts  (chạy trực tiếp, service manager lo phần nền)
  return [process.execPath, '--import', 'tsx', ENTRY];
}

function svcInstall() {
  const running = readPid();
  if (running) { console.log(c.d('  Dừng daemon thủ công để service quản lý…')); stop(); }
  const [node, ...args] = svcExecArgs();
  const env = { AGY_HOME: HOME, PORT: String(PORT), NODE_ENV: 'production', ...hostEnv };
  if (OPEN) console.log(c.y(`  ⚠ Service mở cho máy khác (HOST=${HOST}) — nên đặt DASHBOARD_PASSWORD trong .env`));
  // macOS TCC chặn LaunchAgent ghi vào Desktop/Documents/Downloads → log ra ~/Library/Logs.
  const svcLog = IS_MAC && /\/(Desktop|Documents|Downloads)\//i.test(LOG_FILE)
    ? resolve(homedir(), 'Library/Logs/agyproxy.log')
    : LOG_FILE;

  if (IS_MAC) {
    mkdirSync(dirname(PLIST), { recursive: true });
    const envXml = Object.entries(env).map(([k, v]) => `      <key>${k}</key><string>${v}</string>`).join('\n');
    writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SVC_LABEL}</string>
  <key>ProgramArguments</key><array>
${[node, ...args].map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key><dict>
${envXml}
      <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${svcLog}</string>
  <key>StandardErrorPath</key><string>${svcLog}</string>
</dict></plist>
`);
    try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['load', '-w', PLIST], { stdio: 'inherit' });
    console.log(c.g('✓ Đã cài service (launchd)') + ` · ${PLIST}`);
    console.log(c.d('  Tự chạy khi đăng nhập máy. Tắt: agyproxy service uninstall'));
  } else {
    mkdirSync(UNIT_DIR, { recursive: true });
    const envLines = Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
    writeFileSync(UNIT, `[Unit]
Description=agyproxy — Antigravity gateway
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
${envLines}
ExecStart=${[node, ...args].join(' ')}
Restart=always
RestartSec=5
StandardOutput=append:${svcLog}
StandardError=append:${svcLog}

[Install]
WantedBy=default.target
`);
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'agyproxy'], { stdio: 'inherit' });
    console.log(c.g('✓ Đã cài service (systemd --user)') + ` · ${UNIT}`);
    try { execFileSync('loginctl', ['enable-linger', process.env.USER || ''], { stdio: 'ignore' }); console.log(c.d('  Đã bật linger → chạy cả khi chưa đăng nhập (reboot vẫn lên).')); }
    catch { console.log(c.y('  Lưu ý: chạy `sudo loginctl enable-linger $USER` để tự lên sau reboot.')); }
  }
}

function svcUninstall() {
  if (IS_MAC) {
    if (!existsSync(PLIST)) { console.log(c.y('Chưa cài service.')); return; }
    try { execFileSync('launchctl', ['unload', '-w', PLIST], { stdio: 'ignore' }); } catch {}
    try { unlinkSync(PLIST); } catch {}
    console.log(c.g('✓ Đã gỡ service (launchd)'));
  } else {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'agyproxy'], { stdio: 'inherit' }); } catch {}
    try { unlinkSync(UNIT); } catch {}
    try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch {}
    console.log(c.g('✓ Đã gỡ service (systemd)'));
  }
}

function svcCtl(action) {
  if (IS_MAC) {
    if (!existsSync(PLIST)) { console.log(c.y('Chưa cài service. Chạy: agyproxy service install')); return; }
    if (action === 'status') {
      try {
        const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' }).split('\n').find((l) => l.includes(SVC_LABEL));
        console.log(out ? c.g('✓ Service đang bật (launchd)') + c.d(`  ${out.trim()}`) : c.r('✗ Service đã cài nhưng chưa nạp'));
      } catch { console.log(c.r('không đọc được trạng thái')); }
      return;
    }
    if (action === 'stop') { try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {} console.log(c.g('✓ Đã dừng service')); }
    if (action === 'start') { try { execFileSync('launchctl', ['load', '-w', PLIST], { stdio: 'ignore' }); } catch {} console.log(c.g('✓ Đã bật service')); }
    if (action === 'restart') { try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); execFileSync('launchctl', ['load', '-w', PLIST], { stdio: 'ignore' }); } catch {} console.log(c.g('✓ Đã khởi động lại service')); }
  } else {
    try { execFileSync('systemctl', ['--user', action, 'agyproxy'], { stdio: 'inherit' }); } catch (e) { console.log(c.r('lỗi: ') + (e?.message ?? e)); }
  }
}

function service(sub) {
  switch (sub) {
    case 'install': case 'enable': svcInstall(); break;
    case 'uninstall': case 'remove': case 'disable': svcUninstall(); break;
    case 'start': case 'stop': case 'restart': case 'status': svcCtl(sub); break;
    default:
      console.log(`${c.b('agyproxy service')} — tự chạy khi reboot (${IS_MAC ? 'launchd/macOS' : 'systemd/Linux'})
  install    cài + bật (tự chạy khi khởi động máy)
  uninstall  gỡ hẳn service
  start | stop | restart | status`);
  }
}

function help() {
  console.log(`${c.b('agyproxy')} v${PKG.version} — Antigravity gateway CLI

  ${c.b('agyproxy start')}         chạy (foreground)
  ${c.b('agyproxy start -d')}      chạy nền (daemon)
  ${c.b('agyproxy stop')}          dừng tiến trình nền
  ${c.b('agyproxy restart')}       khởi động lại (nền)
  ${c.b('agyproxy status')}        trạng thái + số liệu
  ${c.b('agyproxy logs [-f]')}     xem log (-f theo dõi)
  ${c.b('agyproxy update')}        cập nhật từ GitHub (${REPO})
  ${c.b('agyproxy update --check')} chỉ kiểm tra có bản mới không
  ${c.b('agyproxy service ...')}   tự chạy khi reboot (${IS_MAC ? 'launchd' : 'systemd'})
     ${c.d('install | uninstall | start | stop | restart | status')}
  ${c.b('agyproxy setup-claude')}  cắm Claude Code vào pool  ${c.d('[--profile] [--model kr/claude-sonnet-4]')}
  ${c.b('agyproxy setup-codex')}   cắm Codex   ${c.d('· setup-hermes · setup-antigravity')}
     ${c.d('thêm --dry-run để xem trước, --undo để gỡ')}
  ${c.b('agyproxy version')}       phiên bản

  ${c.b('── backup ──')}
  ${c.b('agyproxy backup')}         xuất backup  ${c.d('[--keep 10] [--history] · account, credential, api key, settings, combo')}
  ${c.b('agyproxy backup list')}    liệt kê bản đã lưu
  ${c.b('agyproxy backup restore')} khôi phục  ${c.d('[file|latest] [--mode merge|replace]')}
  ${c.b('agyproxy backup schedule')} tự backup hằng ngày  ${c.d('[on|off|status] [--hour 3] [--keep 10]')}

  ${c.b('── bật/tắt nhanh ──')}
  ${c.b('agyproxy off')} / ${c.b('on')}      tắt/bật gateway ${c.d('(server vẫn chạy)')}
  ${c.b('agyproxy metrics')}        rps · error rate · p99 · circuit breaker  ${c.d('[--json]')}
  ${c.b('agyproxy rotation')}       xem/đổi chiến lược xoay  ${c.d('[round-robin|full-first|failover|highest-first|smart]')}
  ${c.b('agyproxy model')}          xem cấu hình  ${c.d('· --big combo/agyproxy --small agy/gemini-2.5-flash')}
  ${c.b('agyproxy accounts')}       trạng thái pool  ${c.d('[on|off|wake] [--provider agy|kr]')}
     ${c.d('wake = gỡ cooldown hàng loạt sau sự cố upstream')}

  ${c.b('── điều khiển từ xa / từ tool ngoài ──')}
  ${c.b('agyproxy token')}         in token CLI ${c.d('(chạy TRÊN MÁY CHỦ)')}
     ${c.d('hoặc mở Dashboard → Cấu hình → CLI Tools: có sẵn token + lệnh copy-paste')}
  ${c.b('agyproxy connect <url>')} lưu kết nối  ${c.d('--token <tok> · ghi ~/.agyproxy/cli.json')}
  ${c.b('agyproxy ping')}          server sống không + độ trễ  ${c.d('[--json]')}
  ${c.b('agyproxy routes')}        liệt kê toàn bộ endpoint  ${c.d('[--json]')}
  ${c.b('agyproxy api <M> <path>')} gọi thẳng API bất kỳ  ${c.d('[json | -]')}
  ${c.b('agyproxy chat <model> <prompt>')} gọi model, có failover  ${c.d('[--account] [--max] [--out] [--json]')}
     ${c.d('model ảnh: ảnh ghi ra file, không đổ data URI ra terminal')}
  ${c.b('agyproxy setup-mcp')}     cấu hình MCP cho Claude Code / Hermes  ${c.d('[--json]')}
     ${c.d('agent điều khiển agyproxy bằng tool-calling — 12 tool đọc + 4 ghi an toàn')}
     ${c.d("vd: agyproxy api /api/overview")}
     ${c.d('vd: agyproxy chat agy/gemini-3-flash "2+2 bằng mấy?"')}
     ${c.d("    agyproxy api PATCH /api/gateway/config '{\"rotation\":\"smart\"}'")}
     ${c.d('    cat big.json | agyproxy api POST /api/accounts/import -')}

  ${c.d('Mọi lệnh nhận --url/--token, hoặc env AGY_URL/AGY_TOKEN, để trỏ sang máy khác.')}
  ${c.d('Không cài CLI cũng dùng được:  curl -u :<token> <url>/api/overview')}

  Dashboard: http://localhost:${PORT}   ·   Gateway: /proxy/v1
  Dữ liệu:   ${HOME}   (đổi bằng env AGY_HOME)`);
}

// ---------- backup ----------
const BACKUP_DIR = resolve(HOME, 'backups');

/**
 * Xuất backup ra file. Nội dung gồm CẢ SECRET (apiKey gateway, hash mật khẩu dashboard,
 * sessionSecret, refresh token của mọi account) để khôi phục máy mới là chạy được ngay
 * → file này nhạy cảm như chính DB, ghi quyền 600.
 */
async function backupRun(keep, history) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const data = await httpJson(`${baseUrl()}/api/backup/export${history ? '?history=1' : ''}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = resolve(BACKUP_DIR, `backup_${stamp}.json`);
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  const kb = Math.round(statSync(file).size / 1024);
  const n = data.counts ?? {};
  console.log(c.g(`✓ ${file}`));
  const tb = data.tables ?? {};
  const nKeys = (tb.api_keys ?? []).length;
  const nHist = Object.entries(tb).filter(([k]) => k !== 'api_keys').reduce((s, [, v]) => s + v.length, 0);
  console.log(c.d(`  ${kb}KB · ${n.accounts ?? '?'} account · ${n.credentials ?? '?'} credential · ${(data.combos ?? []).length} combo · ${nKeys} api key${nHist ? ` · ${nHist} dòng lịch sử` : ''}`));
  if (!history) console.log(c.d('  (thêm --history để kèm usage/quota/runs)'));

  // Dọn bản cũ, giữ N gần nhất (mặc định 10).
  const all = readdirSync(BACKUP_DIR).filter((f) => /^backup_.*\.json$/.test(f)).sort();
  const drop = all.slice(0, Math.max(0, all.length - keep));
  for (const f of drop) unlinkSync(resolve(BACKUP_DIR, f));
  if (drop.length) console.log(c.d(`  đã xoá ${drop.length} bản cũ (giữ ${keep})`));
}

function backupList() {
  if (!existsSync(BACKUP_DIR)) return console.log(c.y('Chưa có backup nào.'));
  const all = readdirSync(BACKUP_DIR).filter((f) => /^backup_.*\.json$/.test(f)).sort().reverse();
  if (!all.length) return console.log(c.y('Chưa có backup nào.'));
  for (const f of all) {
    const s = statSync(resolve(BACKUP_DIR, f));
    console.log(`  ${c.b(f)}  ${c.d(Math.round(s.size / 1024) + 'KB · ' + s.mtime.toLocaleString())}`);
  }
  console.log(c.d(`\n  ${BACKUP_DIR}`));
}

/** Khôi phục. mode=merge (mặc định, gộp) hoặc replace (thay sạch). */
async function backupRestore(fileArg, mode) {
  let file = fileArg;
  if (!file || file === 'latest') {
    const all = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR).filter((f) => /^backup_.*\.json$/.test(f)).sort() : [];
    if (!all.length) { console.log(c.r('Không có backup nào để khôi phục.')); process.exit(1); }
    file = resolve(BACKUP_DIR, all[all.length - 1]);
  }
  if (!existsSync(file)) { console.log(c.r(`Không thấy file: ${file}`)); process.exit(1); }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const r = await postJson(`${baseUrl()}/api/backup/import`, { data, mode: mode === 'replace' ? 'replace' : 'merge' });
  console.log(c.g(`✓ Đã khôi phục (${mode === 'replace' ? 'replace' : 'merge'}) từ ${file}`));
  console.log(c.d('  ' + JSON.stringify(r)));
}

const CRON_TAG = '# agyproxy-backup';

/** Bật/tắt backup tự động qua crontab. Mặc định 3:00 sáng mỗi ngày, giữ 10 bản. */
function backupSchedule(action, hour, keep) {
  const read = () => { try { return execFileSync('crontab', ['-l'], { encoding: 'utf8' }); } catch { return ''; } };
  const write = (txt) => execFileSync('crontab', ['-'], { input: txt.endsWith('\n') ? txt : txt + '\n' });
  const strip = (txt) => txt.split('\n').filter((l) => !l.includes(CRON_TAG)).join('\n').replace(/\n+$/, '');

  if (action === 'off') {
    const cur = read();
    if (!cur.includes(CRON_TAG)) return console.log(c.y('Chưa bật backup tự động.'));
    write(strip(cur));
    return console.log(c.g('✓ Đã tắt backup tự động'));
  }
  if (action === 'status') {
    const line = read().split('\n').find((l) => l.includes(CRON_TAG));
    return console.log(line ? c.g('✓ đang bật:') + '\n  ' + c.d(line) : c.y('Chưa bật backup tự động.'));
  }
  // bật (mặc định)
  const h = Number(hour ?? 3);
  const k = Number(keep ?? 10);
  // Dùng đường dẫn tuyệt đối: cron chạy với PATH rất tối giản, `node`/`agyproxy` thường không có.
  const line = `0 ${h} * * * ${process.execPath} ${resolve(__dirname, 'agyproxy.mjs')} backup --keep ${k} >> ${resolve(HOME, 'backup.log')} 2>&1 ${CRON_TAG}`;
  const cur = strip(read());
  write((cur ? cur + '\n' : '') + line);
  console.log(c.g(`✓ Backup tự động: ${h}:00 mỗi ngày, giữ ${k} bản`));
  console.log(c.d(`  log: ${resolve(HOME, 'backup.log')}`));
}

// ---------- metrics ----------
function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '?';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(Math.floor(sec % 60)).padStart(2, '0')}s` : `${Math.floor(sec)}s`;
}

/** Số liệu tức thời từ /api/metrics: rps, error rate, p50/p95/p99, pool, circuit breaker. */
async function metricsCmd(json) {
  let m;
  try {
    m = await httpJson(`${baseUrl()}/api/metrics`);
  } catch (e) {
    console.log(c.r('✗ Không gọi được /api/metrics: ') + (e?.message ?? e));
    console.log(c.d('  Server chạy chưa? agyproxy start -d'));
    process.exitCode = 1;
    return;
  }
  if (json) { console.log(JSON.stringify(m, null, 2)); return; }
  const w = m.window ?? {};
  const lat = w.latency;
  const errPct = Math.round((w.errorRate ?? 0) * 1000) / 10;
  console.log(c.b('Metrics') + c.d(` · cửa sổ ${w.windowSec ?? '?'}s · uptime ${fmtDur(m.uptimeSec)} · RAM ${m.rssMb}MB`));
  console.log(`  requests  ${c.b(w.requests ?? 0)} (${w.rps ?? 0}/s)  ·  lỗi ${(w.errors ?? 0) > 0 ? c.r(w.errors) : c.g(0)} (${errPct}%)`);
  console.log(`  latency   ${lat ? `avg ${lat.avgMs}ms · p50 ${lat.p50}ms · p95 ${lat.p95}ms · p99 ${c.b(lat.p99 + 'ms')}` : c.d('chưa có request nào trong cửa sổ')}`);
  console.log(`  luỹ kế    ${w.totals?.requests ?? 0} requests · ${w.totals?.errors ?? 0} lỗi ${c.d('(từ lúc process chạy)')}`);
  for (const [pid, a] of Object.entries(m.accounts ?? {})) {
    const br = m.breaker?.[pid];
    const brTxt = !br || br.state === 'closed'
      ? c.g('mạch đóng')
      : br.state === 'open' ? c.r(`mạch MỞ (${br.consecutiveFails} lỗi liên tiếp)`) : c.y('mạch thăm dò');
    console.log(`  ${c.b(pid.padEnd(4))} ${a.available}/${a.total} khả dụng · inflight ${a.inflight} · ${brTxt}`);
  }
}

// ---------- rotation ----------
const ROTATION_STRATEGIES = ['round-robin', 'full-first', 'failover', 'highest-first', 'smart'];

/** Xem/đổi chiến lược xoay account của pool. Không truyền gì → chỉ xem. */
async function rotationCmd(strategy) {
  if (!strategy) {
    const g = await httpJson(`${baseUrl()}/api/gateway/config`);
    console.log(`  rotation hiện tại: ${c.b(g.rotation)}`);
    console.log(c.d(`  đổi: agyproxy rotation <${ROTATION_STRATEGIES.join('|')}>`));
    return;
  }
  if (!ROTATION_STRATEGIES.includes(strategy)) {
    console.log(c.r(`✗ Chiến lược không hợp lệ: ${strategy}`));
    console.log(c.d(`  hợp lệ: ${ROTATION_STRATEGIES.join(', ')}`));
    process.exitCode = 1;
    return;
  }
  await patchJson(`${baseUrl()}/api/gateway/config`, { rotation: strategy });
  console.log(c.g(`✓ Đã đổi rotation → ${strategy}`));
}

// ---------- bật/tắt nhanh ----------
async function gatewayToggle(on) {
  await patchJson(`${baseUrl()}/api/gateway/config`, { enabled: on });
  console.log(on ? c.g('✓ Gateway BẬT') : c.y('✓ Gateway TẮT — mọi request suy luận bị chặn (server vẫn chạy)'));
}

/** Đổi model mặc định cho Claude Code (big/small). Không truyền gì → chỉ xem. */
async function modelCmd(big, small) {
  if (!big && !small) {
    const g = await httpJson(`${baseUrl()}/api/gateway/config`);
    console.log(`  rotation    ${c.b(g.rotation)}`);
    console.log(`  cooldownSec ${c.b(g.cooldownSec)}`);
    console.log(`  gateway     ${g.enabled ? c.g('BẬT') : c.y('TẮT')}`);
    console.log(c.d('\n  đổi model: agyproxy model --big combo/agyproxy --small agy/gemini-2.5-flash'));
    return;
  }
  const patch = {};
  if (big) patch.anthropicBigModel = big;
  if (small) patch.anthropicSmallModel = small;
  const r = await patchJson(`${baseUrl()}/api/settings`, patch);
  console.log(c.g(`✓ Đã đổi: ${(r.changed ?? Object.keys(patch)).join(', ')}`));
  if (big) console.log(c.d(`  big   = ${big}`));
  if (small) console.log(c.d(`  small = ${small}`));
}

/** Bật/tắt account theo provider, hoặc gỡ cooldown hàng loạt. */
async function accountsCmd(action, provider) {
  const p = provider || 'agy';
  if (action === 'wake') {
    const r = await postJson(`${baseUrl()}/api/gateway/accounts/wake`, { provider: p });
    console.log(r.woken ? c.g(`✓ Đã gỡ cooldown ${r.woken} account ${p}`) : c.g(`Không có account ${p} nào đang cooldown.`));
    return;
  }
  if (action === 'on' || action === 'off') {
    const j = await httpJson(`${baseUrl()}/api/gateway/accounts?provider=${p}`);
    const keys = (j.accounts ?? []).map((a) => a.key ?? a.email);
    const r = await postJson(`${baseUrl()}/api/gateway/accounts/bulk`, { emails: keys, enabled: action === 'on' });
    console.log(c.g(`✓ Đã ${action === 'on' ? 'BẬT' : 'TẮT'} ${r.updated ?? keys.length} account ${p}`));
    return;
  }
  // mặc định: xem trạng thái
  const j = await httpJson(`${baseUrl()}/api/gateway/accounts?provider=${p}`);
  const now = Date.now();
  const a = j.accounts ?? [];
  const dead = a.filter((x) => x.health === 'dead').length;
  const cd = a.filter((x) => (x.cooldownUntil ?? 0) > now).length;
  const off = a.filter((x) => !x.enabled).length;
  console.log(`  ${c.b(p)}: ${a.length} account`);
  console.log(`    khả dụng ${c.g(a.length - dead - cd - off)}  ·  cooldown ${c.y(cd)}  ·  tắt ${off}  ·  dead ${dead ? c.r(dead) : 0}`);
}

// ---------- interactive menu ----------
const MENU_ITEMS = [
  { label: '🚀 Chạy (foreground)',        action: () => start(false) },
  { label: '🚀 Chạy nền (daemon)',        action: () => start(true) },
  { label: '⏹  Dừng',                     action: () => stop() },
  { label: '🔄 Khởi động lại',            action: () => { stop(); setTimeout(() => start(true), 600); } },
  { label: '📊 Trạng thái',               action: () => status() },
  { label: '📋 Xem log',                  action: () => logs(false) },
  { label: '🔄 Cập nhật',                 action: () => update(false) },
  { label: '💾 Backup',                   action: () => backupRun(10) },
  { label: '⚙️  Cài service tự chạy',     action: () => svcInstall() },
  { label: '❓ Trợ giúp',                 action: () => help() },
];

function interactiveMenu() {
  return new Promise((resolve) => {
    let selected = 0;
    const total = MENU_ITEMS.length;

    const render = () => {
      // Move cursor up to overwrite previous render (except first time)
      if (render._drawn) process.stdout.write(`\x1b[${total + 2}A`);
      render._drawn = true;

      console.log(c.b(`agyproxy v${PKG.version}`) + c.d(' — chọn lệnh (↑↓ di chuyển, Enter chọn, q/Esc thoát)\n'));
      for (let i = 0; i < total; i++) {
        if (i === selected) {
          process.stdout.write(`  \x1b[7m ${MENU_ITEMS[i].label} \x1b[0m\n`);
        } else {
          process.stdout.write(`   ${MENU_ITEMS[i].label}\n`);
        }
      }
    };

    render();

    const { stdin } = process;
    if (!stdin.isTTY) { resolve(null); return; }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onKey);
    };

    const onKey = (key) => {
      // Ctrl+C
      if (key === '\x03') { cleanup(); process.exit(0); }
      // q or Esc
      if (key === 'q' || (key === '\x1b' && key.length === 1)) { cleanup(); console.log(); resolve(null); return; }
      // Escape sequences for arrow keys: \x1b[A (up), \x1b[B (down)
      if (key === '\x1b[A') { selected = (selected - 1 + total) % total; render(); return; }
      if (key === '\x1b[B') { selected = (selected + 1) % total; render(); return; }
      // Enter
      if (key === '\r' || key === '\n') { cleanup(); console.log(); resolve(MENU_ITEMS[selected]); return; }
    };

    stdin.on('data', onKey);
  });
}

// ---------- điều khiển từ tool ngoài ----------

/**
 * `agyproxy token` — in token CLI, chạy TRÊN MÁY CHỦ.
 *
 * Tách khỏi `connect` vì hai lệnh chạy ở hai máy khác nhau: `token` cần đọc SQLite nên
 * chỉ chạy được tại chỗ, còn `connect` chạy ở máy tool. Token sinh tự động nếu chưa có.
 */
function tokenCmd() {
  if (isRemote()) die('`token` phải chạy TRÊN MÁY CHỦ (nó đọc SQLite cục bộ).');
  const { pass } = dashCreds();
  if (has('--json')) { console.log(JSON.stringify({ url: baseUrl(), token: pass })); return; }
  const ip = lanIp();
  console.log(`${c.b('Token CLI:')} ${pass}\n`);
  console.log(c.d('Trên máy tool:'));
  console.log(`  agyproxy connect http://${ip || '<ip-máy-chủ>'}:${PORT} --token ${pass}\n`);
  console.log(c.d('Hoặc không cần cài CLI — dùng thẳng HTTP:'));
  console.log(c.d(`  curl -u :${pass} http://${ip || '<ip>'}:${PORT}/api/overview`));
}

/**
 * `agyproxy connect <url> --token <tok>` — lưu vào ~/.agyproxy/cli.json.
 *
 * Kiểm tra ngay bằng /api/auth/me thay vì lưu mù: sai token mà vẫn ghi file thì lỗi chỉ
 * lộ ra ở lệnh sau đó, và người dùng sẽ đi tìm nhầm chỗ.
 */
async function connectCmd(url) {
  if (!url) die('Dùng: agyproxy connect <url> --token <token>\n  vd: agyproxy connect http://100.112.240.4:7788 --token abc123');
  const clean = String(url).replace(/\/+$/, '');
  const token = flagVal('--token') || process.env.AGY_TOKEN;
  if (!token) die('Thiếu --token. Lấy bằng cách chạy `agyproxy token` trên máy chủ.');
  const user = flagVal('--user') || '';

  const basic = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
  let me;
  try {
    const r = await fetch(`${clean}/api/auth/me`, {
      headers: { authorization: basic, accept: 'application/json', 'user-agent': 'agyproxy-cli' },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401) die(`Token bị từ chối bởi ${clean}. Kiểm lại bằng \`agyproxy token\` trên máy chủ.`);
    if (!r.ok) die(`${clean} trả HTTP ${r.status}.`);
    me = await r.json().catch(() => ({}));
  } catch (e) {
    if (e?.name === 'TimeoutError') die(`Không kết nối được ${clean} (quá hạn 15s). Server có đang chạy và mở cổng ra ngoài không?`);
    die(`Không kết nối được ${clean}: ${e.message}`);
  }

  writeCliConfig({ url: clean, token, ...(user ? { user } : {}) });
  console.log(c.g('✓ Đã kết nối ') + clean + (me?.user ? c.d(`  (user: ${me.user})`) : ''));
  console.log(c.d(`  Lưu tại ${CONFIG_FILE} (chmod 600)`));
}

/** `agyproxy ping` — server sống không, phiên bản nào, mất bao lâu. */
async function pingCmd() {
  const t0 = Date.now();
  try {
    const h = await httpJson(`${baseUrl()}/api/health`);
    const ms = Date.now() - t0;
    if (has('--json')) { console.log(JSON.stringify({ ok: true, url: baseUrl(), ms, ...h })); return; }
    console.log(`${c.g('✓')} ${baseUrl()}  ${c.d(`${ms}ms`)}  v${h.version ?? '?'}  ${c.d(`${h.accounts ?? 0} account`)}`);
  } catch (e) {
    if (has('--json')) { console.log(JSON.stringify({ ok: false, url: baseUrl(), error: e.message })); process.exit(1); }
    die(`${baseUrl()} không trả lời: ${e.message}`);
  }
}

/**
 * `agyproxy api <METHOD> <đường-dẫn> [body-json]` — gọi thẳng bất kỳ endpoint nào.
 *
 * Đây là lý do CLI không cần 89 lệnh con: bọc tay từng route thì mỗi lần backend thêm
 * endpoint là CLI lại tụt lại phía sau, và tool ngoài phải chờ mình bọc. Passthrough
 * phủ toàn bộ API ngay lập tức, kể cả route thêm sau này.
 *
 * Luôn in JSON thô ra stdout để `jq` xử lý được; lỗi ra stderr + exit≠0 để script
 * `set -e` dừng đúng chỗ.
 */
async function apiCmd(args) {
  const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
  let method = 'GET', i = 0;
  if (args[0] && METHODS.has(args[0].toUpperCase())) { method = args[0].toUpperCase(); i = 1; }
  const path = args[i];
  if (!path) {
    die('Dùng: agyproxy api [GET|POST|PATCH|DELETE] <đường-dẫn> [json]\n' +
        '  vd: agyproxy api /api/overview\n' +
        '      agyproxy api PATCH /api/gateway/config \'{"rotation":"smart"}\'\n' +
        '  Xem danh sách endpoint: agyproxy routes');
  }
  const url = `${baseUrl()}${path.startsWith('/') ? path : '/' + path}`;

  // Body: tham số kế tiếp, hoặc `-` để đọc stdin (payload lớn khỏi vướng giới hạn argv).
  let body;
  const raw = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
  if (raw === '-') {
    body = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } else if (raw) {
    try { body = JSON.parse(raw); } catch { die(`Body không phải JSON hợp lệ: ${raw}`); }
  }

  const { user, pass } = dashCreds();
  const r = await fetch(url, {
    method,
    headers: {
      'user-agent': 'agyproxy-cli', accept: 'application/json',
      authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(Number(flagVal('--timeout')) || 60000),
  }).catch((e) => die(`Không gọi được ${url}: ${e.message}`));

  const text = await r.text();
  // Không phải endpoint nào cũng trả JSON (vd usage/export.csv) — cứ in thô.
  if (!r.ok) {
    console.error(c.r(`HTTP ${r.status}`) + ' ' + url);
    if (text) console.error(text);
    process.exit(1);
  }
  if (!text) { console.log('{}'); return; }
  try { console.log(JSON.stringify(JSON.parse(text), null, has('--compact') ? 0 : 2)); }
  catch { console.log(text); }
}

/**
 * `agyproxy chat <model> <prompt>` — gọi model từ dòng lệnh.
 *
 * Trước đây muốn thử một model phải mở dashboard hoặc tự viết curl kèm header đúng.
 * Lệnh này dùng chính đường /api/gateway/chat mà màn Chat thử dùng, nên có đủ failover.
 *
 * Ảnh trả về là data URI vài trăm KB — KHÔNG in ra terminal (làm ngập màn hình và hỏng
 * cả scrollback). Ghi ra file rồi in đường dẫn.
 */
async function chatCmd(args) {
  const model = args[0];
  const prompt = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
  if (!model || !prompt) {
    die('Dùng: agyproxy chat <model> <prompt> [--account <email>] [--max <n>] [--json]\n' +
        '  vd: agyproxy chat agy/gemini-3-flash "2+2 bằng mấy?"\n' +
        '      agyproxy chat agy/gemini-3.1-flash-image "vẽ con mèo" --out mèo.png\n' +
        '  Xem model gọi được: agyproxy api /api/gateway/models');
  }

  const body = {
    model,
    content: prompt,
    account: flagVal('--account') || undefined,
    maxTokens: Number(flagVal('--max')) || undefined,
  };

  const t0 = Date.now();
  const { user, pass } = dashCreds();
  // Model chậm (nhất là model ảnh) + failover 3 account → timeout phải rộng.
  const res = await fetch(`${baseUrl()}/api/gateway/chat`, {
    method: 'POST',
    headers: {
      'user-agent': 'agyproxy-cli', accept: 'application/json', 'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(flagVal('--timeout')) || 300_000),
  }).catch((e) => die(`Không gọi được server: ${e.message}`));

  const text = await res.text();
  let d;
  try { d = JSON.parse(text); } catch { die(`Server trả về không phải JSON: ${text.slice(0, 200)}`); }
  if (!res.ok || d.ok === false) die(`Lỗi ${res.status}: ${d.error ?? text.slice(0, 200)}`);

  if (has('--json')) { console.log(JSON.stringify(d, null, 2)); return; }
  if (d.text) console.log(d.text);

  for (const [i, img] of (d.images ?? []).entries()) {
    const m = /^data:(image\/\w+);base64,(.*)$/.exec(img);
    if (!m) continue;
    const ext = m[1].split('/')[1];
    const out = flagVal('--out') || `agyproxy-${Date.now()}-${i + 1}.${ext}`;
    writeFileSync(out, Buffer.from(m[2], 'base64'));
    console.log(c.b(`  ảnh → ${out}`) + c.d(` (${Math.round(m[2].length * 0.75 / 1024)} KB)`));
  }

  const tok = d.usage?.totalTokens;
  console.log(c.d(`\n  ${d.account ?? '?'} · ${d.ms ?? Date.now() - t0}ms${tok ? ` · ${tok} token` : ''}`));
}

/**
 * `agyproxy routes` — liệt kê endpoint bằng cách đọc chính mã nguồn server.
 *
 * Hai lý do bản trước BỎ SÓT đúng những endpoint quan trọng nhất (`/v1/chat/completions`,
 * `/v1/messages`, `/v1/models` — đo thật: gọi trả 200/400 nhưng không hề xuất hiện trong
 * danh sách):
 *   1. Regex chỉ nhận tiền tố `/api`, `/proxy`, `/events` — bỏ hẳn `/v1`, `/openai`,
 *      `/anthropic`.
 *   2. Route dialect KHÔNG đăng ký bằng `app.post('/đường-dẫn', …)` mà qua vòng lặp
 *      `for (const path of [...]) app.post(path, …)`, nên mẫu `.post('…')` không khớp.
 *
 * Hậu quả không nhỏ: Control và agent ngoài dựa vào lệnh này để khám phá endpoint, nên
 * danh sách thiếu khiến họ kết luận sai là gateway không hỗ trợ chuẩn đó.
 */
function routesCmd() {
  const found = new Set();
  /** Tiền tố được coi là endpoint HTTP công khai. */
  const PREFIX = String.raw`(?:api|proxy|events|v1|openai|anthropic)`;

  const walk = (dir) => {
    for (const n of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, n.name);
      if (n.isDirectory()) { walk(p); continue; }
      if (!n.name.endsWith('.ts')) continue;
      const src = readFileSync(p, 'utf8');

      // Dạng 1: app.post('/đường-dẫn', …) — đăng ký trực tiếp.
      for (const m of src.matchAll(
        new RegExp(String.raw`\.(get|post|patch|put|delete)\(\s*['"\`](\/${PREFIX}[^'"\`]*)`, 'g'),
      )) {
        found.add(`${m[1].toUpperCase().padEnd(6)} ${m[2]}`);
      }

      // Dạng 2: for (const path of ['/a', '/b']) app.post(path, …) — dialect dùng kiểu
      // này để phục vụ cùng handler dưới nhiều tiền tố.
      for (const m of src.matchAll(
        new RegExp(String.raw`for\s*\(\s*const\s+(\w+)\s+of\s+(\[[^\]]*\])\s*\)\s*\{?\s*app\.(get|post|patch|put|delete)\(\s*\1\b`, 'g'),
      )) {
        for (const q of m[2].matchAll(new RegExp(String.raw`['"\`](\/${PREFIX}[^'"\`]*)`, 'g'))) {
          found.add(`${m[3].toUpperCase().padEnd(6)} ${q[1]}`);
        }
      }

      // Dạng 3: mảng path khai báo ở biến ngoài rồi mới lặp (anthropicPaths).
      for (const m of src.matchAll(
        new RegExp(String.raw`for\s*\(\s*const\s+\w+\s+of\s+(\w+)\s*\)\s*\{?\s*app\.(get|post|patch|put|delete)\(`, 'g'),
      )) {
        const decl = new RegExp(String.raw`const\s+${m[1]}\s*(?::[^=]+)?=\s*(\[[^\]]*\])`).exec(src);
        if (!decl) continue;
        for (const q of decl[1].matchAll(new RegExp(String.raw`['"\`](\/${PREFIX}[^'"\`]*)`, 'g'))) {
          found.add(`${m[2].toUpperCase().padEnd(6)} ${q[1]}`);
        }
      }
    }
  };
  try { walk(resolve(ROOT, 'src')); } catch { die('Không đọc được src/ — lệnh này cần chạy trong thư mục cài đặt.'); }
  const list = [...found].sort((a, b) => a.slice(7).localeCompare(b.slice(7)));
  if (has('--json')) {
    console.log(JSON.stringify(list.map((s) => ({ method: s.slice(0, 6).trim(), path: s.slice(7) })), null, 2));
    return;
  }
  for (const r of list) console.log(`  ${c.b(r.slice(0, 6))} ${r.slice(7)}`);
  console.log(c.d(`\n  ${list.length} endpoint · gọi bằng: agyproxy api <METHOD> <đường-dẫn> [json]`));
}

/**
 * `agyproxy setup-mcp` — in cấu hình MCP để dán vào Claude Code / Hermes.
 *
 * KHÔNG tự ghi đè file config của người dùng: `~/.claude.json` chứa cả lịch sử hội thoại
 * và cấu hình project khác, ghi hỏng là mất nhiều thứ. In ra để dán vào là đủ, và người
 * dùng thấy được chính xác cái gì được thêm.
 */
function setupMcpCmd() {
  const { pass } = dashCreds();
  const url = baseUrl();
  const entry = {
    command: process.execPath,
    args: [resolve(ROOT, 'bin/agyproxy-mcp.mjs')],
    env: { AGY_URL: url, AGY_TOKEN: pass },
  };
  if (has('--json')) { console.log(JSON.stringify({ mcpServers: { agyproxy: entry } }, null, 2)); return; }

  console.log(`${c.b('Cấu hình MCP cho agyproxy')}  ${c.d(url)}\n`);
  console.log(c.d('Claude Code — thêm vào ~/.claude.json (khoá "mcpServers"):'));
  console.log(JSON.stringify({ mcpServers: { agyproxy: entry } }, null, 2));
  console.log(`\n${c.d('Hoặc dùng lệnh của Claude Code:')}`);
  console.log(`  claude mcp add agyproxy -e AGY_URL=${url} -e AGY_TOKEN=<token> -- ${process.execPath} ${resolve(ROOT, 'bin/agyproxy-mcp.mjs')}`);
  console.log(`\n${c.y('⚠')} AGY_TOKEN cho TOÀN QUYỀN điều khiển gateway — file config nên chmod 600.`);
  console.log(c.d('  Agent chỉ gọi được 16 tool trong allowlist: 12 đọc + 4 ghi an toàn'));
  console.log(c.d('  (gỡ cooldown · nạp quota · kiểm tra 1 account · đổi chiến lược xoay).'));
  console.log(c.d('  Xoá/restart/đổi mật khẩu/backup/lộ key đều KHÔNG expose.'));
}

// ---------- main ----------
const [cmd, ...rest] = process.argv.slice(2);
const has = (f) => rest.includes(f);

if (cmd === undefined) {
  // Không có argument → hiện menu interactive
  const choice = await interactiveMenu();
  if (choice) await choice.action();
} else {
// Lệnh thao tác tiến trình CỤC BỘ. Khi đang trỏ sang server máy khác thì chúng sẽ
// start/stop nhầm tiến trình trên máy đang gõ — im lặng làm sai còn tệ hơn báo lỗi.
// `restart` có lối đi từ xa qua API nên xử lý riêng bên dưới.
const LOCAL_ONLY = new Set(['start', 'stop', 'logs', 'log', 'service', 'svc', 'update', 'upgrade']);
if (LOCAL_ONLY.has(cmd) && isRemote()) {
  die(`\`${cmd}\` chỉ chạy được trên máy chủ (đang trỏ tới ${baseUrl()}).\n` +
      `  Khởi động lại từ xa:  agyproxy api POST /api/system/restart\n` +
      `  Cập nhật từ xa:       agyproxy api POST /api/system/update`);
}

switch (cmd) {
  case 'start': start(has('-d') || has('--detach') || has('--daemon')); break;
  case 'stop': stop(); break;
  case 'restart':
    // Từ xa: nhờ chính server tự khởi động lại. Tại chỗ: dừng rồi chạy lại.
    if (isRemote()) { await postJson(`${baseUrl()}/api/system/restart`, {}); console.log(c.g('✓ Đã yêu cầu server khởi động lại')); }
    else { stop(); setTimeout(() => start(true), 600); }
    break;
  case 'status': case 'st': await status(); break;
  case 'logs': case 'log': logs(has('-f') || has('--follow')); break;
  case 'update': case 'upgrade': await update(has('--check')); break;
  case 'service': case 'svc': service(rest[0]); break;
  case 'setup-claude':
  case 'setup-codex':
  case 'setup-hermes':
  case 'setup-antigravity': {
    const id = cmd === 'setup-claude' && has('--profile') ? 'claude-profile' : cmd.replace('setup-', '');
    await setupTool(id, {
      model: flagVal('--model'), small: flagVal('--small'), url: flagVal('--url'),
      dryRun: has('--dry-run'), undo: has('--undo'),
    });
    break;
  }
  case 'backup': {
    const sub = rest[0];
    if (sub === 'list' || sub === 'ls') backupList();
    else if (sub === 'restore') await backupRestore(rest[1], flagVal('--mode'));
    else if (sub === 'schedule' || sub === 'auto') backupSchedule(rest[1] ?? 'on', flagVal('--hour'), flagVal('--keep'));
    else await backupRun(Number(flagVal('--keep') ?? 10), process.argv.includes('--history'));
    break;
  }
  case 'on': await gatewayToggle(true); break;
  case 'off': await gatewayToggle(false); break;
  case 'metrics': case 'm': await metricsCmd(has('--json')); break;
  // Chỉ nhận rest[0] khi không phải flag — `rest.find(a => !a.startsWith('-'))` sẽ
  // bốc nhầm GIÁ TRỊ của flag toàn cục (vd `rotation --host 1.2.3.4` → '1.2.3.4').
  case 'rotation': case 'rotate': await rotationCmd(rest[0]?.startsWith('-') ? undefined : rest[0]); break;
  case 'model': await modelCmd(flagVal('--big'), flagVal('--small')); break;
  case 'accounts': case 'acc': await accountsCmd(rest[0], flagVal('--provider')); break;
  case 'claude': {
    // agyproxy claude <type> [args...] — mở Claude Code qua agy-proxy với model/combo theo task
    // type: code | fast | research | agent | vision | combo/<id> | <provider>/<model>
    const type = rest[0] || 'agent';
    const apiKey = (readFileSync(resolve(ROOT, '.env'), 'utf8').match(/^GATEWAY_API_KEY=(.*)$/m)?.[1] || '').trim();
    const env = { ...process.env, ANTHROPIC_BASE_URL: `http://localhost:${PORT}`, ANTHROPIC_API_KEY: apiKey };
    let model;
    if (type.startsWith('combo/') || type.includes('/')) model = type;
    else model = `combo/${type}`;
    // Bỏ type khỏi args (đã dùng làm model), giữ phần còn lại cho claude
    const claudeArgs = rest.slice(1);
    console.log(c.b(`🚀 Claude Code via agy-proxy · model: ${model}`));
    const cp = spawn('claude', ['--model', model, ...claudeArgs], { stdio: 'inherit', env });
    cp.on('exit', (code) => process.exit(code ?? 0));
    break;
  }
  case 'combos': case 'combo': {
    // agyproxy combos              → list
    // agyproxy combos create <id> <model1> <model2>...  → tạo combo mới
    const sub = rest[0];
    if (sub === 'create' || sub === 'add') {
      const id = rest[1];
      const models = rest.slice(2);
      if (!id || !models.length) {
        console.log(c.y('Dùng: agyproxy combos create <id> <model1> <model2> ...'));
        break;
      }
      const targets = models.map((m) => ({ model: m.startsWith('combo/') || m.includes('/') ? m : `combo/${m}` }));
      await postJson(`${baseUrl()}/api/combos`, { id, name: id, strategy: 'priority', targets, enabled: true });
      console.log(c.g(`✓ Đã tạo combo/${id}:`) + ' ' + models.join(' → '));
    } else {
      const d = await httpJson(`${baseUrl()}/api/combos`);
      console.log(c.b('Combos:'));
      for (const cmb of d.combos) {
        const models = (cmb.targets || []).map((t) => t.model).join(' → ');
        console.log(`  ${c.b(cmb.id)}: ${models} ${cmb.enabled ? '' : c.y('(tắt)')}`);
      }
      console.log(c.d('\nAuto variants: ' + d.autoVariants.join(', ')));
    }
    break;
  }
  // ── Điều khiển từ tool ngoài ──────────────────────────────────────────────
  case 'connect': await connectCmd(rest[0]); break;
  case 'token': tokenCmd(); break;
  case 'ping': await pingCmd(); break;
  case 'api': await apiCmd(rest); break;
  case 'chat': await chatCmd(rest); break;
  case 'routes': routesCmd(); break;
  case 'setup-mcp': setupMcpCmd(); break;

  case 'version': case '-v': case '--version': console.log(PKG.version); break;
  case 'help': case '-h': case '--help': help(); break;
  default: console.log(c.r(`Lệnh không hợp lệ: ${cmd}`)); help(); process.exit(1);
}
}
