import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { store } from '../../src/store/index.js';
import { config } from '../../src/config.js';
import { pool } from '../../src/gateway/pool.js';
import { registerGatewayRoutes } from '../../src/gateway/routes.js';

let app: FastifyInstance;
let sampleEmail: string;

before(async () => {
  store.load();
  app = Fastify();
  await app.register(formbody);
  await registerGatewayRoutes(app);
  await app.ready();
  sampleEmail = pool.list('agy')[0]?.email ?? '';
});

/**
 * Header auth cho request gateway.
 *
 * KHÔNG được giả định bảng api_keys rỗng: khi có key thật trong DB (vd key của client
 * production), `resolveApiKey` chuyển sang chế độ "đã cấu hình" và request không kèm key
 * sẽ bị 401 — test sẽ đỏ vì trạng thái DB chứ không phải vì code sai.
 * Đảm bảo LUÔN có key legacy trong lúc chạy test.
 */
const TEST_KEY = 'test-legacy-key-gateway';
const savedKey = config.gateway.apiKey;
before(() => { config.gateway.apiKey = savedKey || TEST_KEY; });
after(() => { config.gateway.apiKey = savedKey; });

/**
 * Ghim `gateway.enabled` — CÙNG LÝ DO với `apiKey` ở trên, chỉ khác công tắc.
 *
 * `config.gateway.enabled` đọc từ bảng `settings` lúc import. Máy test để `agyproxy off`
 * theo phân vai (Mac test / Debian production), nên các route proxy chặn ở
 * `dialects/openai.ts` "gateway disabled → 503" TRƯỚC khi kịp validate model → test
 * khẳng định 400 sẽ nhận 503. Đây là đỏ vì trạng thái DB, không phải vì code sai.
 *
 * Thứ tự guard trong handler là ĐÚNG và không nên đổi: gateway tắt thì không nên tốn
 * công parse, và phải nhất quán với /proxy/v1/chat/completions cùng dialect Anthropic.
 * Nên cô lập ở phía test.
 */
const savedEnabled = config.gateway.enabled;
before(() => { config.gateway.enabled = true; });
after(() => { config.gateway.enabled = savedEnabled; });
const authHeaders = () => ({ authorization: `Bearer ${config.gateway.apiKey}` });

test('GET /api/gateway/models trả danh sách model', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/gateway/models' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.ok(Array.isArray(j.models) && j.models.length >= 5);
  assert.ok(j.models.some((m: any) => m.image === true), 'phải có model ảnh');
});

test('GET /proxy/v1/models đúng OpenAI shape + id CÓ prefix provider', async () => {
  // gateway thật có thể đang bật API key → gửi kèm để test không phụ thuộc cấu hình máy
  const headers = authHeaders();
  const r = await app.inject({ method: 'GET', url: '/proxy/v1/models?bare=0', headers });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.object, 'list');
  assert.ok(j.data[0].id && j.data[0].object === 'model');
  assert.ok(j.data.some((m: any) => m.id.startsWith('agy/')), 'phải có model agy/');
  assert.ok(j.data.some((m: any) => m.id.startsWith('kr/')), 'phải có model kr/');
  assert.ok(j.data.some((m: any) => m.id === 'auto'), 'phải có combo ảo auto');
});

test('GET /api/metrics đúng shape (cửa sổ + pool + uptime)', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/metrics' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.ok(typeof j.uptimeSec === 'number');
  assert.ok(typeof j.rssMb === 'number' && j.rssMb > 0);
  for (const k of ['windowSec', 'requests', 'errors', 'errorRate', 'rps', 'totals']) {
    assert.ok(k in j.window, `thiếu window.${k}`);
  }
  assert.ok(j.accounts.agy && j.accounts.kr, 'phải có số liệu pool từng provider');
  for (const k of ['total', 'available', 'inflight']) {
    assert.ok(typeof j.accounts.agy[k] === 'number', `thiếu accounts.agy.${k}`);
  }
});

test('GET /api/gateway/accounts đúng shape', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/gateway/accounts' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.ok(Array.isArray(j.accounts));
  if (j.accounts.length) {
    const a = j.accounts[0];
    for (const k of ['email', 'enabled', 'health', 'requests', 'tokensIn', 'tokensOut', 'cooldown']) {
      assert.ok(k in a, `thiếu field ${k}`);
    }
  }
});

test('PATCH /api/gateway/config đổi rotation', async () => {
  const r = await app.inject({ method: 'PATCH', url: '/api/gateway/config', payload: { rotation: 'highest-first' } });
  assert.equal(r.statusCode, 200);
  assert.equal(config.gateway.rotation, 'highest-first');
  await app.inject({ method: 'PATCH', url: '/api/gateway/config', payload: { rotation: 'round-robin' } });
});

test('toggle account đổi enabled', async (t) => {
  if (!sampleEmail) return t.skip('không có account agy trong store');
  const before = pool.get(sampleEmail, "agy")!.enabled;
  const r = await app.inject({ method: 'POST', url: `/api/gateway/accounts/${encodeURIComponent(sampleEmail)}/toggle`, payload: { enabled: !before } });
  assert.equal(r.statusCode, 200);
  assert.equal(pool.get(sampleEmail, "agy")!.enabled, !before);
  // khôi phục
  await app.inject({ method: 'POST', url: `/api/gateway/accounts/${encodeURIComponent(sampleEmail)}/toggle`, payload: { enabled: before } });
});

