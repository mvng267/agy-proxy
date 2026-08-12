/**
 * E2E dashboard: spawn server thật (tsx src/index.ts) trên PORT riêng với AGY_HOME tạm,
 * rồi lái Chrome headless qua Playwright kiểm các flow quan trọng:
 *
 *   1. Chưa đăng nhập → / bị đẩy về /login; /api/* trả 401 JSON.
 *   2. Login sai → hiện lỗi; login đúng → vào dashboard.
 *   3. Điều hướng đủ các route — mỗi màn render không pageerror.
 *   4. Route cũ (/tokens, /add, /connections, /tools) mở ĐÚNG tab con trong hub.
 *   5. F5 tại route con (SPA fallback) vẫn trả dashboard chứ không 404.
 *
 * Chạy: npm run test:e2e (cần web/dist đã build + Chrome; tách khỏi `npm test`
 * để suite mặc định không phụ thuộc trình duyệt).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 17959;
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'e2e-test-pass';

let server: ChildProcess;
let browser: Browser;
let page: Page;
let home: string;
const pageErrors: string[] = [];

async function waitForServer(timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* chưa lên */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server không lên trong 30s');
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'agy-e2e-'));
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGY_HOME: home,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DASHBOARD_PASSWORD: PASS,
      // Health loop + omniroute không cần cho E2E; để chúng fail im lặng là được.
    },
    stdio: 'ignore',
  });
  await waitForServer();

  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL === 'bundled' ? undefined : 'chrome',
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
  // SIGTERM handler cần một nhịp để flush state trước khi mình dọn thư mục.
  await new Promise((r) => setTimeout(r, 500));
  rmSync(home, { recursive: true, force: true });
});

test('chưa đăng nhập: / chuyển về /login, /api/* trả 401 JSON', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  assert.match(page.url(), /\/login$/, 'phải bị đẩy về /login');

  const r = await fetch(`${BASE}/api/overview`);
  assert.equal(r.status, 401);
  const j = await r.json() as { error?: string };
  assert.equal(j.error, 'unauthorized');
});

/**
 * Màn đăng nhập là bàn phím passcode 6 số, kèm lối thoát "Dùng mật khẩu chữ" cho máy đang
 * đặt mật khẩu có chữ. Test dùng đường mật khẩu chữ vì `DASHBOARD_PASSWORD` của e2e
 * (`e2e-test-pass`) không phải 6 chữ số.
 */
async function loginWith(pw: string) {
  await page.getByRole('button', { name: 'Dùng mật khẩu chữ' }).click();
  await page.fill('#passText', pw);
  await page.click('#btnText');
}

test('login sai hiện lỗi, không rời trang', async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await loginWith('sai-mat-khau');
  await page.waitForSelector('#err', { state: 'visible', timeout: 5000 });
  assert.match(page.url(), /\/login$/);
});

test('login đúng vào dashboard, health badge + sidebar render', async () => {
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10_000 }),
    page.fill('#passText', PASS).then(() => page.click('#btnText')),
  ]);
  // Sidebar phải có đủ nhóm điều hướng
  for (const label of ['Dashboard', 'Tài khoản', 'Pool', 'Models', 'Combo', 'Cấu hình']) {
    assert.ok(await page.getByText(label, { exact: true }).first().isVisible(), `sidebar thiếu "${label}"`);
  }
});

test('mọi route render không pageerror', async () => {
  // `/chat` giữ lại: link cũ và bookmark của người dùng vẫn phải mở được sau khi
  // Chat thử gộp vào Playground.
  const routes = ['/', '/accounts', '/proxies', '/agy', '/models', '/combo', '/quota', '/keys', '/usage', '/metrics', '/chat', '/playground', '/gwlog', '/settings', '/scheduler', '/runs', '/pending', '/omniroute', '/security'];
  for (const r of routes) {
    pageErrors.length = 0;
    await page.goto(`${BASE}${r}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    assert.deepEqual(pageErrors, [], `route ${r} có pageerror: ${pageErrors[0] ?? ''}`);
  }
});

test('route cũ mở đúng tab con trong hub', async () => {
  const cases: Array<[string, string]> = [
    ['/tokens', 'Tokens'],
    ['/add', 'Thêm tài khoản'],
    ['/tools', 'CLI Tools'],
  ];
  for (const [path, label] of cases) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    const active = (await page.locator('[role=tab][aria-selected=true]').first().textContent() ?? '').trim();
    assert.equal(active, label, `${path} phải mở tab "${label}", đang mở "${active}"`);
  }
});

test('SPA fallback: F5 tại route con trả dashboard chứ không 404', async () => {
  const res = await page.goto(`${BASE}/agy`, { waitUntil: 'networkidle' });
  assert.equal(res?.status(), 200);
  // Root React đã mount nghĩa là index.html được trả về cho route con
  assert.ok(await page.locator('#root > *').first().isVisible(), 'app React phải mount tại /agy');
});

test('apiKey bị che mặc định, ?reveal=1 mới trả nguyên văn', async () => {
  // page.request dùng chung cookie phiên đã đăng nhập ở test trước.
  const masked = await (await page.request.get(`${BASE}/api/gateway/config`)).json() as any;
  // AGY_HOME tạm không đặt GATEWAY_API_KEY → sinh key hay rỗng đều được, miễn là
  // KHÔNG trả nguyên văn: bản che hoặc rỗng, kèm cờ apiKeyMasked.
  assert.equal(masked.apiKeyMasked, true, 'GET mặc định phải báo apiKeyMasked=true');
  if (masked.apiKey) {
    assert.match(String(masked.apiKey), /…|^•+$/, 'apiKey mặc định phải là bản che');
  }
  const full = await (await page.request.get(`${BASE}/api/gateway/config?reveal=1`)).json() as any;
  assert.equal(full.apiKeyMasked, false);
  if (full.apiKey) assert.doesNotMatch(String(full.apiKey), /…/, 'reveal=1 phải trả key thật');
});

test('PATCH config: rotation hợp lệ được ghi, giá trị rác bị từ chối KÈM lý do', async () => {
  const patch = (body: unknown) =>
    page.request.patch(`${BASE}/api/gateway/config`, { data: body }).then((r) => r.json() as Promise<any>);

  const ok = await patch({ rotation: 'smart' });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.rotation, 'smart');

  // Trước đây PATCH vứt `rejected` rồi vẫn trả ok:true — bấm nút mà không có gì đổi
  // và không ai được báo. Test này khoá hành vi mới lại.
  const bad = await patch({ rotation: 'khong-ton-tai' });
  assert.equal(bad.ok, false, 'giá trị ngoài enum phải làm ok=false');
  assert.ok(bad.rejected?.length, 'phải liệt kê khoá bị từ chối');
  assert.ok(String(bad.rejected[0].reason).includes('round-robin'), 'lý do phải kể ra các giá trị hợp lệ');

  const back = await patch({ rotation: 'round-robin' });
  assert.equal(back.config.rotation, 'round-robin');
});

test('trang Cấu hình: nút chiến lược khớp ĐÚNG enum backend', async () => {
  // Trước đây UI liệt kê random/least-used/first-available — ba giá trị backend
  // không hề có, chọn vào là bị từ chối im lặng.
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  for (const label of ['Round Robin', 'Quota cao nhất', 'Thông minh', 'Dùng cạn dần', 'Failover']) {
    assert.ok(
      await page.getByRole('button', { name: label, exact: true }).isVisible(),
      `thiếu nút chiến lược "${label}"`,
    );
  }
});
