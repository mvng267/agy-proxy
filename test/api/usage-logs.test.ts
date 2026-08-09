import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Log từng request + bộ lọc + so sánh kỳ.
 *
 * Bảng `gateway_usage` đã có đủ 14 cột và ĐANG ghi đủ (endpoint, status, api_key_id,
 * request_id, stream) — chỉ chưa có đường nào phơi ra ngoài ngoài file CSV. Ba endpoint
 * mới lấp chỗ đó, và test này khoá hành vi lọc: lọc sai thì báo cáo dẫn tới kết luận sai
 * về việc account/model nào đang hỏng.
 *
 * AGY_HOME trỏ thư mục tạm TRƯỚC mọi import chạm dữ liệu — xem test/data-safety.test.ts.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-usagelogs-'));
process.env.AGY_HOME = TMP_HOME;

const { store } = await import('../../src/store/index.js');
const { config } = await import('../../src/config.js');
const { recordGatewayUsage } = await import('../../src/store/db.js');
const { registerGatewayRoutes } = await import('../../src/gateway/routes.js');
const Fastify = (await import('fastify')).default;
const formbody = (await import('@fastify/formbody')).default;
type FastifyInstance = import('fastify').FastifyInstance;

let app: FastifyInstance;
const NOW = Date.now();
const GIO = 3600_000;

before(async () => {
  store.load();
  config.gateway.enabled = true;

  // Dữ liệu mồi có chủ đích: đủ đa dạng để mỗi bộ lọc cắt ra một tập KHÁC nhau.
  // Nếu mọi dòng giống nhau thì lọc gì cũng ra cùng kết quả và test vô nghĩa.
  const mau = [
    { ts: NOW - 1 * GIO, email: 'a@t.local', model: 'agy/gemini-3-flash', ok: true, status: 200, endpoint: '/v1/messages', stream: false },
    { ts: NOW - 2 * GIO, email: 'a@t.local', model: 'agy/gemini-3-flash', ok: false, status: 429, endpoint: '/v1/messages', stream: false },
    { ts: NOW - 3 * GIO, email: 'b@t.local', model: 'agy/claude-sonnet-4-6', ok: true, status: 200, endpoint: '/v1/chat/completions', stream: true },
    { ts: NOW - 4 * GIO, email: 'b@t.local', model: 'agy/claude-sonnet-4-6', ok: false, status: 503, endpoint: '/v1/chat/completions', stream: false },
    { ts: NOW - 5 * GIO, email: 'c@t.local', model: 'kr/claude-sonnet-4.5', ok: false, status: 429, endpoint: 'chat-test', stream: false },
  ];
  for (const m of mau) {
    recordGatewayUsage({
      promptTokens: 10, completionTokens: 5, ms: 100, apiKeyId: 'legacy', requestId: `rq-${m.ts}`,
      ...m,
    } as any);
  }

  app = Fastify();
  await app.register(formbody);
  await registerGatewayRoutes(app);
  await app.ready();
});

