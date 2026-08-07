import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Vòng chạy combo (engine.runComboRequest qua HTTP): trượt bước khi shouldFallback,
 * xoay account trong từng bước, dừng đúng chỗ với lỗi người dùng.
 *
 * AGY_HOME trỏ thư mục tạm TRƯỚC mọi import chạm dữ liệu — test tự dựng account + combo
 * riêng, không đụng dữ liệu người dùng.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-combo-'));
process.env.AGY_HOME = TMP_HOME;

const { store } = await import('../../src/store/index.js');
const { config } = await import('../../src/config.js');
const { pool } = await import('../../src/gateway/pool.js');
const { PROVIDERS } = await import('../../src/gateway/providers/index.js');
const { registerGatewayRoutes } = await import('../../src/gateway/routes.js');
const Fastify = (await import('fastify')).default;
const formbody = (await import('@fastify/formbody')).default;
type FastifyInstance = import('fastify').FastifyInstance;
type GenArgs = import('../../src/gateway/providers/types.js').GenArgs;
type Provider = import('../../src/gateway/providers/types.js').Provider;

let app: FastifyInstance;
const realAgy = PROVIDERS.agy;

/** Hành vi theo MODEL: model có trong map thì ném lỗi đó, không có thì thành công. */
let failByModel: Record<string, () => Error> = {};
/** Các lượt gọi upstream `model@email` theo thứ tự — để khẳng định vòng lặp đi đúng đường. */
let calls: string[] = [];

const err = (status: number, msg = `fake upstream ${status}`) => () => Object.assign(new Error(msg), { status });

const fakeAgy: Provider = {
  ...realAgy,
  async ensureReady(a) { return { accessToken: a.email, projectId: 'p' }; },
  sessionFresh() { return true; },
  sessionOf(a) { return { accessToken: a.email, projectId: 'p' }; },
  async generate(args: GenArgs) {
    calls.push(`${args.model}@${args.session.accessToken}`);
    const f = failByModel[args.model];
    if (f) throw f();
    return {
      text: 'pong', images: [], finishReason: 'STOP',
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
    } as any;
  },
  async *generateStream(args: GenArgs) {
    calls.push(`${args.model}@${args.session.accessToken}`);
    const f = failByModel[args.model];
    if (f) throw f();
    yield { delta: 'xin ' };
    yield { delta: 'chao' };
    yield { usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 }, done: true };
  },
} as Provider;

const KEY = () => (config.gateway.apiKey ? { authorization: `Bearer ${config.gateway.apiKey}` } : {});
/** Model 2 bước ở 2 BỂ quota khác nhau (gemini vs claude) — cùng provider agy. */
const STEP1 = 'gemini-3-flash';
const STEP2 = 'claude-sonnet-4-6';

before(async () => {
  store.load();
  for (const n of [1, 2, 3]) {
    store.upsertCredential({ email: `cb${n}@test.local`, target: 'agy', value: `1//fake-${n}`, updated_at: '' } as any);
  }
  app = Fastify();
  await app.register(formbody);
  await registerGatewayRoutes(app);
  await app.ready();
  PROVIDERS.agy = fakeAgy;

  // Combo 2 bước qua đúng API người dùng dùng (validate + chuẩn hoá id).
  const r = await app.inject({
    method: 'POST', url: '/api/combos',
    payload: { id: 'cb', name: 'combo test', strategy: 'priority', targets: [{ model: `agy/${STEP1}` }, { model: `agy/${STEP2}` }] },
  });
  assert.equal(r.statusCode, 200, `tạo combo lỗi: ${r.body}`);
  const r2 = await app.inject({
    method: 'POST', url: '/api/combos',
    payload: { id: 'cb-off', name: 'tắt', strategy: 'priority', targets: [{ model: `agy/${STEP1}` }], enabled: false },
  });
  assert.equal(r2.statusCode, 200);
});

after(() => {
  PROVIDERS.agy = realAgy;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  failByModel = {};
  for (const a of pool.list('agy')) {
    a.cooldownUntil = 0;
    a.monthlyExhaustedUntil = 0;
    a.bucketCooldown = undefined;
    a.consecutiveFails = 0;
    a.liveStatus = undefined;
  }
});

