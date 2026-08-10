import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Combo ở màn Chat thử / Playground.
 *
 * Hai chặn độc lập khiến người dùng KHÔNG chọn được combo trong playground:
 *   1. `/api/gateway/models` chỉ trả `allModels()` — combo nằm nguồn khác nên không có
 *      trong dropdown. Cả ba màn (Chat thử, Gọi API, So sánh model) đều thiếu.
 *   2. `/api/gateway/chat` chặn thẳng: 400 "chỉ nhận model thật, không nhận combo".
 * Sửa một cái mà quên cái kia thì UI cho chọn rồi báo lỗi — tệ hơn lúc đầu.
 *
 * Combo lại chính là thứ hay cần thử nhất: nhiều bước, sai một bước là cả chuỗi hỏng.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-chatcombo-'));
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

/** Model nào lỗi, mã bao nhiêu — để dựng ca "bước 1 trượt, bước 2 cứu". */
let failByModel = new Map<string, number>();
let calls: string[] = [];

const fakeAgy: Provider = {
  ...realAgy,
  async ensureReady(a) { return { accessToken: a.email, projectId: 'p' }; },
  sessionFresh() { return true; },
  sessionOf(a) { return { accessToken: a.email, projectId: 'p' }; },
  async generate(args: GenArgs) {
    calls.push(args.model);
    const st = failByModel.get(args.model);
    if (st) throw Object.assign(new Error(`fake ${st}`), { status: st });
    return {
      text: `tra loi tu ${args.model}`, images: [], finishReason: 'STOP',
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    } as any;
  },
} as Provider;

before(async () => {
  store.load();
  for (const n of [1, 2]) {
    store.upsertCredential({ email: `cc${n}@test.local`, target: 'agy', value: `1//cc-${n}`, updated_at: '' } as any);
  }
  config.gateway.enabled = true;
  app = Fastify();
  await app.register(formbody);
  await registerGatewayRoutes(app);
  await app.ready();
  PROVIDERS.agy = fakeAgy;

  // Combo 2 bước KHÁC BỂ: bước 1 gemini, bước 2 claude.
  await app.inject({
    method: 'POST', url: '/api/combos',
    payload: {
      id: 'thu', name: 'Combo thử', strategy: 'priority', enabled: true,
      targets: [{ model: 'agy/gemini-3-flash' }, { model: 'agy/claude-sonnet-4-6' }],
    },
  });
  // Combo TẮT — không được mời chọn.
  await app.inject({
    method: 'POST', url: '/api/combos',
    payload: {
      id: 'datat', name: 'Đã tắt', strategy: 'priority', enabled: false,
      targets: [{ model: 'agy/gemini-3-flash' }],
    },
  });
});

after(async () => {
  PROVIDERS.agy = realAgy;
  await app?.close();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  failByModel = new Map();
  for (const a of pool.list('agy')) {
    a.cooldownUntil = 0;
    a.bucketCooldown = undefined;
    a.consecutiveFails = 0;
  }
});

const chat = (payload: object) => app.inject({ method: 'POST', url: '/api/gateway/chat', payload });

describe('/api/gateway/models — nguồn của dropdown playground', () => {
  test('trả CẢ combo lẫn model, phân biệt bằng `kind`', async () => {
    const j = (await app.inject({ method: 'GET', url: '/api/gateway/models' })).json();
    const models = j.models.filter((m: any) => m.kind === 'model');
    const combos = j.models.filter((m: any) => m.kind === 'combo');
    assert.ok(models.length > 5, 'phải có model provider');
    assert.ok(combos.length >= 1, 'thiếu combo thì dropdown playground không chọn được');
    assert.ok(combos.every((c: any) => c.id.startsWith('combo/')), 'id combo phải có prefix combo/');
  });

  test('combo kèm các bước để UI hiện được nó làm gì', async () => {
    const j = (await app.inject({ method: 'GET', url: '/api/gateway/models' })).json();
    const c = j.models.find((m: any) => m.id === 'combo/thu');
    assert.deepEqual(c.steps, ['agy/gemini-3-flash', 'agy/claude-sonnet-4-6']);
    assert.equal(c.strategy, 'priority');
  });

  test('combo ĐANG TẮT không được liệt kê', async () => {
    // Gọi vào combo tắt sẽ nhận 503 — mời chọn là bẫy người dùng.
    const j = (await app.inject({ method: 'GET', url: '/api/gateway/models' })).json();
    assert.ok(!j.models.some((m: any) => m.id === 'combo/datat'), 'combo tắt lọt vào dropdown');
  });

  test('combo KHÔNG khai nhận/sinh ảnh', async () => {
    // Combo trỏ nhiều model khác nhau nên khả năng ảnh không cố định. Khai true là
    // mời người dùng gửi ảnh vào thứ có thể rơi vào model chỉ đọc text.
    const j = (await app.inject({ method: 'GET', url: '/api/gateway/models' })).json();
    const c = j.models.find((m: any) => m.id === 'combo/thu');
    assert.equal(c.imageIn, false);
    assert.equal(c.imageOut, false);
  });
});

