import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const exec = promisify(execFile);

/**
 * CLI bin/agyproxy.mjs — CHẠY THẬT bằng process con, nói chuyện với stub server HTTP.
 * Không đụng home thật (AGY_HOME=tmp), không cần server agyproxy thật.
 */

const ROOT = resolve(import.meta.dirname, '..');
const BIN = resolve(ROOT, 'bin/agyproxy.mjs');
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-cli-'));

let server: Server;
let port = 0;
/** Request cuối stub nhận được — để khẳng định CLI gọi đúng method + path + body. */
let lastReq: { method: string; url: string; body: any } | null = null;

before(async () => {
  await new Promise<void>((done) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastReq = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null };
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/api/metrics') {
          res.end(JSON.stringify({
            now: Date.now(), uptimeSec: 3725, rssMb: 123,
            window: {
              windowSec: 300, requests: 42, errors: 3, errorRate: 3 / 42, rps: 0.14,
              latency: { avgMs: 800, p50: 700, p95: 1500, p99: 2100 },
              totals: { requests: 999, errors: 7 },
            },
            accounts: {
              agy: { total: 10, available: 8, inflight: 1 },
              kr: { total: 5, available: 0, inflight: 0 },
            },
            breaker: {
              agy: { state: 'closed', consecutiveFails: 0 },
              kr: { state: 'open', consecutiveFails: 12 },
            },
          }));
          return;
        }
        if (req.url?.startsWith('/api/gateway/config')) {
          res.end(JSON.stringify({ ok: true, rotation: 'round-robin', changed: ['gatewayRotation'], rejected: [] }));
          return;
        }
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });
});

after(() => {
  server.close();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function run(...args: string[]) {
  return exec(process.execPath, [BIN, ...args], {
    env: { ...process.env, PORT: String(port), AGY_HOME: TMP_HOME, NO_COLOR: '1' },
    timeout: 30_000,
  });
}

test('version: in đúng phiên bản package.json', async () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const { stdout } = await run('version');
  assert.equal(stdout.trim(), pkg.version);
});

test('metrics: đọc /api/metrics, in rps + p99 + trạng thái breaker từng provider', async () => {
  const { stdout } = await run('metrics');
  assert.match(stdout, /42/, 'số request trong cửa sổ');
  assert.match(stdout, /0\.14\/s/, 'rps');
  assert.match(stdout, /p99 .*2100ms/, 'độ trễ p99');
  assert.match(stdout, /7\.1%/, 'error rate 3/42 làm tròn 1 chữ số');
  assert.match(stdout, /1h02m/, 'uptime 3725s → 1h02m');
  assert.match(stdout, /agy +8\/10 khả dụng/, 'pool agy');
  assert.match(stdout, /mạch MỞ \(12 lỗi liên tiếp\)/, 'breaker kr đang mở phải nhìn thấy ngay');
  assert.equal(lastReq!.url, '/api/metrics');
});

test('metrics --json: in nguyên văn JSON parse được', async () => {
  const { stdout } = await run('metrics', '--json');
  const j = JSON.parse(stdout);
  assert.equal(j.window.requests, 42);
  assert.equal(j.breaker.kr.state, 'open');
});

test('metrics: server không chạy → báo lỗi rõ + exit code 1', async () => {
  await assert.rejects(
    exec(process.execPath, [BIN, 'metrics'], {
      env: { ...process.env, PORT: '1', AGY_HOME: TMP_HOME, NO_COLOR: '1' }, // cổng 1 không ai nghe
      timeout: 30_000,
    }),
    (e: any) => e.code === 1 && /Không gọi được/.test(e.stdout),
  );
});

test('rotation (không tham số): hiện chiến lược hiện tại', async () => {
  const { stdout } = await run('rotation');
  assert.match(stdout, /rotation hiện tại: .*round-robin/);
  assert.equal(lastReq!.method, 'GET');
});

test('rotation smart: PATCH /api/gateway/config {rotation:"smart"}', async () => {
  const { stdout } = await run('rotation', 'smart');
  assert.match(stdout, /Đã đổi rotation → smart/);
  assert.equal(lastReq!.method, 'PATCH');
  assert.equal(lastReq!.url, '/api/gateway/config');
  assert.deepEqual(lastReq!.body, { rotation: 'smart' });
});

test('rotation sai tên: từ chối kèm danh sách hợp lệ, KHÔNG gọi server, exit 1', async () => {
  lastReq = null;
  await assert.rejects(
    run('rotation', 'bua-bai'),
    (e: any) => e.code === 1 && /không hợp lệ/.test(e.stdout) && /round-robin, full-first/.test(e.stdout),
  );
  assert.equal(lastReq, null, 'không được gửi request nào');
});

describe('daemon: PID phải là tiến trình ĐANG PHỤC VỤ', () => {
  test('readPid dò theo cổng khi PID_FILE trượt', () => {
    // Bug thật: launchd (KeepAlive) dựng lại server với PID khác PID mà `start -d`
    // spawn ra, nên PID_FILE trỏ vào tiến trình đã chết → `status` báo "đã dừng" và
    // `stop` không dừng được gì trong khi gateway vẫn nhận request.
    const src = readFileSync(new URL('../bin/agyproxy.mjs', import.meta.url), 'utf8');
    assert.match(src, /function pidOnPort\(\)/, 'phải có đường dò theo cổng');
    assert.match(src, /lsof/, 'pidOnPort dùng lsof để tìm tiến trình LISTEN');
    // readPid không được chỉ tin PID_FILE
    const body = src.slice(src.indexOf('function readPid()'), src.indexOf('function pidOnPort()'));
    assert.match(body, /pidOnPort\(\)/, 'readPid phải fallback sang pidOnPort khi file trượt');
  });

  test('start -d in ra PID đang nghe cổng, không phải PID spawn', () => {
    const src = readFileSync(new URL('../bin/agyproxy.mjs', import.meta.url), 'utf8');
    assert.match(src, /waitPortPid\(/, 'phải đợi server chiếm cổng rồi lấy PID thật');
  });

  test('serverCmd gọi thẳng node, không qua wrapper .bin/tsx', () => {
    const src = readFileSync(new URL('../bin/agyproxy.mjs', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('function serverCmd()'), src.indexOf('function serverCmd()') + 400);
    // Chỉ xét THÂN HÀM: comment phía trên có nhắc tên wrapper để giải thích lý do.
    assert.doesNotMatch(fn, /\.bin\/tsx/, 'wrapper shell tự thoát, để lại tiến trình mồ côi PID khác');
    assert.match(fn, /process\.execPath/, 'spawn thẳng node để PID khớp tiến trình phục vụ');
  });
});