test('API key: thiếu Bearer → 401, đúng Bearer → 200', async () => {
  const prev = config.gateway.apiKey;
  config.gateway.apiKey = 'secret-key';
  try {
    const bad = await app.inject({ method: 'GET', url: '/proxy/v1/models' });
    assert.equal(bad.statusCode, 401);
    const ok = await app.inject({ method: 'GET', url: '/proxy/v1/models', headers: { authorization: 'Bearer secret-key' } });
    assert.equal(ok.statusCode, 200);
  } finally {
    // Khôi phục GIÁ TRỊ CŨ, không hardcode ''. Đặt rỗng làm mọi test sau chạy ở chế độ
    // "chưa cấu hình key" — trước đây vô hại vì rỗng = bỏ auth, nhưng khi bảng api_keys
    // có key thật thì các test đó bị 401 vì trạng thái DB chứ không phải vì code sai.
    config.gateway.apiKey = prev;
  }
});

test('GET /api/gateway/usage đúng shape', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/gateway/usage?range=7d&groupBy=day' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  for (const k of ['totals', 'series', 'byModel', 'byAccount']) assert.ok(k in j, `thiếu ${k}`);
  assert.ok('requests' in j.totals && 'tokIn' in j.totals && 'accounts' in j.totals);
  assert.ok(Array.isArray(j.series) && Array.isArray(j.byModel) && Array.isArray(j.byAccount));
});

test('GET /api/gateway/quota-summary đúng shape', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/gateway/quota-summary' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  for (const k of ['fetched', 'total', 'geminiAvg', 'tiers']) assert.ok(k in j, `thiếu ${k}`);
});

test('PATCH /api/gateway/config nhận quota config', async () => {
  const r = await app.inject({ method: 'PATCH', url: '/api/gateway/config', payload: { quota: { onCall: false, intervalMin: 45 } } });
  assert.equal(r.statusCode, 200);
  assert.equal(config.gateway.quota.onCall, false);
  assert.equal(config.gateway.quota.intervalMin, 45);
  config.gateway.quota.onCall = true;
});

test('POST /proxy/v1/responses tồn tại + validate model (OmniRoute gọi đường này)', async () => {
  // trước đây 404 "Route POST:/proxy/v1/responses not found" khi cắm vào OmniRoute
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/responses', headers: authHeaders(), payload: { model: 'khong-ton-tai-xyz', input: 'hi' } });
  assert.notEqual(r.statusCode, 404, 'endpoint phải tồn tại');
  assert.equal(r.statusCode, 400);
  assert.ok(r.json().error?.message, 'lỗi đúng shape OpenAI');
});

test('GET /proxy/v1/models?bare=1 trả id TRẦN, không trùng nhau', async () => {
  const headers = authHeaders();
  const r = await app.inject({ method: 'GET', url: '/proxy/v1/models?bare=1', headers });
  assert.equal(r.statusCode, 200);
  const ids = r.json().data.map((m: any) => m.id);
  assert.ok(ids.includes('gemini-2.5-flash'), 'id agy phải trần');
  assert.ok(ids.includes('claude-sonnet-4.5'), 'id kr phải trần');
  assert.ok(ids.includes('auto-kr'), 'model auto của Kiro phải đổi tên tránh đụng combo auto');
  assert.equal(new Set(ids).size, ids.length, 'KHÔNG được có id trùng — gateway đích sẽ loạn');
});

test('GET /proxy/v1/models/:id — retrieve model (gateway trung gian gọi để xác thực)', async () => {
  const headers = authHeaders();
  // bareMode tắt trong test → phải dùng id CÓ prefix
  const ok = await app.inject({ method: 'GET', url: '/proxy/v1/models/' + encodeURIComponent('agy/gemini-2.5-flash'), headers });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().object, 'model');
  const bad = await app.inject({ method: 'GET', url: '/proxy/v1/models/khong-ton-tai-xyz', headers });
  assert.equal(bad.statusCode, 404, 'model lạ phải 404, không phải 500');
});

/**
 * `/api/cli/connect` — nguồn token cho tab CLI trên dashboard.
 *
 * Token này cho TOÀN QUYỀN điều khiển gateway, nên mặc định phải trả bản CHE. Nếu ai đó
 * lỡ bỏ `maskKey` thì token nguyên văn sẽ nằm trong mọi response, trong cache trình duyệt,
 * và trong ảnh chụp màn hình người dùng gửi đi — test này khoá lại điều đó.
 */
test('GET /api/cli/connect: mặc định CHE token, ?reveal=1 mới trả nguyên văn', async () => {
  const masked = await app.inject({ method: 'GET', url: '/api/cli/connect' });
  assert.equal(masked.statusCode, 200);
  const m = masked.json() as { token: string; masked: boolean; url: string };
  assert.equal(m.masked, true);
  assert.match(m.token, /…/, 'token mặc định phải bị che');
  assert.ok(m.url.startsWith('http'), 'phải trả URL để tool ngoài kết nối');

  const full = await app.inject({ method: 'GET', url: '/api/cli/connect?reveal=1' });
  const f = full.json() as { token: string; masked: boolean };
  assert.equal(f.masked, false);
  assert.doesNotMatch(f.token, /…/, 'reveal=1 phải trả token nguyên văn');
  assert.ok(f.token.length >= 20, `token phải đủ dài, có ${f.token.length}`);

  // Bản che phải là CHÍNH token đó bị cắt, không phải token khác.
  assert.ok(f.token.startsWith(m.token.split('…')[0]!), 'bản che và bản thật phải cùng một token');
});
