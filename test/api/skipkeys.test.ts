import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * `skipKeys` HAI MỨC + `afterCall` refresh quota theo lỗi — hai vùng 0 test.
 *
 * skipKeys phân biệt hai loại hỏng, và sự phân biệt này quyết định combo sống hay chết:
 *   - `key` trần      → account hỏng hạ tầng (5xx): tránh hẳn, mọi model
 *   - `key#bucket`    → account cạn hạn mức ĐÚNG bể đó (429/402): model bể khác vẫn dùng được
 *
 * Bug thật đã xảy ra: quota-error cũng ghi key trần, nên combo hai bước khác bể
 * (gemini → claude, cùng provider agy) chết ở bước 2 vì mọi account bị blacklist dù
 * còn nguyên hạn mức bể kia.
 *
 * afterCall: `r.ok` → refresh theo TTL; 402/429 → refresh `force=true` bỏ qua cache.
 * Comment trong code ghi rõ bản cũ `if (r.ok && …)` bỏ qua đúng ca quota lỗi — tức là
 * lúc quota vừa đổi mạnh nhất thì lại không cập nhật.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-skipkeys-'));
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

/** Lỗi bơm theo model: cho phép dựng ca "bể này cạn, bể kia còn". */
let failByModel = new Map<string, number>();
/** (email, model) đã gọi — bằng chứng account có được dùng lại ở bể khác không. */
let calls: Array<{ email: string; model: string }> = [];

const fakeAgy: Provider = {
  ...realAgy,
  async ensureReady(a) { return { accessToken: a.email, projectId: 'p' }; },
  sessionFresh() { return true; },
  sessionOf(a) { return { accessToken: a.email, projectId: 'p' }; },
  async generate(args: GenArgs) {
    calls.push({ email: args.session.accessToken, model: args.model });
    const st = failByModel.get(args.model);
    if (st) throw Object.assign(new Error(`fake ${st} cho ${args.model}`), { status: st });
    return {
      text: 'pong', images: [], finishReason: 'STOP',
      usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
    } as any;
  },
} as Provider;

const KEY = () => (config.gateway.apiKey ? { authorization: `Bearer ${config.gateway.apiKey}` } : {});

before(async () => {
  store.load();
  // 2 account là đủ và cố ý: pool nhỏ chính là điều kiện phơi bày bug — pool lớn che nó đi.
  for (const n of [1, 2]) {
    store.upsertCredential({ email: `sk${n}@test.local`, target: 'agy', value: `1//sk-${n}`, updated_at: '' } as any);
  }
  config.gateway.enabled = true;
  app = Fastify();
  await app.register(formbody);
  await registerGatewayRoutes(app);
  await app.ready();
  PROVIDERS.agy = fakeAgy;
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
    a.monthlyExhaustedUntil = 0;
    a.bucketCooldown = undefined;
    a.consecutiveFails = 0;
    a.liveStatus = undefined;
  }
});

const post = (model: string) =>
  app.inject({
    method: 'POST', url: '/v1/chat/completions', headers: KEY(),
    payload: { model, stream: false, messages: [{ role: 'user', content: 'hi' }] },
  });

