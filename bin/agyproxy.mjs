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
import { homedir } from 'node:os';

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

const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[90m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

function readPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  if (!pid) return null;
  try { process.kill(pid, 0); return pid; } catch { unlinkSync(PID_FILE); return null; }
}

function tsxBin() {
  const local = resolve(ROOT, 'node_modules/.bin/tsx');
  return existsSync(local) ? local : 'tsx';
}

async function httpJson(url, opts = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'agyproxy-cli', accept: 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- commands ----------
function start(detached) {
  const running = readPid();
  if (running) { console.log(c.y(`Đang chạy sẵn (PID ${running}) · http://localhost:${PORT}`)); return; }
  if (!detached) {
    console.log(c.d(`agyproxy v${PKG.version} · data: ${HOME}`));
    const p = spawn(tsxBin(), [ENTRY], { stdio: 'inherit', env: process.env, cwd: ROOT });
    p.on('exit', (code) => process.exit(code ?? 0));
    return;
  }
  const out = openSync(LOG_FILE, 'a');
  const p = spawn(tsxBin(), [ENTRY], { detached: true, stdio: ['ignore', out, out], env: process.env, cwd: ROOT });
  p.unref();
  writeFileSync(PID_FILE, String(p.pid));
  console.log(c.g('✓ Đã chạy nền') + ` · PID ${p.pid} · http://localhost:${PORT}`);
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
    const raw = await fetch(`https://raw.githubusercontent.com/${REPO}/main/package.json`, { signal: AbortSignal.timeout(15000) });
    if (!raw.ok) throw new Error(`HTTP ${raw.status}`);
    remote = JSON.parse(await raw.text());
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
  case 'version': case '-v': case '--version': console.log(PKG.version); break;
  case 'help': case '-h': case '--help': case undefined: help(); break;
  default: console.log(c.r(`Lệnh không hợp lệ: ${cmd}`)); help(); process.exit(1);
}
