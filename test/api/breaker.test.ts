import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Circuit breaker end-to-end: provider sập hàng loạt → mạch mở, request kế fail-fast
 * KHÔNG gọi upstream; hết openMs → thăm dò; thành công → đóng lại.
 *
 * AGY_HOME + ngưỡng breaker đặt TRƯỚC mọi import (singleton đọc env lúc import).
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-breaker-'));
process.env.AGY_HOME = TMP_HOME;
process.env.AGY_BREAKER_THRESHOLD = '3';
process.env.AGY_BREAKER_OPEN_SEC = '30';

const { store } = await import('../../src/store/index.js');
const { config } = await import('../../src/config.js');
const { pool } = await import('../../src/gateway/pool.js');
const { PROVIDERS } = await import('../../src/gateway/providers/index.js');
const { providerBreaker } = await import('../../src/gateway/breaker.js');
const { registerGatewayRoutes } = await import('../../src/gateway/routes.js');
const Fastify = (await import('fastify')).default;
const formbody = (await import('@fastify/formbody')).default;
type FastifyInstance = import('fastify').FastifyInstance;
type GenArgs = import('../../src/gateway/providers/types.js').GenArgs;
type Provider = import('../../src/gateway/providers/types.js').Provider;

let app: FastifyInstance;
const realAgy = PROVIDERS.agy;

/** Hàng đợi status lỗi: mỗi lượt gọi upstream lấy 1 phần tử; hết queue → thành công. */
let failQueue: number[] = [];
let calls: string[] = [];

const fakeAgy: Provider = {
  ...realAgy,
  async ensureReady(a) { return { accessToken: a.email, projectId: 'p' }; },
  sessionFresh() { return true; },
  sessionOf(a) { return { accessToken: a.email, projectId: 'p' }; },
  async generate(args: GenArgs) {
    calls.push(args.session.accessToken);
    const st = failQueue.shift();
    if (st) throw Object.assign(new Error(`fake upstream ${st}`), { status: st });
    return {
      text: 'pong', images: [], toolCalls: [], finishReason: 'STOP', model: 'm',
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
    } as any;
  },
} as Provider;

const KEY = () => (config.gateway.apiKey ? { authorization: `Bearer ${config.gateway.apiKey}` } : {});
const payload = { model: 'agy/gemini-3-flash', stream: false, messages: [{ role: 'user', content: 'hi' }] };
const fire = () => app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload });

before(async () => {
  store.load();
  for (const n of [1, 2, 3, 4]) {
    store.upsertCredential({ email: `br${n}@test.local`, target: 'agy', value: `1//fake-${n}`, updated_at: '' } as any);
  }
  app = Fastify();
  await app.register(formbody);
  await registerGatewayRoutes(app);
  await app.ready();
  PROVIDERS.agy = fakeAgy;
});

after(() => {
  PROVIDERS.agy = realAgy;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  failQueue = [];
  providerBreaker.reset();
  for (const a of pool.list('agy')) {
    a.cooldownUntil = 0;
    a.monthlyExhaustedUntil = 0;
    a.bucketCooldown = undefined;
    a.consecutiveFails = 0;
    a.liveStatus = undefined;
    a.health = 'alive';
  }
});

test('3 lỗi 500 liên tiếp → mạch MỞ ngay trong request, request kế fail-fast không gọi upstream', async () => {
  failQueue = [500, 500, 500];
  const r1 = await fire();
  assert.equal(r1.statusCode, 502, r1.body);
  assert.equal(calls.length, 3, 'request đầu vẫn failover đủ 3 account');
  assert.equal(providerBreaker.state('agy'), 'open');

  const r2 = await fire();
  assert.ok(r2.statusCode >= 500, r2.body);
  assert.equal(calls.length, 3, 'mạch mở → KHÔNG thêm lượt gọi upstream nào');
  const msg = r2.json().error?.message ?? '';
  assert.match(msg, /circuit breaker/i, `lỗi phải nói rõ vì sao bị chặn: ${r2.body}`);
});

test('lỗi quota (429) KHÔNG nuôi breaker — mạch vẫn đóng', async () => {
  failQueue = [429, 429, 429, 429];
  const r = await fire();
  // 4 account đều 429 → hết account (quota chỉ tăng skips, không tăng tries)
  assert.ok(r.statusCode >= 500, r.body);
  assert.equal(providerBreaker.state('agy'), 'closed', '429 là chuyện từng account, không phải provider sập');
});

test('hết openMs → thăm dò; thành công → mạch ĐÓNG, phục vụ bình thường', async (t) => {
  failQueue = [500, 500, 500];
  await fire();
  assert.equal(providerBreaker.state('agy'), 'open');

  // Tua thời gian: giả lập đã qua openMs bằng mock Date.now (không sleep 30s thật)
  const realNow = Date.now;
  const t0 = realNow();
  Date.now = () => t0 + 31_000;
  t.after(() => { Date.now = realNow; });

  assert.equal(providerBreaker.state('agy'), 'half-open');
  const r = await fire(); // failQueue rỗng → upstream thành công
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().choices[0].message.content, 'pong');
  assert.equal(providerBreaker.state('agy'), 'closed', 'thăm dò ok phải đóng mạch');
});

test('hết openMs → thăm dò lỗi → mạch MỞ LẠI nguyên chu kỳ', async (t) => {
  failQueue = [500, 500, 500];
  await fire();

  const realNow = Date.now;
  const t0 = realNow();
  let offset = 31_000;
  Date.now = () => t0 + offset;
  t.after(() => { Date.now = realNow; });

  failQueue = [500];
  const before = 3;
  const r = await fire(); // thăm dò: account đầu 500 → fail-fast mở lại (không thử account 2)
  assert.ok(r.statusCode >= 500, r.body);
  assert.equal(calls.length, before + 1, 'thăm dò chỉ tốn đúng 1 lượt gọi');
  assert.equal(providerBreaker.state('agy'), 'open');

  offset = 31_000 + 29_000; // mới qua 29s của chu kỳ mới → vẫn chặn
  const r2 = await fire();
  assert.equal(calls.length, before + 1, 'vẫn trong openMs mới → không gọi upstream');
  assert.ok(r2.statusCode >= 500);
});