describe('skipKeys hai mức', () => {
  /**
   * Đây là phép thử CHÍNH, và nó phải đi qua COMBO.
   *
   * `skipKeys` chỉ sống trong phạm vi MỘT request client. Hai request riêng lẻ mỗi cái
   * có tập rỗng, nên gọi gemini rồi gọi claude KHÔNG bao giờ phơi được bug — đã thử:
   * phá `bucketSkip` thành key trần mà kiểu test đó vẫn xanh.
   *
   * Combo hai bước khác bể trong cùng một request mới dùng chung `skipKeys` (engine.ts:308).
   * Bước 1 gemini cạn hạn mức trên cả pool → bước 2 claude phải vẫn dùng lại được chính
   * những account đó. Nếu 429 ghi key trần thì mọi account bị blacklist và bước 2 chết —
   * đúng sự cố đã xảy ra trên pool nhỏ.
   */
  test('COMBO: bể gemini cạn ở bước 1, bước 2 bể claude vẫn dùng lại được account đó', async () => {
    const combo = await app.inject({
      method: 'POST', url: '/api/combos',
      payload: {
        id: '__sk_2buoc', name: 'skipkeys 2 bể', strategy: 'priority', enabled: true,
        targets: [{ model: 'agy/gemini-3-flash' }, { model: 'agy/claude-sonnet-4-6' }],
      },
    });
    assert.ok(combo.statusCode < 400, `tạo combo hỏng: ${combo.statusCode} ${combo.body.slice(0, 120)}`);

    // Chỉ bể gemini cạn. Bể claude còn nguyên.
    failByModel.set('gemini-3-flash', 429);

    const r = await post('combo/__sk_2buoc');
    assert.equal(
      r.statusCode, 200,
      'bước 2 (bể claude) phải chạy được: account cạn bể gemini vẫn còn hạn mức bể claude. ' +
        'Đỏ ở đây = 429 đang ghi key trần, chặn oan cả account.',
    );

    const buoc2 = calls.filter((c) => c.model === 'claude-sonnet-4-6');
    assert.ok(buoc2.length > 0, 'phải có account thực sự phục vụ bước claude');

    // Bằng chứng trực tiếp: account dùng ở bước 2 CHÍNH LÀ account đã 429 ở bước 1.
    const daCan = new Set(calls.filter((c) => c.model === 'gemini-3-flash').map((c) => c.email));
    assert.ok(
      buoc2.some((c) => daCan.has(c.email)),
      'account đã 429 ở bể gemini phải được dùng lại ở bể claude — đây là điểm mấu chốt của skipKeys 2 mức',
    );
  });

  test('5xx chặn CẢ ACCOUNT: không dùng lại trong cùng request', async () => {
    // Account hỏng hạ tầng thì mọi model đều hỏng → phải xoay sang account khác,
    // và không được quay lại account đã 5xx.
    failByModel.set('gemini-3-flash', 500);
    const r = await post('agy/gemini-3-flash');
    assert.ok(r.statusCode >= 400, 'mọi account 5xx thì request phải lỗi');

    const dem = new Map<string, number>();
    for (const c of calls) dem.set(c.email, (dem.get(c.email) ?? 0) + 1);
    for (const [email, n] of dem) {
      assert.equal(n, 1, `account ${email} bị 5xx mà vẫn được pick lại ${n} lần trong cùng request`);
    }
  });

  test('429 rồi thành công: account còn sống được dùng, không bị chặn oan', async () => {
    // Chỉ bể gemini của lượt đầu lỗi; lượt sau sạch → phải có account trả 200.
    failByModel.set('gemini-3-flash', 429);
    await post('agy/gemini-3-flash');

    calls = [];
    failByModel = new Map();
    // Cooldown 429 vẫn còn trên các account, nhưng request MỚI có skipKeys mới.
    for (const a of pool.list('agy')) { a.cooldownUntil = 0; a.bucketCooldown = undefined; }
    const r = await post('agy/gemini-3-flash');
    assert.equal(r.statusCode, 200, 'request mới phải dùng lại được account sau khi hết cooldown');
  });
});

describe('afterCall — refresh quota theo kết quả', () => {
  test('lỗi 429 kích hoạt refresh quota với force (bỏ qua TTL)', async () => {
    // Bằng chứng gián tiếp nhưng chắc: provider.quota() được gọi sau lỗi 429.
    // TTL cache 10 phút → nếu không force thì lần gọi này bị bỏ qua hoàn toàn.
    let forceCalls = 0;
    const p = PROVIDERS.agy as any;
    const realQuota = p.quota;
    p.quota = async () => { forceCalls++; return undefined; };
    const savedOnCall = config.gateway.quota?.onCall;
    if (config.gateway.quota) config.gateway.quota.onCall = true;

    try {
      failByModel.set('gemini-3-flash', 429);
      await post('agy/gemini-3-flash');
      // afterCall gọi refreshQuota bất đồng bộ (fire-and-forget) → chờ microtask lắng.
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(
        forceCalls > 0,
        'lỗi 429 phải kích hoạt refresh quota — đây là lúc quota đổi mạnh nhất, ' +
          'bản cũ `if (r.ok && …)` bỏ qua đúng ca này',
      );
    } finally {
      p.quota = realQuota;
      if (config.gateway.quota) config.gateway.quota.onCall = savedOnCall!;
    }
  });

  test('quota.onCall=false thì KHÔNG refresh', async () => {
    let goi = 0;
    const p = PROVIDERS.agy as any;
    const realQuota = p.quota;
    p.quota = async () => { goi++; return undefined; };
    const savedOnCall = config.gateway.quota?.onCall;
    if (config.gateway.quota) config.gateway.quota.onCall = false;

    try {
      failByModel.set('gemini-3-flash', 429);
      await post('agy/gemini-3-flash');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(goi, 0, 'tắt onCall mà vẫn gọi upstream là tốn quota ngoài ý muốn');
    } finally {
      p.quota = realQuota;
      if (config.gateway.quota) config.gateway.quota.onCall = savedOnCall!;
    }
  });
});