const modelOf = (c: string) => c.split('@')[0]!;
const emailOf = (c: string) => c.split('@')[1]!;
const payload = (stream = false) => ({
  model: 'combo/cb', stream, messages: [{ role: 'user', content: 'hi' }],
});

test('combo non-stream: bước 1 cạn hạn mức (429 mọi account) → trượt sang bước 2, client nhận 200', async () => {
  failByModel[STEP1] = err(429);
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: payload() });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.model, 'combo/cb', 'echo model phải là tên combo');
  assert.equal(j.choices[0].message.content, 'pong');
  // Bước 1 phải xoay ĐỦ 3 account (429 = hết hạn mức → thử account kế) rồi mới trượt bước.
  const step1Calls = calls.filter((c) => modelOf(c) === STEP1);
  assert.equal(step1Calls.length, 3, `bước 1 phải thử 3 account, calls: ${calls.join(', ')}`);
  assert.equal(new Set(step1Calls.map(emailOf)).size, 3, 'ba lượt bước 1 phải là 3 account KHÁC nhau');
  // Bước 2 khác BỂ quota (claude vs gemini) → account vẫn còn hạn mức, phải gọi được.
  assert.equal(calls.filter((c) => modelOf(c) === STEP2).length, 1, 'bước 2 phải chạy đúng 1 lượt thành công');
});

test('combo stream: bước 1 lỗi trước byte đầu → bước 2 stream trọn vẹn cho client', async () => {
  failByModel[STEP1] = err(429);
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: payload(true) });
  assert.equal(r.statusCode, 200, r.body);
  assert.match(r.headers['content-type'] ?? '', /text\/event-stream/);
  const text = r.body.split('\n')
    .filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
    .map((l) => { try { return JSON.parse(l.slice(5)).choices?.[0]?.delta?.content ?? ''; } catch { return ''; } })
    .join('');
  assert.equal(text, 'xin chao');
  assert.ok(calls.some((c) => modelOf(c) === STEP2), 'bước 2 phải được gọi');
});

test('combo: prompt quá dài ở bước 1 → KHÔNG xoay account (lỗi theo model), trượt ngay sang model ngữ cảnh lớn hơn', async () => {
  failByModel[STEP1] = err(400, 'Input is too long for requested model');
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: payload() });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(calls.filter((c) => modelOf(c) === STEP1).length, 1, 'prompt quá dài thì thử thêm account chỉ tốn thời gian');
  assert.equal(calls.filter((c) => modelOf(c) === STEP2).length, 1);
});

test('combo: lỗi 400 của NGƯỜI DÙNG → dừng ngay, không đốt bước sau', async () => {
  failByModel[STEP1] = err(400, 'bad request: tham số sai');
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: payload() });
  assert.equal(r.statusCode, 400);
  assert.equal(calls.filter((c) => modelOf(c) === STEP2).length, 0, 'bước 2 KHÔNG được chạy với lỗi người dùng');
});

test('combo: mọi bước đều cạn → lỗi sạch 429/503, không phải 200 rỗng', async () => {
  failByModel[STEP1] = err(429);
  failByModel[STEP2] = err(429);
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: payload() });
  assert.ok([429, 503].includes(r.statusCode), `phải là 429/503, nhận ${r.statusCode}: ${r.body}`);
});

test('combo không tồn tại → 404, combo đang tắt → 503', async () => {
  const r1 = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: { ...payload(), model: 'combo/khong-co' } });
  assert.equal(r1.statusCode, 404);
  const r2 = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: { ...payload(), model: 'combo/cb-off' } });
  assert.equal(r2.statusCode, 503);
});

test('alias /v1/messages (Anthropic dialect) cũng chạy combo: bước 1 lỗi 429 → bước 2 trả lời', async () => {
  failByModel[STEP1] = err(429);
  const r = await app.inject({
    method: 'POST', url: '/v1/messages', headers: { ...KEY(), 'anthropic-version': '2023-06-01' },
    payload: { model: 'combo/cb', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.content?.[0]?.text, 'pong');
  assert.ok(calls.some((c) => modelOf(c) === STEP2), 'bước 2 phải được gọi');
});
