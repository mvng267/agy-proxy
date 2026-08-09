import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { store } from '../../src/store/index.js';
import { config } from '../../src/config.js';
import { registerGatewayRoutes } from '../../src/gateway/routes.js';

/**
 * Alias prefix + hai endpoint từng THỦNG AUTH.
 *
 * Vì sao cần: client mỗi loại tự nối path theo kiểu riêng — Claude Code đặt
 * ANTHROPIC_BASE_URL không kèm `/v1` rồi nối `/v1/messages`; Aider/Cursor đặt
 * base_url `…/v1` rồi nối `/chat/completions`; Hermes trỏ vào `/proxy/v1` nhưng nói
 * giọng Anthropic. Nên cùng một handler được đăng ký dưới 4 prefix. Các alias dùng
 * CHUNG closure nên rủi ro logic thấp, nhưng xoá hay gõ sai một dòng path thì không
 * test nào phát hiện — client tương ứng chết im lặng.
 *
 * Hai endpoint dưới đây từng trả 200 KHÔNG CẦN KEY (đo bằng curl), vì handler không gọi
 * hàm auth nào, cộng với `auth.ts` miễn Basic auth cho mọi path `/v1/`:
 *   - GET  /v1/models              (dialects/openai.ts:129-131)
 *   - POST /v1/messages/count_tokens  (dialects/anthropic.ts:256-257)
 * Cả hai đã vá nhưng KHÔNG có test hồi quy. Đây là lưới đó.
 */

const ROOT = resolve(import.meta.dirname, '../..');

let app: FastifyInstance;

const TEST_KEY = 'test-legacy-key-alias';
const savedKey = config.gateway.apiKey;
const savedEnabled = config.gateway.enabled;

before(async () => {
  store.load();
  // Cùng lý do với test/api/gateway.test.ts: bảng api_keys có key thật thì
  // resolveApiKey chuyển sang chế độ "đã cấu hình"; và máy test để gateway off.
  config.gateway.apiKey = savedKey || TEST_KEY;
  config.gateway.enabled = true;
  app = Fastify();
  await app.register(formbody);
  await registerGatewayRoutes(app);
  await app.ready();
});

after(async () => {
  config.gateway.apiKey = savedKey;
  config.gateway.enabled = savedEnabled;
  await app?.close();
});

const bearer = () => ({ authorization: `Bearer ${config.gateway.apiKey}` });

describe('alias prefix — mỗi client nối path một kiểu', () => {
  // Bảng này LÀ đặc tả. Thêm prefix mới thì thêm dòng vào đây.
  const CHAT = ['/v1/chat/completions', '/proxy/v1/chat/completions', '/openai/v1/chat/completions'];
  const MESSAGES = ['/v1/messages', '/proxy/v1/messages', '/anthropic/v1/messages'];
  const MODELS = ['/v1/models', '/proxy/v1/models', '/openai/v1/models', '/anthropic/v1/models'];

  for (const path of CHAT) {
    test(`POST ${path} tồn tại và validate body`, async () => {
      const r = await app.inject({ method: 'POST', url: path, headers: bearer(), payload: {} });
      // 400 = route có thật và đã đọc tới body. 404 = alias biến mất.
      assert.notEqual(r.statusCode, 404, `${path} không còn được đăng ký — client dùng prefix này sẽ chết`);
      assert.equal(r.statusCode, 400, `${path} phải từ chối body rỗng bằng 400`);
    });
  }

  for (const path of MESSAGES) {
    test(`POST ${path} tồn tại và validate body`, async () => {
      const r = await app.inject({ method: 'POST', url: path, headers: bearer(), payload: {} });
      assert.notEqual(r.statusCode, 404, `${path} không còn được đăng ký — Claude Code sẽ chết`);
      assert.equal(r.statusCode, 400, `${path} phải từ chối body rỗng bằng 400`);
    });
  }

  for (const path of MODELS) {
    test(`GET ${path} trả danh sách model`, async () => {
      const r = await app.inject({ method: 'GET', url: path, headers: bearer() });
      assert.equal(r.statusCode, 200, `${path} phải trả 200`);
      const j = r.json();
      const list = j.data ?? j.models ?? [];
      assert.ok(Array.isArray(list) && list.length > 0, `${path} phải có model`);
    });
  }
});

