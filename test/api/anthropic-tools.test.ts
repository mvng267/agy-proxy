import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Tool-use qua HTTP THẬT (/v1/messages) — thay provider bằng bản giả để kiểm đúng
 * chuỗi sự kiện SSE Anthropic. Claude Code rất khắt khe về thứ tự/index block:
 * sai một bước là treo hoặc bỏ qua tool.
 *
 * AGY_HOME trỏ vào thư mục tạm TRƯỚC mọi import chạm dữ liệu → test tự dựng
 * account riêng, luôn chạy thật (không skip) và không đụng dữ liệu người dùng.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-tooltest-'));
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
type StreamEvent = import('../../src/gateway/providers/types.js').StreamEvent;

let app: FastifyInstance;
const realAgy = PROVIDERS.agy;
const realKr = PROVIDERS.kr;

/** Bản ghi tham số provider nhận được — để khẳng định tools thực sự tới nơi. */
let seen: GenArgs | undefined;
/** Kịch bản provider giả phát ra. */
let scenario: StreamEvent[] = [];
let nonStreamResult: any;

function fakeProvider(over: Partial<Provider>): Provider {
  return {
    ...realAgy,
    async ensureReady() { return { accessToken: 'x', projectId: 'p' }; },
    sessionFresh() { return true; },
    sessionOf() { return { accessToken: 'x', projectId: 'p' }; },
    async generate(args: GenArgs) {
      seen = args;
      return nonStreamResult;
    },
    async *generateStream(args: GenArgs) {
      seen = args;
      for (const ev of scenario) yield ev;
    },
    ...over,
  } as Provider;
}

const KEY = () => (config.gateway.apiKey ? { 'x-api-key': config.gateway.apiKey } : {});

before(async () => {
  store.load();
  // Account giả trong store tạm — syncFromStore() xoá account không có trong store,
  // nên phải gieo ở store chứ không gieo thẳng vào pool.
  store.upsertCredential({ email: 'tool-agy@test.local', target: 'agy', value: '1//fake-agy-refresh', updated_at: '' } as any);
  store.upsertCredential({
    email: 'tool-kr@test.local', target: 'kiro',
    value: JSON.stringify({ refreshToken: 'fake-kr-refresh', profileArn: 'arn:test', region: 'us-east-1' }),
    updated_at: '',
  } as any);

  app = Fastify();
  await app.register(formbody);
  await registerGatewayRoutes(app);
  await app.ready();
  PROVIDERS.agy = fakeProvider({ supportsTools: true });
  // `credentialTarget` BẮT BUỘC: `fakeProvider` sao từ `realAgy` nên mặc định là 'agy'.
  // Thiếu nó thì `providerOfTarget('kiro')` trả undefined → credential kiro không vào pool
  // → "Không có account Kiro khả dụng" (503) thay vì gọi provider giả.
  PROVIDERS.kr = fakeProvider({
    id: 'kr', label: 'Kiro', supportsTools: false, credentialTarget: 'kiro',
    accepts: (v: string) => v.trim().startsWith('{'),
    parseCredential: (v: string) => { try { return JSON.parse(v); } catch { return null; } },
  } as any);
});

after(() => {
  PROVIDERS.agy = realAgy;
  PROVIDERS.kr = realKr;
  rmSync(TMP_HOME, { recursive: true, force: true });
});

/** Bóc các sự kiện SSE thành [{event, data}]. */
function parseSse(body: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  for (const block of body.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block);
    const da = /^data: (.+)$/m.exec(block);
    if (ev && da) {
      try { out.push({ event: ev[1]!, data: JSON.parse(da[1]!) }); } catch { /* bỏ dòng hỏng */ }
    }
  }
  return out;
}

