import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
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
let lastReq: { method: string; url: string; body: any; headers: Record<string, any> } | null = null;

before(async () => {
  await new Promise<void>((done) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastReq = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null, headers: req.headers as Record<string, any> };
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
    // Không ghim '127.0.0.1': nhóm test remote gọi qua `127.1` (cùng loopback nhưng CLI
    // xếp là "máy khác"), nên stub phải nghe cả dải chứ không riêng một địa chỉ.
    server.listen(0, () => {
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

/**
 * Điều khiển từ xa — thứ "tools control" cần.
 *
 * Cách kiểm: chạy CLI với AGY_HOME RIÊNG — không có state.db, đúng hoàn cảnh máy khác
 * (CLI không đọc trộm được token, phải lấy từ cli.json).
 *
 * Địa chỉ dùng `127.1` chứ không phải `127.0.0.1`: CLI phân loại 127.0.0.1/localhost/[::1]
 * là "cùng máy", nên gọi qua chúng sẽ đi nhánh local và test không kiểm được gì.
 */
describe('điều khiển từ xa qua CLI', () => {
  const REMOTE_HOME = mkdtempSync(resolve(tmpdir(), 'agy-cli-remote-'));
  after(() => rmSync(REMOTE_HOME, { recursive: true, force: true }));

  /** Chạy CLI như đang ở MÁY KHÁC: home riêng, không có DB để đọc token. */
  const runRemote = (...args: string[]) =>
    exec(process.execPath, [BIN, ...args], {
      env: { ...process.env, PORT: String(port), AGY_HOME: REMOTE_HOME, NO_COLOR: '1' },
      timeout: 30_000,
    });

  // `127.1` là cách viết tắt hợp lệ của 127.0.0.1 — vẫn về loopback nên stub trả lời,
  // nhưng KHÁC chuỗi "127.0.0.1" nên CLI xếp vào nhóm "máy khác". (127.0.0.2 không dùng
  // được: Linux route nhưng macOS thì không, đã đo.)
  const remoteUrl = () => `http://127.1:${port}`;

  test('chưa có token: báo cách lấy, KHÔNG im lặng rơi về mật khẩu mặc định', async () => {
    // Rơi về '123456' rồi nhận 401 sẽ khiến người dùng đi tìm nhầm chỗ.
    const e = await runRemote('api', '/api/health', '--url', remoteUrl()).catch((x) => x);
    assert.equal(e.code, 1, 'phải exit 1');
    assert.match(e.stderr, /agyproxy token/, 'phải chỉ ra lệnh lấy token');
    assert.match(e.stderr, /agyproxy connect/, 'phải chỉ ra lệnh kết nối');
  });

  test('connect lưu cli.json với quyền 0600', async () => {
    await runRemote('connect', remoteUrl(), '--token', 'tok-test');
    const f = resolve(REMOTE_HOME, 'cli.json');
    const cfg = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(cfg.url, remoteUrl());
    assert.equal(cfg.token, 'tok-test');
    // Token cho toàn quyền điều khiển gateway — user khác trên máy không được đọc.
    assert.equal(statSync(f).mode & 0o777, 0o600, 'cli.json phải là 0600');
  });

  test('sau connect: api gọi đúng URL đã lưu, không cần --url nữa', async () => {
    lastReq = null;
    const { stdout } = await runRemote('api', '/api/health');
    assert.equal(lastReq?.url, '/api/health');
    assert.doesNotThrow(() => JSON.parse(stdout), 'stdout phải là JSON thuần để jq xử lý');
  });

  test('api truyền được method + body', async () => {
    lastReq = null;
    await runRemote('api', 'PATCH', '/api/gateway/config', '{"rotation":"smart"}');
    assert.equal(lastReq?.method, 'PATCH');
    assert.deepEqual(lastReq?.body, { rotation: 'smart' });
  });

  test('lệnh cục bộ bị CHẶN khi đang trỏ sang máy khác', async () => {
    // stop/start thao tác tiến trình trên máy đang gõ — chạy nhầm sẽ dừng sai server.
    for (const cmd of ['stop', 'logs', 'update']) {
      const e = await runRemote(cmd).catch((x) => x);
      assert.equal(e.code, 1, `${cmd} phải bị chặn`);
      assert.match(e.stderr, /chỉ chạy được trên máy chủ/, `${cmd} phải giải thích lý do`);
    }
  });

  test('--token trên dòng lệnh thắng cli.json đã lưu', async () => {
    // Thứ tự ưu tiên sai thì tool ngoài không ghi đè được cấu hình sẵn có.
    lastReq = null;
    await runRemote('api', '/api/health', '--token', 'tok-khac');
    const auth = lastReq?.headers?.authorization ?? '';
    const decoded = Buffer.from(String(auth).replace('Basic ', ''), 'base64').toString();
    assert.match(decoded, /tok-khac/, '--token phải thắng token trong cli.json');
  });

  test('routes liệt kê endpoint đọc từ src/, có --json', async () => {
    const { stdout } = await runRemote('routes', '--json');
    const list = JSON.parse(stdout);
    assert.ok(Array.isArray(list) && list.length > 50, `phải liệt kê nhiều endpoint, có ${list.length}`);
    assert.ok(list.some((r: any) => r.path === '/api/overview'), 'phải có /api/overview');
  });

  test('routes KHÔNG được bỏ sót endpoint dialect', async () => {
    /**
     * Bản trước bỏ sót đúng những endpoint quan trọng nhất — đo thật: gọi
     * `/v1/chat/completions` trả 400 (tức route CÓ thật) nhưng nó không hề xuất hiện
     * trong `routes --json`. Hai nguyên nhân:
     *   1. Regex chỉ nhận tiền tố /api, /proxy, /events
     *   2. Route dialect đăng ký qua `for (const path of [...]) app.post(path, …)`
     *      nên mẫu `.post('…')` không khớp
     * Control và agent ngoài dùng lệnh này để khám phá endpoint, nên danh sách thiếu
     * khiến họ kết luận sai là gateway không hỗ trợ chuẩn đó.
     */
    const { stdout } = await runRemote('routes', '--json');
    const paths = new Set(JSON.parse(stdout).map((r: any) => `${r.method} ${r.path}`));

    for (const p of [
      'POST /v1/chat/completions',
      'POST /v1/messages',
      'GET /v1/models',
      'POST /v1/messages/count_tokens',
      'POST /openai/v1/chat/completions',
      'POST /anthropic/v1/messages',
      'POST /proxy/v1/chat/completions',
      'POST /proxy/v1/responses',
    ]) {
      assert.ok(paths.has(p), `routes thiếu \`${p}\` — client dùng đường này tưởng gateway không hỗ trợ`);
    }
  });
});

test('help liệt kê đủ 6 lệnh điều khiển từ xa', async () => {
  // Người dùng không đọc source; `help` là chỗ duy nhất họ biết lệnh nào tồn tại.
  // Thêm lệnh mà quên help thì lệnh đó coi như không có.
  const { stdout } = await run('help');
  for (const cmd of ['token', 'connect', 'ping', 'routes', 'api', 'chat']) {
    assert.match(stdout, new RegExp(`agyproxy ${cmd}\\b`), `help thiếu lệnh \`${cmd}\``);
  }
  // Tab CLI trên dashboard là đường dễ nhất để lấy token — help phải trỏ tới.
  assert.match(stdout, /CLI Tools/, 'help phải chỉ ra tab CLI trên dashboard');
});
