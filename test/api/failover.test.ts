import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Failover end-to-end NON-STREAM (direct-model) + dialect Anthropic — bổ sung cho
 * stream-failover.test.ts (vốn chỉ phủ stream OpenAI-path).
 *
 * AGY_HOME trỏ thư mục tạm TRƯỚC mọi import chạm dữ liệu.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-failover2-'));
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

/** Hàng đợi status lỗi: mỗi lượt gọi upstream lấy 1 phần tử; hết queue → thành công. */
let failQueue: number[] = [];
/** Account (email) đã được gọi theo thứ tự — để khẳng định có failover thật. */
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
      text: 'pong', images: [], finishReason: 'STOP',
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
    } as any;
  },
  async *generateStream(args: GenArgs) {
    calls.push(args.session.accessToken);
    const st = failQueue.shift();
    if (st) throw Object.assign(new Error(`fake upstream ${st}`), { status: st });
    yield { delta: 'xin ' };
    yield { delta: 'chao' };
    yield { usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 }, done: true };
  },
} as Provider;

const KEY = () => (config.gateway.apiKey ? { authorization: `Bearer ${config.gateway.apiKey}` } : {});

before(async () => {
  store.load();
  for (const n of [1, 2, 3]) {
    store.upsertCredential({ email: `nf${n}@test.local`, target: 'agy', value: `1//fake-${n}`, updated_at: '' } as any);
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
  for (const a of pool.list('agy')) {
    a.cooldownUntil = 0;
    a.monthlyExhaustedUntil = 0;
    a.bucketCooldown = undefined;
    a.consecutiveFails = 0;
    a.liveStatus = undefined;
  }
});

const oaPayload = { model: 'agy/gemini-3-flash', stream: false, messages: [{ role: 'user', content: 'hi' }] };

// ---------------- Non-stream, OpenAI dialect ----------------
test('non-stream: account đầu 500 → failover account khác, client nhận 200 + usage', async () => {
  failQueue = [500];
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: oaPayload });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(calls.length, 2, 'phải thử đúng 2 account');
  assert.notEqual(calls[0], calls[1], 'lượt 2 phải là account KHÁC');
  const j = r.json();
  assert.equal(j.choices[0].message.content, 'pong');
  assert.equal(j.choices[0].finish_reason, 'stop');
  assert.equal(j.usage.total_tokens, 4);
});

test('non-stream: account đầu 429 (hết hạn mức) → đổi account, không rò 429 ra client', async () => {
  failQueue = [429];
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: oaPayload });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(calls.length, 2);
});

test('non-stream: MỌI account 500 → 502 đúng spec OpenAI (error.message có thật)', async () => {
  failQueue = [500, 500, 500];
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: oaPayload });
  assert.equal(r.statusCode, 502, r.body);
  const j = r.json();
  const msg = j.error?.message ?? j.error; // strict mode bật/tắt đều phải có message đọc được
  assert.ok(typeof msg === 'string' && msg.length > 0, `error.message phải có thật: ${r.body}`);
  // 3 account đều thử — maxTry=3 với lỗi 5xx
  assert.equal(calls.length, 3, 'phải thử đủ 3 account trước khi bỏ cuộc');
});

test('non-stream: request lỗi 400 trên mọi account → client nhận ĐÚNG 400, không bị dồn về 502', async () => {
  // runProviderCall vẫn thử account kế với 400 (một số 400 là lỗi theo account); combo
  // mới là tầng dừng sớm qua shouldFallback. Điều bắt buộc ở đây: status cuối giữ nguyên
  // 400 để client biết lỗi ở request của mình, không phải hạ tầng.
  failQueue = [400, 400, 400];
  const r = await app.inject({ method: 'POST', url: '/proxy/v1/chat/completions', headers: KEY(), payload: oaPayload });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(calls.length, 3, 'thử đủ 3 account rồi trả lỗi cuối');
});

// ---------------- Anthropic dialect (/v1/messages) ----------------
const antHeaders = () => ({ ...KEY(), 'anthropic-version': '2023-06-01' });
const antPayload = (stream = false) => ({
  model: 'agy/gemini-3-flash', max_tokens: 100, stream, messages: [{ role: 'user', content: 'hi' }],
});

test('anthropic non-stream: account đầu 500 → failover, trả message đúng schema', async () => {
  failQueue = [500];
  const r = await app.inject({ method: 'POST', url: '/v1/messages', headers: antHeaders(), payload: antPayload() });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(calls.length, 2);
  const j = r.json();
  assert.equal(j.type, 'message');
  assert.equal(j.content?.[0]?.text, 'pong');
});

test('anthropic stream: account đầu 429 trước byte đầu → failover, chuỗi sự kiện SSE trọn vẹn', async () => {
  failQueue = [429];
  const r = await app.inject({ method: 'POST', url: '/v1/messages', headers: antHeaders(), payload: antPayload(true) });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(calls.length, 2, 'phải đổi account sau 429');
  assert.match(r.headers['content-type'] ?? '', /text\/event-stream/);
  const events = r.body.split('\n').filter((l) => l.startsWith('event:')).map((l) => l.slice(6).trim());
  // Thứ tự Anthropic bắt buộc: message_start → block start/delta/stop → message_delta → message_stop
  assert.equal(events[0], 'message_start');
  assert.ok(events.includes('content_block_start') && events.includes('content_block_stop'));
  assert.equal(events[events.length - 1], 'message_stop');
  const text = r.body.split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => { try { const d = JSON.parse(l.slice(5)); return d.delta?.text ?? ''; } catch { return ''; } })
    .join('');
  assert.equal(text, 'xin chao');
  // Usage THẬT từ upstream (không phải ước lượng chars/4)
  assert.match(r.body, /"output_tokens":5/, 'message_delta phải mang completionTokens thật từ upstream');
});

test('anthropic stream: MỌI account lỗi trước byte đầu → JSON lỗi 429/503 sạch, không phải SSE', async () => {
  failQueue = [429, 429, 429];
  const r = await app.inject({ method: 'POST', url: '/v1/messages', headers: antHeaders(), payload: antPayload(true) });
  assert.ok([429, 503].includes(r.statusCode), `phải là 429/503, nhận ${r.statusCode}`);
  assert.match(r.headers['content-type'] ?? '', /application\/json/);
  const j = r.json();
  assert.equal(j.type, 'error');
});