test('tools của Claude Code ĐẾN được provider (không bị nuốt)', async (t) => {
  seen = undefined;
  nonStreamResult = {
    text: 'ok', images: [], toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: 'STOP', model: 'm',
  };
  const r = await app.inject({
    method: 'POST', url: '/v1/messages', headers: KEY(),
    payload: {
      model: 'agy/gemini-3-flash',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'doc file a.txt' }],
      tools: [{ name: 'Read', description: 'doc file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
    },
  });
  assert.equal(r.statusCode, 200);
  assert.ok(seen, 'provider phải được gọi');
  assert.equal(seen!.tools?.length, 1);
  assert.equal(seen!.tools![0]!.name, 'Read');
  // max_tokens phải thành generationConfig (trước đây bị bỏ quên).
  assert.equal((seen!.generationConfig as any)?.maxOutputTokens, 100);
});

test('non-stream: tool call → content có block tool_use + stop_reason tool_use', async (t) => {
  nonStreamResult = {
    text: '', images: [],
    toolCalls: [{ id: 'toolu_abc', name: 'Read', input: { path: 'a.txt' } }],
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 }, finishReason: 'tool_use', model: 'm',
  };
  const r = await app.inject({
    method: 'POST', url: '/v1/messages', headers: KEY(),
    payload: {
      model: 'agy/gemini-3-flash', max_tokens: 50,
      messages: [{ role: 'user', content: 'doc a.txt' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    },
  });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.stop_reason, 'tool_use');
  const use = j.content.find((c: any) => c.type === 'tool_use');
  assert.ok(use, 'phải có block tool_use');
  assert.equal(use.name, 'Read');
  assert.deepEqual(use.input, { path: 'a.txt' });
});

test('stream: chuỗi sự kiện tool_use ĐÚNG chuẩn Anthropic', async (t) => {
  scenario = [
    { delta: 'de toi doc file' },
    { toolCall: { id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } } },
    { usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 }, done: true },
  ];
  const r = await app.inject({
    method: 'POST', url: '/v1/messages', headers: KEY(),
    payload: {
      model: 'agy/gemini-3-flash', max_tokens: 50, stream: true,
      messages: [{ role: 'user', content: 'doc a.txt' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    },
  });
  assert.equal(r.statusCode, 200);
  const evs = parseSse(r.body);
  const names = evs.map((e) => e.event);
  assert.equal(names[0], 'message_start');
  assert.equal(names[names.length - 1], 'message_stop');

  // Block text (index 0) mở → delta → đóng, TRƯỚC khi mở block tool_use (index 1).
  const starts = evs.filter((e) => e.event === 'content_block_start');
  assert.equal(starts.length, 2, 'đúng 2 block: text + tool_use');
  assert.equal(starts[0]!.data.index, 0);
  assert.equal(starts[0]!.data.content_block.type, 'text');
  assert.equal(starts[1]!.data.index, 1);
  assert.equal(starts[1]!.data.content_block.type, 'tool_use');
  assert.equal(starts[1]!.data.content_block.name, 'Read');
  assert.equal(starts[1]!.data.content_block.id, 'toolu_1');

  // Mỗi block phải được đóng, không lẫn index.
  const stops = evs.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);
  assert.deepEqual(stops, [0, 1]);

  // Tham số tool đi bằng input_json_delta, parse lại phải ra đúng object.
  const jsonDelta = evs.find((e) => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta');
  assert.ok(jsonDelta, 'phải có input_json_delta');
  assert.equal(jsonDelta!.data.index, 1);
  assert.deepEqual(JSON.parse(jsonDelta!.data.delta.partial_json), { path: 'a.txt' });

  const md = evs.find((e) => e.event === 'message_delta');
  assert.equal(md!.data.delta.stop_reason, 'tool_use');
});

