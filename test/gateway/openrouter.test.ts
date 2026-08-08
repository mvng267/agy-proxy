import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { openrouterProvider, parseOrCredential, toOpenAIWire } from '../../src/gateway/providers/openrouter.js';
import { getProvider, parseModelId, allModels, PROVIDERS, PROVIDER_IDS } from '../../src/gateway/providers/index.js';
import type { ProviderAccount } from '../../src/gateway/providers/types.js';

/**
 * Provider thứ 3 (OpenAI-compatible) — chứng minh dialect pattern mở rộng được:
 * registry/parse dùng chung, generate/stream nói wire-format /chat/completions.
 * Phần mạng test với mock server HTTP THẬT (không stub fetch).
 */

// ---------------- Registry: provider mới nhập cuộc như công dân hạng nhất ----------------

test('registry: or/ và openrouter/ đều trỏ về provider mới; PROVIDER_IDS đủ 3', () => {
  assert.equal(getProvider('or'), openrouterProvider);
  assert.equal(getProvider('openrouter'), openrouterProvider);
  assert.deepEqual([...PROVIDER_IDS], ['agy', 'kr', 'or']);
  assert.equal(PROVIDERS.or.credentialTarget, 'openrouter');
});

test('parseModelId: id sau or/ được giữ nguyên, kể cả id có dấu gạch chéo', () => {
  const p = parseModelId('or/anthropic/claude-sonnet-4');
  assert.equal(p.kind, 'provider');
  assert.equal(p.provider, 'or');
  assert.equal(p.model, 'anthropic/claude-sonnet-4');
  assert.equal(p.prefixed, 'or/anthropic/claude-sonnet-4');

  const alias = parseModelId('openrouter/openrouter/auto');
  assert.equal(alias.prefixed, 'or/openrouter/auto');
});

test('allModels: model or/ có mặt với prefix đúng', () => {
  const ids = allModels().map((m) => m.prefixed);
  assert.ok(ids.includes('or/openrouter/auto'), ids.join(', '));
});

// ---------------- Credential ----------------

