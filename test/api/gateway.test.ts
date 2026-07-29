import { test, before } from 'node:test';
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

test('GET /api/gateway/models trả danh sách model', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/gateway/models' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.ok(Array.isArray(j.models) && j.models.length >= 5);
  assert.ok(j.models.some((m: any) => m.image === true), 'phải có model ảnh');
});

test('GET /proxy/v1/models đúng OpenAI shape + id CÓ prefix provider', async () => {
  // gateway thật có thể đang bật API key → gửi kèm để test không phụ thuộc cấu hình máy
  const headers = config.gateway.apiKey ? { authorization: `Bearer ${config.gateway.apiKey}` } : {};
  const r = await app.inject({ method: 'GET', url: '/proxy/v1/models?bare=0', headers });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.object, 'list');
  assert.ok(j.data[0].id && j.data[0].object === 'model');
  assert.ok(j.data.some((m: any) => m.id.startsWith('agy/')), 'phải có model agy/');
  assert.ok(j.data.some((m: any) => m.id.startsWith('kr/')), 'phải có model kr/');
  assert.ok(j.data.some((m: any) => m.id === 'auto'), 'phải có combo ảo auto');
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
  config.gateway.apiKey = 'secret-key';
  try {
    const bad = await app.inject({ method: 'GET', url: '/proxy/v1/models' });
    assert.equal(bad.statusCode, 401);
    const ok = await app.inject({ method: 'GET', url: '/proxy/v1/models', headers: { authorization: 'Bearer secret-key' } });
    assert.equal(ok.statusCode, 200);
  } finally {
    config.gateway.apiKey = '';
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
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/responses', payload: { model: 'khong-ton-tai-xyz', input: 'hi' } });
  assert.notEqual(r.statusCode, 404, 'endpoint phải tồn tại');
  assert.equal(r.statusCode, 400);
  assert.ok(r.json().error?.message, 'lỗi đúng shape OpenAI');
});

test('GET /proxy/v1/models?bare=1 trả id TRẦN, không trùng nhau', async () => {
  const headers = config.gateway.apiKey ? { authorization: `Bearer ${config.gateway.apiKey}` } : {};
  const r = await app.inject({ method: 'GET', url: '/proxy/v1/models?bare=1', headers });
  assert.equal(r.statusCode, 200);
  const ids = r.json().data.map((m: any) => m.id);
  assert.ok(ids.includes('gemini-2.5-flash'), 'id agy phải trần');
  assert.ok(ids.includes('claude-sonnet-4.5'), 'id kr phải trần');
  assert.ok(ids.includes('auto-kr'), 'model auto của Kiro phải đổi tên tránh đụng combo auto');
  assert.equal(new Set(ids).size, ids.length, 'KHÔNG được có id trùng — gateway đích sẽ loạn');
});

test('GET /proxy/v1/models/:id — retrieve model (gateway trung gian gọi để xác thực)', async () => {
  const headers = config.gateway.apiKey ? { authorization: `Bearer ${config.gateway.apiKey}` } : {};
  const ok = await app.inject({ method: 'GET', url: '/proxy/v1/models/gemini-2.5-flash', headers });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().object, 'model');
  const bad = await app.inject({ method: 'GET', url: '/proxy/v1/models/khong-ton-tai-xyz', headers });
  assert.equal(bad.statusCode, 404, 'model lạ phải 404, không phải 500');
});