after(async () => {
  await app?.close();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const logs = async (q = '') => {
  const r = await app.inject({ method: 'GET', url: `/api/gateway/usage/logs?range=7d${q}` });
  assert.equal(r.statusCode, 200, `logs${q} phải trả 200`);
  return r.json();
};

describe('/api/gateway/usage/logs', () => {
  test('trả từng request kèm đủ cột attribution', async () => {
    const j = await logs();
    assert.equal(j.total, 5);
    const r = j.rows[0];
    for (const k of ['ts', 'email', 'model', 'promptTokens', 'completionTokens', 'ok', 'ms', 'endpoint', 'status', 'requestId', 'stream']) {
      assert.ok(k in r, `thiếu cột ${k} — không đối chiếu được`);
    }
  });

  test('mới nhất trước — đọc log là để xem chuyện vừa xảy ra', async () => {
    const j = await logs();
    const ts = j.rows.map((r: any) => r.ts);
    assert.deepEqual(ts, [...ts].sort((a, b) => b - a), 'phải giảm dần theo thời gian');
  });

  test('phân trang phía SERVER, không phải cắt ở trình duyệt', async () => {
    const t1 = await logs('&limit=2&offset=0');
    const t2 = await logs('&limit=2&offset=2');
    assert.equal(t1.rows.length, 2);
    assert.equal(t2.rows.length, 2);
    assert.equal(t1.total, 5, 'total là TỔNG khớp bộ lọc, không phải số dòng trang này');
    assert.notEqual(t1.rows[0].ts, t2.rows[0].ts, 'hai trang không được trùng dòng');
  });

  test('lọc theo status: chỉ 429', async () => {
    const j = await logs('&status=429');
    assert.equal(j.total, 2);
    assert.ok(j.rows.every((r: any) => r.status === 429));
  });

  test('lọc theo endpoint', async () => {
    const j = await logs('&endpoint=%2Fv1%2Fmessages');
    assert.equal(j.total, 2);
    assert.ok(j.rows.every((r: any) => r.endpoint === '/v1/messages'));
  });

  test('lọc theo account và model', async () => {
    assert.equal((await logs('&email=a%40t.local')).total, 2);
    assert.equal((await logs('&model=kr%2Fclaude-sonnet-4.5')).total, 1);
  });

  test('lọc ok=false lấy ĐÚNG các lỗi, ok=true lấy thành công', async () => {
    // Ba trạng thái: lọc true, lọc false, không lọc. Đọc bằng `=== "true"` thì
    // 'false' và thiếu tham số gộp làm một — đây là chỗ dễ sai nhất.
    const loi = await logs('&ok=false');
    assert.equal(loi.total, 3, 'có 3 request lỗi trong dữ liệu mồi');
    assert.ok(loi.rows.every((r: any) => r.ok === 0));

    const tot = await logs('&ok=true');
    assert.equal(tot.total, 2);
    assert.ok(tot.rows.every((r: any) => r.ok === 1));

    assert.equal((await logs()).total, 5, 'không lọc thì lấy cả hai');
  });

  test('nhiều bộ lọc chồng nhau thì AND với nhau', async () => {
    const j = await logs('&email=a%40t.local&status=429');
    assert.equal(j.total, 1, 'a@t.local có 2 request nhưng chỉ 1 cái 429');
  });

  test('facets chỉ liệt kê giá trị CÓ THẬT, kèm số lần', async () => {
    // Mục đích: dropdown không mời người dùng lọc theo mã lỗi không tồn tại.
    const j = await logs();
    const st = new Map(j.facets.statuses.map((x: any) => [x.value, x.n]));
    assert.equal(st.get(429), 2);
    assert.equal(st.get(200), 2);
    assert.equal(st.get(503), 1);
    assert.ok(!st.has(418), 'không được liệt kê mã chưa từng xuất hiện');

    const ep = j.facets.endpoints.map((x: any) => x.value);
    assert.ok(ep.includes('/v1/messages') && ep.includes('chat-test'));
  });
});

describe('/api/gateway/usage/compare', () => {
  test('so kỳ này với kỳ trước cùng độ dài', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/gateway/usage/compare?range=7d' });
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.equal(j.current.requests, 5, 'kỳ này có 5 request');
    assert.equal(j.previous.requests, 0, 'kỳ trước chưa có dữ liệu');
    assert.equal(j.changePct.requests, 100, 'từ 0 lên 5 quy ước là +100%');
    assert.equal(j.period.previousTo, j.period.from, 'kỳ trước phải liền kề, không chồng lấn');
    assert.equal(
      j.period.to - j.period.from,
      j.period.previousTo - j.period.previousFrom,
      'hai kỳ phải cùng độ dài, nếu không so sánh vô nghĩa',
    );
  });

  test('bộ lọc áp cho CẢ HAI kỳ', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/gateway/usage/compare?range=7d&status=429' });
    const j = r.json();
    assert.equal(j.current.requests, 2, 'lọc phải áp vào kỳ hiện tại');
  });
});