test('stream CHỈ có tool (không text) → không phát block text rỗng thừa', async (t) => {
  scenario = [
    { toolCall: { id: 'toolu_only', name: 'Bash', input: { cmd: 'ls' } } },
    { usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, done: true },
  ];
  const r = await app.inject({
    method: 'POST', url: '/v1/messages', headers: KEY(),
    payload: {
      model: 'agy/gemini-3-flash', max_tokens: 50, stream: true,
      messages: [{ role: 'user', content: 'chay ls' }],
      tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
    },
  });
  const evs = parseSse(r.body);
  const starts = evs.filter((e) => e.event === 'content_block_start');
  assert.equal(starts.length, 1, 'chỉ 1 block tool_use');
  assert.equal(starts[0]!.data.index, 0, 'tool_use phải là index 0 khi không có text');
  assert.equal(starts[0]!.data.content_block.type, 'tool_use');
});

test('stream nhiều tool call → index tăng dần, không trùng', async (t) => {
  scenario = [
    { toolCall: { id: 't1', name: 'Read', input: { path: 'a' } } },
    { toolCall: { id: 't2', name: 'Read', input: { path: 'b' } } },
    { done: true },
  ];
  const r = await app.inject({
    method: 'POST', url: '/v1/messages', headers: KEY(),
    payload: {
      model: 'agy/gemini-3-flash', max_tokens: 50, stream: true,
      messages: [{ role: 'user', content: 'doc 2 file' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    },
  });
  const evs = parseSse(r.body);
  const idx = evs.filter((e) => e.event === 'content_block_start').map((e) => e.data.index);
  assert.deepEqual(idx, [0, 1], 'hai block tool_use index khác nhau');
  const stops = evs.filter((e) => e.event === 'content_block_stop').map((e) => e.data.index);
  assert.deepEqual(stops, [0, 1]);
});

test('stream không có nội dung → vẫn đủ 1 block hợp lệ (Claude Code không treo)', async (t) => {
  scenario = [{ done: true }];
  const r = await app.inject({
    method: 'POST', url: '/v1/messages', headers: KEY(),
    payload: { model: 'agy/gemini-3-flash', max_tokens: 50, stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  const evs = parseSse(r.body);
  assert.equal(evs.filter((e) => e.event === 'content_block_start').length, 1);
  assert.equal(evs.filter((e) => e.event === 'content_block_stop').length, 1);
  assert.equal(evs[evs.length - 1]!.event, 'message_stop');
});

test('provider KHÔNG hỗ trợ tool (kr/) + có tools → 400 nói rõ lý do, không im lặng', async (t) => {
  const r = await app.inject({
    method: 'POST', url: '/v1/messages', headers: KEY(),
    payload: {
      model: 'kr/claude-sonnet-4', max_tokens: 50,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    },
  });
  assert.equal(r.statusCode, 400);
  const j = r.json();
  assert.equal(j.type, 'error');
  assert.match(j.error.message, /tool-use/i);
  assert.match(j.error.message, /agy\//, 'phải chỉ ra cách khắc phục');
});

test('kr/ KHÔNG có tools vẫn chạy bình thường (không phá luồng cũ)', async (t) => {
  /**
   * Dọn cooldown model trước khi đo.
   *
   * `Pool` là singleton dùng chung giữa MỌI file test, và `node --test` chạy chúng trong
   * cùng process. File khác (`gateway/quota.test.ts`) gây 503 "hết chỗ" ba lần → model bị
   * đánh dấu nghỉ 5 phút → test này nhận 503 thay vì 200. Chạy riêng thì pass, chạy cả bộ
   * thì hỏng — đúng kiểu lỗi khó tìm nhất.
   */
  pool.clearAllModelCooldown();
  nonStreamResult = {
    text: 'chao ban', images: [], toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, finishReason: 'STOP', model: 'm',
  };
  const r = await app.inject({
    method: 'POST', url: '/v1/messages', headers: KEY(),
    payload: { model: 'kr/claude-sonnet-4', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().content[0].text, 'chao ban');
});

// ---------- phía OpenAI (/proxy/v1) — Cline/opencode/Aider ----------

/** Bóc chunk SSE OpenAI (không có dòng `event:`). */
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

const OAKEY = () => (config.gateway.apiKey ? { authorization: `Bearer ${config.gateway.apiKey}` } : {});

test('OpenAI non-stream: toolCalls → message.tool_calls + finish_reason tool_calls', async () => {
  nonStreamResult = {
    text: '', images: [],
    toolCalls: [{ id: 'call_1', name: 'Read', input: { path: 'a.txt' } }],
    usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 }, finishReason: 'tool_use', model: 'm',
  };
  const r = await app.inject({
    method: 'POST', url: '/proxy/v1/chat/completions', headers: OAKEY(),
    payload: {
      model: 'agy/gemini-3-flash',
      messages: [{ role: 'user', content: 'doc a.txt' }],
      tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
    },
  });
  assert.equal(r.statusCode, 200);
  const c = r.json().choices[0];
  assert.equal(c.finish_reason, 'tool_calls');
  assert.equal(c.message.tool_calls[0].function.name, 'Read');
  // arguments của OpenAI là CHUỖI JSON, không phải object.
  assert.deepEqual(JSON.parse(c.message.tool_calls[0].function.arguments), { path: 'a.txt' });
});

test('OpenAI: tools kiểu function wrapper VÀ functions[] cũ đều tới provider', async () => {
  nonStreamResult = { text: 'ok', images: [], toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: 'STOP', model: 'm' };
  seen = undefined;
  await app.inject({
    method: 'POST', url: '/proxy/v1/chat/completions', headers: OAKEY(),
    payload: { model: 'agy/gemini-3-flash', messages: [{ role: 'user', content: 'hi' }], functions: [{ name: 'Legacy', parameters: { type: 'object' } }] },
  });
  assert.equal(seen!.tools?.[0]!.name, 'Legacy', 'functions[] cũ vẫn phải nhận');
});

test('OpenAI stream: NHIỀU tool call phải có index KHÁC nhau (không đè nhau)', async () => {
  scenario = [
    { toolCall: { id: 'c1', name: 'Read', input: { path: 'a' } } },
    { toolCall: { id: 'c2', name: 'Read', input: { path: 'b' } } },
    { done: true },
  ];
  const r = await app.inject({
    method: 'POST', url: '/proxy/v1/chat/completions', headers: OAKEY(),
    payload: {
      model: 'agy/gemini-3-flash', stream: true,
      messages: [{ role: 'user', content: 'doc 2 file' }],
      tools: [{ type: 'function', function: { name: 'Read', parameters: { type: 'object' } } }],
    },
  });
  const chunks = parseOaSse(r.body);
  const idx = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []).map((t: any) => t.index);
  assert.deepEqual(idx, [0, 1], 'tool thứ hai phải là index 1');
  const last = chunks[chunks.length - 1];
  assert.equal(last.choices[0].finish_reason, 'tool_calls');
});

test('OpenAI: message role tool + assistant.tool_calls được chuẩn hoá cho provider', async () => {
  nonStreamResult = { text: 'xong', images: [], toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: 'STOP', model: 'm' };
  seen = undefined;
  await app.inject({
    method: 'POST', url: '/proxy/v1/chat/completions', headers: OAKEY(),
    payload: {
      model: 'agy/gemini-3-flash',
      messages: [
        { role: 'user', content: 'doc a.txt' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'Read', content: 'noi dung' },
      ],
    },
  });
  const msgs = seen!.messages;
  const asst = msgs.find((m: any) => m.role === 'assistant')!;
  // arguments dạng chuỗi phải được parse thành object trước khi xuống Gemini.
  assert.deepEqual(asst.toolCalls?.[0]!.input, { path: 'a.txt' });
  const toolMsg = msgs.find((m: any) => m.role === 'tool')!;
  assert.equal(toolMsg.toolName, 'Read');
  assert.equal(toolMsg.content, 'noi dung');
});