describe('auth — hai endpoint từng thủng', () => {
  test('GET /v1/models KHÔNG key → 401 (từng trả 200)', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(
      r.statusCode,
      401,
      'alias /v1/models phải đòi key. Nó từng trả 200 vì handler không gọi hàm auth nào ' +
        'và auth.ts miễn Basic auth cho mọi path /v1/ — danh sách model rò ra ngoài.',
    );
  });

  test('GET /v1/models CÓ key → 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/models', headers: bearer() });
    assert.equal(r.statusCode, 200);
  });

  test('prefix /openai/ KHÔNG bị hook auth dashboard chặn', async () => {
    /**
     * Bug thật: `auth.ts` miễn Basic auth cho `/proxy/v1`, `/v1/`, `/anthropic/` nhưng
     * THIẾU `/openai/`. Dialect có đăng ký route, nhưng request kèm API key hợp lệ vẫn
     * nhận 401 vì bị hook chặn trước khi tới handler.
     * Đo thật: /v1/models trả 200 còn /openai/v1/models trả 401 với CÙNG một key.
     *
     * Test này chạy qua app.inject nên không đi qua hook đó — giá trị của nó là khoá
     * bảng tiền tố. Xem test 'bảng tiền tố miễn auth' bên dưới.
     */
    const r = await app.inject({ method: 'GET', url: '/openai/v1/models', headers: bearer() });
    assert.equal(r.statusCode, 200, '/openai/v1/models phải phục vụ được bằng API key');
  });

  test('bảng tiền tố miễn auth dashboard phải đủ 4 loại client', async () => {
    // Đây mới là chỗ bug nằm. Đọc thẳng mã nguồn vì hook chạy ở tầng server thật,
    // app.inject trong test không đi qua nó.
    const src = readFileSync(resolve(ROOT, 'src/auth.ts'), 'utf8');
    for (const p of ['/proxy/v1', '/v1/', '/anthropic/', '/openai/']) {
      assert.match(
        src,
        new RegExp(`startsWith\\('${p.replace(/\//g, '\\/')}'\\)`),
        `auth.ts thiếu tiền tố '${p}' → client dùng prefix này nhận 401 dù key hợp lệ`,
      );
    }
  });

  test('POST /v1/messages/count_tokens KHÔNG key → 401 (từng mở hoàn toàn)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      payload: { model: 'agy/gemini-2.5-flash', messages: [{ role: 'user', content: 'xin chào' }] },
    });
    assert.equal(r.statusCode, 401, 'count_tokens phải đòi key — cùng lỗ hổng với /v1/models');
  });
});

describe('count_tokens — chưa có test nào chạm tới', () => {
  const body = (content: string) => ({
    model: 'agy/gemini-2.5-flash',
    messages: [{ role: 'user', content }],
  });

  test('trả input_tokens là số dương', async () => {
    const r = await app.inject({
      method: 'POST', url: '/v1/messages/count_tokens', headers: bearer(),
      payload: body('xin chào, đây là một câu tiếng Việt'),
    });
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.equal(typeof j.input_tokens, 'number', 'shape Anthropic đòi trường input_tokens');
    assert.ok(j.input_tokens > 0, 'nội dung không rỗng thì token phải > 0');
  });

  test('nội dung dài hơn → token nhiều hơn', async () => {
    const ngan = await app.inject({
      method: 'POST', url: '/v1/messages/count_tokens', headers: bearer(), payload: body('a'),
    });
    const dai = await app.inject({
      method: 'POST', url: '/v1/messages/count_tokens', headers: bearer(), payload: body('a'.repeat(4000)),
    });
    assert.ok(
      dai.json().input_tokens > ngan.json().input_tokens,
      'ước lượng phải tỉ lệ với độ dài — nếu bằng nhau là hàm đếm hỏng',
    );
  });

  test('dùng được qua cả 3 prefix', async () => {
    for (const p of ['/v1', '/proxy/v1', '/anthropic/v1']) {
      const r = await app.inject({
        method: 'POST', url: `${p}/messages/count_tokens`, headers: bearer(), payload: body('xin chào'),
      });
      assert.equal(r.statusCode, 200, `${p}/messages/count_tokens phải hoạt động`);
    }
  });
});

describe('content-negotiation trên route models', () => {
  // Cùng một path phục vụ hai giọng: có x-api-key/anthropic-version thì trả schema
  // Anthropic (type/display_name/has_more), không thì trả schema OpenAI (object/owned_by).
  test('x-api-key → schema Anthropic', async () => {
    const r = await app.inject({
      method: 'GET', url: '/v1/models',
      headers: { 'x-api-key': String(config.gateway.apiKey) },
    });
    assert.equal(r.statusCode, 200);
    const j = r.json();
    assert.ok('has_more' in j, 'client Anthropic đòi trường has_more');
    assert.equal(j.data?.[0]?.type, 'model', 'mỗi phần tử phải có type: "model"');
    assert.ok('display_name' in (j.data?.[0] ?? {}), 'Anthropic dùng display_name, không phải label');
  });

  test('Bearer → schema OpenAI', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/models', headers: bearer() });
    const j = r.json();
    assert.equal(j.object, 'list', 'client OpenAI đòi object: "list"');
    assert.equal(j.data?.[0]?.object, 'model');
    assert.ok('owned_by' in (j.data?.[0] ?? {}), 'OpenAI dùng owned_by');
  });
});
