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
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, statSync } from 'node:fs';
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

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[90m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (!pid) return null;
  try { process.kill(pid, 0); return pid; } catch { unlinkSync(PID_FILE); return null; }
}

function lanIp() {
  const ifs = networkInterfaces();
  for (const list of Object.values(ifs)) for (const n of list || []) {
    if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return null;
}

function tsxBin() {
  const local = resolve(ROOT, 'node_modules/.bin/tsx');
  return existsSync(local) ? local : 'tsx';
}

/**
 * Thông tin đăng nhập cho CLI. Mật khẩu trong DB đã được BĂM nên không dùng lại được;
 * CLI dùng token CLI riêng (sinh + lưu trong bảng settings) để gọi API.
 * Thứ tự: token CLI trong DB → .env DASHBOARD_PASSWORD → 123456.
 */
function dashCreds() {
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

async function postJson(url, body) {
  const { user, pass } = dashCreds();
  const r = await fetch(url, {
    method: 'POST',
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

// ---------- commands ----------
function start(detached) {
  const running = readPid();
  if (running) { console.log(c.y(`Đang chạy sẵn (PID ${running}) · http://localhost:${PORT}`)); return; }
  if (!detached) {
    console.log(c.d(`agyproxy v${PKG.version} · data: ${HOME}`));
    const p = spawn(tsxBin(), [ENTRY], { stdio: 'inherit', env: { ...process.env, ...hostEnv }, cwd: ROOT });
    p.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  const out = openSync(LOG_FILE, 'a');
  const p = spawn(tsxBin(), [ENTRY], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...hostEnv }, cwd: ROOT });
  p.unref();
  writeFileSync(PID_FILE, String(p.pid));
  console.log(c.g('✓ Đã chạy nền') + ` · PID ${p.pid} · http://localhost:${PORT}`);
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
  const pid = readPid();
  console.log(c.b(`agyproxy v${PKG.version}`));
  console.log(`  Tiến trình : ${pid ? c.g('đang chạy') + ` (PID ${pid})` : c.r('đã dừng')}`);
  console.log(`  Dashboard  : http://localhost:${PORT}`);
  console.log(`  Gateway    : http://localhost:${PORT}/proxy/v1`);
  const lan = lanIp();
  if (lan) console.log(`  Máy khác   : http://${lan}:${PORT}${OPEN ? '' : c.d('  (đang chỉ localhost — mở bằng: agyproxy restart --host 0.0.0.0)')}`);
  console.log(`  Dữ liệu    : ${HOME}`);
  try {
    const o = await httpJson(`http://localhost:${PORT}/api/overview`);
    console.log(`  Tài khoản  : ${o.accounts.total} · pool bật ${o.gateway.enabled}/${o.gateway.total} · cooldown ${o.gateway.cooldown} · chết ${o.gateway.dead}`);
    console.log(`  Requests7d : ${o.usage.totals.requests} · tokens ${o.usage.totals.tokIn + o.usage.totals.tokOut}`);
  } catch {
    if (pid) console.log(c.d('  (server chưa sẵn sàng hoặc PORT khác)'));
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

async function update(check) {
  console.log(c.d(`Hiện tại: v${PKG.version} · kiểm tra ${REPO}…`));
  let remote;
  try {
    // GitHub API trước (không dính CDN cache như raw.githubusercontent.com)
    const api = await fetch(`https://api.github.com/repos/${REPO}/contents/package.json?ref=main`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agyproxy-cli' },
      signal: AbortSignal.timeout(15000),
    });
    if (api.ok) {
      const j = await api.json();
      remote = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    } else {
      const raw = await fetch(`https://raw.githubusercontent.com/${REPO}/main/package.json`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!raw.ok) throw new Error(`HTTP ${raw.status}`);
      remote = JSON.parse(await raw.text());
    }
  } catch (e) {
    console.log(c.r('✗ Không kiểm tra được phiên bản: ') + (e?.message ?? e));
    return;
  }
  const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
  if (cmp(remote.version, PKG.version) <= 0) { console.log(c.g(`✓ Đang dùng bản mới nhất (v${PKG.version})`)); return; }
  console.log(c.y(`→ Có bản mới: v${remote.version}`));
  if (check) { console.log(c.d('  Chạy: agyproxy update')); return; }

  const wasRunning = readPid();
  if (wasRunning) { console.log(c.d('  Dừng tiến trình để cập nhật…')); stop(); }
  try {
    if (gitAvailable()) {
      console.log(c.d('  git pull…'));
      execFileSync('git', ['-C', ROOT, 'pull', '--ff-only'], { stdio: 'inherit' });
      execFileSync('npm', ['install', '--omit=dev'], { cwd: ROOT, stdio: 'inherit' });
    } else {
      console.log(c.d(`  npm install -g github:${REPO}…`));
      execFileSync('npm', ['install', '-g', `github:${REPO}`], { stdio: 'inherit' });
    }
    console.log(c.g(`✓ Đã cập nhật lên v${remote.version}`));
  } catch (e) {
    console.log(c.r('✗ Cập nhật lỗi: ') + (e?.message ?? e));
    return;
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

  Dashboard: http://localhost:${PORT}   ·   Gateway: /proxy/v1
  Dữ liệu:   ${HOME}   (đổi bằng env AGY_HOME)`);
}

// ---------- main ----------
const [cmd, ...rest] = process.argv.slice(2);
const has = (f) => rest.includes(f);
switch (cmd) {
  case 'start': start(has('-d') || has('--detach') || has('--daemon')); break;
  case 'stop': stop(); break;
  case 'restart': stop(); setTimeout(() => start(true), 600); break;
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
  case 'version': case '-v': case '--version': console.log(PKG.version); break;
  case 'help': case '-h': case '--help': case undefined: help(); break;
  default: console.log(c.r(`Lệnh không hợp lệ: ${cmd}`)); help(); process.exit(1);
}