describe('/api/gateway/chat — gọi combo', () => {
  test('combo chạy được (trước đây bị chặn 400)', async () => {
    const r = await chat({ model: 'combo/thu', content: 'hi' });
    assert.equal(r.statusCode, 200, 'combo phải gọi được từ màn Chat thử');
    const j = r.json();
    assert.equal(j.ok, true);
    assert.equal(j.model, 'combo/thu');
  });

  test('trả `resolvedModel` — bước THẬT SỰ trả lời', async () => {
    // Chỉ hiện tên combo thì không biết nó rơi vào bước nào; đó chính là thứ cần
    // biết khi thử combo.
    const j = (await chat({ model: 'combo/thu', content: 'hi' })).json();
    assert.equal(j.resolvedModel, 'agy/gemini-3-flash', 'bước 1 khoẻ thì phải dùng bước 1');
  });

  test('bước 1 lỗi → trượt sang bước 2, `steps` ghi lại vết', async () => {
    failByModel.set('gemini-3-flash', 429);
    const j = (await chat({ model: 'combo/thu', content: 'hi' })).json();
    assert.equal(j.ok, true, 'bước 2 phải cứu được');
    assert.equal(j.resolvedModel, 'agy/claude-sonnet-4-6');
    assert.equal(j.steps.length, 2, 'phải ghi cả bước trượt lẫn bước thành công');
    assert.equal(j.steps[0].ok, false);
    assert.ok(j.steps[0].error, 'bước trượt phải kèm lý do — không có thì không chẩn đoán được');
    assert.equal(j.steps[1].ok, true);
  });

  test('mọi bước lỗi → báo lỗi kèm vết đầy đủ', async () => {
    failByModel.set('gemini-3-flash', 429);
    failByModel.set('claude-sonnet-4-6', 429);
    const r = await chat({ model: 'combo/thu', content: 'hi' });
    assert.ok(r.statusCode >= 400);
    const j = r.json();
    assert.equal(j.ok, false);
    assert.equal(j.steps.length, 2, 'phải thấy đã thử hết bước nào');
    assert.ok(j.steps.every((s: any) => !s.ok));
  });

  test('lỗi NGƯỜI DÙNG (400) không trượt bước — trượt cũng vô ích', async () => {
    failByModel.set('gemini-3-flash', 400);
    const r = await chat({ model: 'combo/thu', content: 'hi' });
    assert.ok(r.statusCode >= 400);
    assert.equal(r.json().steps.length, 1, 'prompt sai thì model nào cũng sai — dừng ngay');
  });

  test('combo không tồn tại → 404 nói rõ', async () => {
    const r = await chat({ model: 'combo/khong-co', content: 'hi' });
    assert.equal(r.statusCode, 404);
    assert.match(r.json().error, /không tồn tại/);
  });

  test('combo đang tắt → 503, không phải 404', async () => {
    // Phân biệt "không có" với "có nhưng tắt" — hai cách xử lý khác nhau.
    const r = await chat({ model: 'combo/datat', content: 'hi' });
    assert.equal(r.statusCode, 503);
  });

  test('model thường vẫn chạy như cũ, không có resolvedModel', async () => {
    const j = (await chat({ model: 'agy/gemini-3-flash', content: 'hi' })).json();
    assert.equal(j.ok, true);
    assert.equal(j.model, 'agy/gemini-3-flash');
    assert.equal(j.resolvedModel, undefined, 'model đơn không cần trường này');
  });
});
