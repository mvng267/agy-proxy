import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Failover khi STREAM direct-model (không qua combo): account đầu lỗi 429/5xx TRƯỚC KHI
 * gửi byte nào → phải đổi sang account khác, client vẫn nhận 200 + nội dung đầy đủ.
 *
 * Trước đây route sseInit() eager ngay khi stream=true → headersSent=true trước cả lượt
 * gọi model đầu tiên, nên lỗi đầu tiên rơi vào nhánh "đã gửi byte → hết cứu" và 429 rò
 * thẳng ra client dù pool còn account khoẻ.
 *
 * AGY_HOME trỏ vào thư mục tạm TRƯỚC mọi import chạm dữ liệu → test tự dựng account
 * riêng, không đụng dữ liệu người dùng.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-failover-'));
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

/** Hàng đợi status lỗi: mỗi lượt gọi generateStream lấy 1 phần tử; hết queue → thành công. */
let failQueue: number[] = [];
/** Account (email) đã được gọi theo thứ tự — để khẳng định có failover thật. */
let calls: string[] = [];

const fakeAgy: Provider = {
  ...realAgy,
  // Nhét email vào accessToken để generateStream biết mình đang chạy trên account nào.
  async ensureReady(a) { return { accessToken: a.email, projectId: 'p' }; },
  sessionFresh() { return true; },
  sessionOf(a) { return { accessToken: a.email, projectId: 'p' }; },
  async *generateStream(args: GenArgs) {
    calls.push(args.session.accessToken);
    const st = failQueue.shift();
    if (st) throw Object.assign(new Error(`fake upstream ${st}`), { status: st });
    yield { delta: 'xin ' };
    yield { delta: 'chao' };
    yield { usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 }, done: true };
  },
} as Provider;

const KEY = () => (config.gateway.apiKey ? { authorization: `Bearer ${config.gateway.apiKey}` } : {});

before(async () => {
  store.load();
  for (const n of [1, 2, 3]) {
    store.upsertCredential({ email: `fo${n}@test.local`, target: 'agy', value: `1//fake-${n}`, updated_at: '' } as any);
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
  // Gỡ cooldown do 429 giả ở test trước — mỗi test bắt đầu với pool sạch.
  for (const a of pool.list('agy')) {
    a.cooldownUntil = 0;
    a.monthlyExhaustedUntil = 0;
    a.bucketCooldown = undefined;
    a.consecutiveFails = 0;
    a.liveStatus = undefined;
  }
});

/** Bóc chunk SSE OpenAI thành mảng object. */
function parseOaSse(body: string): any[] {
  const out: any[] = [];
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const p = s.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try { out.push(JSON.parse(p)); } catch { /* bỏ dòng hỏng */ }
  }
  return out;
}

const payload = { model: 'agy/gemini-3-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] };

test('stream direct-model: account đầu 429 → failover account khác, client nhận 200 + nội dung', async () => {
  failQueue = [429];
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload });
  assert.equal(r.statusCode, 200);
  assert.equal(calls.length, 2, 'phải thử đúng 2 account');
  assert.notEqual(calls[0], calls[1], 'lượt 2 phải là account KHÁC');
  const chunks = parseOaSse(r.body);
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
  assert.equal(text, 'xin chao');
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
});

test('alias /v1/chat/completions: account đầu 500 → vẫn failover khi stream', async () => {
  failQueue = [500];
  const r = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: KEY(), payload });
  assert.equal(r.statusCode, 200);
  assert.equal(calls.length, 2, 'phải thử đúng 2 account');
  const text = parseOaSse(r.body).map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
  assert.equal(text, 'xin chao');
});

test('stream: MỌI account lỗi → JSON lỗi sạch, không phải SSE 200 nửa vời', async () => {
  failQueue = [429, 429, 429];
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload });
  // 3 lần 429 đốt hết pool → NoAccountError ánh xạ 503. Điều then chốt: chưa gửi byte
  // nào thì lỗi phải là JSON có status thật, không phải stream 200 với lỗi nhét trong band.
  assert.ok([429, 503].includes(r.statusCode), `phải là 429/503, nhận ${r.statusCode}`);
  assert.match(r.headers['content-type'] ?? '', /application\/json/, 'lỗi trước byte đầu phải là JSON, không phải SSE');
});

test('stream: lỗi SAU khi đã gửi byte → không phát lại, không đổi account (giới hạn đã biết)', async () => {
  // Lượt 1: phát 1 delta rồi chết giữa chừng → đã gửi byte, không cứu được nữa.
  const dyingOnce: Provider = {
    ...fakeAgy,
    async *generateStream(args: GenArgs) {
      calls.push(args.session.accessToken);
      yield { delta: 'nua chung' };
      throw Object.assign(new Error('fake mid-stream 500'), { status: 500 });
    },
  } as Provider;
  PROVIDERS.agy = dyingOnce;
  try {
    const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload });
    assert.equal(calls.length, 1, 'đã gửi byte thì KHÔNG được thử account khác');
    // Header đã là 200/SSE — lỗi chỉ có thể báo trong band.
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /nua chung/);
  } finally {
    PROVIDERS.agy = fakeAgy;
  }
});