test('credential: nhận key trần sk-or-… và JSON {apiKey,baseUrl}; từ chối rác', () => {
  assert.deepEqual(parseOrCredential('sk-or-v1-abc'), {
    apiKey: 'sk-or-v1-abc',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  assert.deepEqual(parseOrCredential('{"apiKey":"k1","baseUrl":"http://127.0.0.1:9999/v1/"}'), {
    apiKey: 'k1',
    baseUrl: 'http://127.0.0.1:9999/v1', // dấu / cuối bị cắt
  });
  assert.equal(parseOrCredential('1//google-refresh-token'), null, 'credential agy không được nhận');
  assert.equal(parseOrCredential('{"refreshToken":"x"}'), null, 'JSON thiếu apiKey không được nhận');
  assert.equal(openrouterProvider.accepts('sk-or-v1-abc'), true);
  assert.equal(openrouterProvider.accepts('không phải'), false);
});

test('session: luôn tươi (API key không hết hạn), baseUrl lấy từ credential', async () => {
  const a = {
    provider: 'or', email: 'x@y', key: 'or:x@y', health: 'alive',
    refreshToken: 'k1', credential: '{"apiKey":"k1","baseUrl":"http://up.example/v1"}',
  } as ProviderAccount;
  assert.equal(openrouterProvider.sessionFresh(a, Date.now()), true);
  const s = await openrouterProvider.ensureReady(a);
  assert.equal(s.accessToken, 'k1');
  assert.equal(s.baseUrl, 'http://up.example/v1');
});

// ---------------- Chuyển đổi message ----------------

test('toOpenAIWire: tool result + assistant tool_calls về đúng wire-format', () => {
  const wire = toOpenAIWire([
    { role: 'user', content: 'tính 2+2' },
    {
      role: 'assistant', content: '',
      toolCalls: [{ id: 'c1', name: 'calc', input: { expr: '2+2' } }],
    },
    { role: 'tool', content: '4', toolCallId: 'c1', toolName: 'calc' },
  ]);
  assert.deepEqual(wire[0], { role: 'user', content: 'tính 2+2' });
  assert.deepEqual(wire[1], {
    role: 'assistant', content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calc', arguments: '{"expr":"2+2"}' } }],
  });
  assert.deepEqual(wire[2], { role: 'tool', tool_call_id: 'c1', content: '4' });
});

// ---------------- Mạng: mock server OpenAI-compatible ----------------

let server: Server;
let baseUrl = '';
let lastReq: { url: string; auth: string; body: any } | null = null;
/** Response kịch bản cho lượt kế: 'ok' | 'stream' | số HTTP status lỗi. */
let script: 'ok' | 'stream' | number = 'ok';

function sessionOfMock() {
  return { accessToken: 'sk-or-test', baseUrl };
}

await new Promise<void>((done) => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastReq = { url: req.url ?? '', auth: req.headers.authorization ?? '', body: raw ? JSON.parse(raw) : null };
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'openrouter/auto' }] }));
        return;
      }
      if (typeof script === 'number') {
        res.writeHead(script, { 'retry-after': '7' });
        res.end(JSON.stringify({ error: { message: 'mock fail' } }));
        return;
      }
      if (script === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunks = [
          { choices: [{ delta: { content: 'xin ' } }] },
          { choices: [{ delta: { content: 'chào' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'ping', arguments: '{"a"' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } },
        ];
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'openrouter/auto',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}/v1`;
    done();
  });
});

after(() => server.close());

test('generate: gửi đúng auth + model + generationConfig đã map khoá, đọc đúng usage', async () => {
  script = 'ok';
  const r = await openrouterProvider.generate({
    session: sessionOfMock(),
    model: 'openrouter/auto',
    messages: [{ role: 'user', content: 'ping' }],
    generationConfig: { maxOutputTokens: 100, temperature: 0.5, topP: 0.9 },
  });
  assert.equal(r.text, 'pong');
  assert.equal(r.finishReason, 'stop');
  assert.deepEqual(r.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  assert.equal(lastReq!.url, '/v1/chat/completions');
  assert.equal(lastReq!.auth, 'Bearer sk-or-test');
  assert.equal(lastReq!.body.model, 'openrouter/auto');
  // khoá kiểu Gemini phải được dịch sang khoá OpenAI
  assert.equal(lastReq!.body.max_tokens, 100);
  assert.equal(lastReq!.body.temperature, 0.5);
  assert.equal(lastReq!.body.top_p, 0.9);
  assert.ok(!('maxOutputTokens' in lastReq!.body));
});

test('generate lỗi: status + retryAfterMs (giây → ms) gắn vào error cho pool cooldown đúng', async () => {
  script = 429;
  await assert.rejects(
    openrouterProvider.generate({
      session: sessionOfMock(),
      model: 'openrouter/auto',
      messages: [{ role: 'user', content: 'ping' }],
    }),
    (e: any) => e.status === 429 && e.retryAfterMs === 7000,
  );
});

test('generateStream: delta theo thứ tự, tool_call GOM ĐỦ mẩu arguments, usage + finishReason cuối', async () => {
  script = 'stream';
  const events: any[] = [];
  for await (const ev of openrouterProvider.generateStream({
    session: sessionOfMock(),
    model: 'openrouter/auto',
    messages: [{ role: 'user', content: 'ping' }],
  })) events.push(ev);

  assert.deepEqual(events.filter((e) => e.delta).map((e) => e.delta), ['xin ', 'chào']);
  const tc = events.find((e) => e.toolCall)?.toolCall;
  assert.ok(tc, 'phải phát tool call');
  assert.equal(tc.id, 'c9');
  assert.equal(tc.name, 'ping');
  assert.deepEqual(tc.input, { a: 1 }, 'arguments đến làm 2 mẩu phải được ghép lại');
  const last = events[events.length - 1];
  assert.equal(last.done, true);
  assert.equal(last.finishReason, 'tool_calls');
  assert.deepEqual(last.usage, { promptTokens: 5, completionTokens: 7, totalTokens: 12 });
  assert.equal(lastReq!.body.stream, true);
  assert.deepEqual(lastReq!.body.stream_options, { include_usage: true });
});

test('checkToken: GET /models với Bearer — key sống trả true', async () => {
  const a = {
    provider: 'or', email: 'x@y', key: 'or:x@y', health: 'alive',
    refreshToken: 'sk-or-test', credential: JSON.stringify({ apiKey: 'sk-or-test', baseUrl }),
  } as ProviderAccount;
  assert.equal(await openrouterProvider.checkToken(a), true);
  assert.equal(lastReq!.url, '/v1/models');
});
