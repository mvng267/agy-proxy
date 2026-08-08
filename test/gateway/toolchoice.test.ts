import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToolConfig } from '../../src/gateway/anthropic.js';
import { openaiToolConfig } from '../../src/gateway/openai.js';

/**
 * `tool_choice` từng có trong type AnthropicRequest mà KHÔNG NƠI NÀO ĐỌC — client
 * ép model gọi tool, gateway lặng lẽ bỏ qua, model trả text. Test này khoá hành vi lại.
 */
describe('tool_choice → toolConfig', () => {
  const mode = (x: any) => x?.functionCallingConfig?.mode;

  test('anthropic: 4 kiểu chuẩn', () => {
    assert.equal(mode(anthropicToolConfig({ tool_choice: { type: 'auto' } } as any)), 'AUTO');
    assert.equal(mode(anthropicToolConfig({ tool_choice: { type: 'any' } } as any)), 'ANY');
    assert.equal(mode(anthropicToolConfig({ tool_choice: { type: 'none' } } as any)), 'NONE');
    const t = anthropicToolConfig({ tool_choice: { type: 'tool', name: 'Bash' } } as any) as any;
    assert.equal(mode(t), 'ANY');
    assert.deepEqual(t.functionCallingConfig.allowedFunctionNames, ['Bash']);
  });

  test('anthropic: thiếu tool_choice / kiểu lạ → undefined (để upstream tự quyết)', () => {
    assert.equal(anthropicToolConfig({} as any), undefined);
    assert.equal(anthropicToolConfig({ tool_choice: {} } as any), undefined);
    assert.equal(anthropicToolConfig({ tool_choice: { type: 'weird' } } as any), undefined);
  });

  test('anthropic: type=tool nhưng thiếu name → ANY, không sinh mảng rỗng', () => {
    const t = anthropicToolConfig({ tool_choice: { type: 'tool' } } as any) as any;
    assert.equal(mode(t), 'ANY');
    assert.equal(t.functionCallingConfig.allowedFunctionNames, undefined);
  });

  test('openai: dạng chuỗi và dạng object', () => {
    assert.equal(mode(openaiToolConfig({ tool_choice: 'auto' })), 'AUTO');
    assert.equal(mode(openaiToolConfig({ tool_choice: 'none' })), 'NONE');
    assert.equal(mode(openaiToolConfig({ tool_choice: 'required' })), 'ANY');
    const t = openaiToolConfig({ tool_choice: { type: 'function', function: { name: 'get_weather' } } }) as any;
    assert.equal(mode(t), 'ANY');
    assert.deepEqual(t.functionCallingConfig.allowedFunctionNames, ['get_weather']);
  });

  test('openai: không có tool_choice → undefined', () => {
    assert.equal(openaiToolConfig({}), undefined);
    assert.equal(openaiToolConfig(undefined), undefined);
    assert.equal(openaiToolConfig({ tool_choice: { type: 'function', function: {} } }), undefined);
  });
});

describe('neutralizeBlockedPhrases — câu định danh bị Antigravity chặn', () => {
  test('câu của Claude Agent SDK được đổi tối thiểu (bỏ dấu phẩy)', async () => {
    const { neutralizeBlockedPhrases } = await import('../../src/gateway/antigravity.js');
    const inp = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
    const out = neutralizeBlockedPhrases(inp);
    assert.ok(!out.includes("agent, built"), 'phải bỏ dấu phẩy — chuỗi nguyên văn bị upstream 429');
    assert.ok(out.includes("Claude agent built on Anthropic's Claude Agent SDK"), 'nghĩa phải giữ nguyên');
  });

  test('văn bản thường đi qua nguyên vẹn', async () => {
    const { neutralizeBlockedPhrases } = await import('../../src/gateway/antigravity.js');
    for (const t of ['xin chào', 'You are a helpful assistant.', "Anthropic's Claude Agent SDK"]) {
      assert.equal(neutralizeBlockedPhrases(t), t);
    }
  });

  test('áp vào systemInstruction của request dựng ra', async () => {
    const { openaiToAntigravity } = await import('../../src/gateway/antigravity.js');
    const body: any = openaiToAntigravity('agy/gemini-2.5-flash',
      [{ role: 'system', content: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
       { role: 'user', content: 'hi' }] as any,
      { projectId: 'p' });
    const sys = JSON.stringify((body as any).request.systemInstruction);
    assert.ok(!sys.includes('agent, built'), 'chuỗi bị chặn không được rời gateway');
  });
});

describe('toGeminiSchema — các dạng JSON Schema mà Gemini không nhận', () => {
  test('type dạng mảng ["array","null"] → ARRAY + nullable', async () => {
    const { toGeminiSchema } = await import('../../src/gateway/antigravity.js');
    const g = toGeminiSchema({ type: ['array', 'null'], items: { type: 'string' } }) as any;
    assert.equal(g.type, 'ARRAY');
    assert.equal(g.nullable, true);
    assert.deepEqual(g.items, { type: 'STRING' });
  });

  test('items: true (boolean schema) → ARRAY vẫn có items fallback', async () => {
    const { toGeminiSchema } = await import('../../src/gateway/antigravity.js');
    const g = toGeminiSchema({ type: 'array', items: true }) as any;
    assert.equal(g.type, 'ARRAY');
    assert.ok(g.items, 'Gemini bắt buộc ARRAY có items — thiếu là 400 cả request');
  });

  test('items: {$ref} không giải được → vẫn có items fallback', async () => {
    const { toGeminiSchema } = await import('../../src/gateway/antigravity.js');
    const g = toGeminiSchema({ type: 'array', items: { $ref: '#/$defs/X' } }) as any;
    assert.ok(g.items);
  });

  test('cả 69 tools thật của Claude Code dựng ra không còn ARRAY mồ côi items', async () => {
    const { toolsToGemini } = await import('../../src/gateway/antigravity.js');
    const { readFileSync } = await import('node:fs');
    // Payload bắt từ Claude Code thật — chính body đã 400 trước khi vá.
    const cap = JSON.parse(readFileSync(new URL('./fixtures/claude-code-tools.json', import.meta.url), 'utf8'));
    const defs = cap.map((t: any) => ({ name: t.name, description: t.description, parameters: t.input_schema }));
    const out = toolsToGemini(defs)!;
    const bad: string[] = [];
    const walk = (o: any, path: string) => {
      if (!o || typeof o !== 'object') return;
      if (o.type === 'ARRAY' && !o.items) bad.push(path);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(out, 'tools');
    assert.deepEqual(bad, []);
  });
});

describe('isModelQuotaError — hết quota MODEL khác hết quota ACCOUNT', () => {
  test('nhận diện câu "capacity on this model" của Google', async () => {
    const { isModelQuotaError } = await import('../../src/gateway/combo.js');
    const e = Object.assign(new Error(
      'generateContent 429: You have exhausted your capacity on this model. Your quota will reset after 4h59m54s.'
    ), { status: 429 });
    assert.equal(isModelQuotaError(e), true);
  });

  test('429 quota ACCOUNT thường KHÔNG bị nhận nhầm', async () => {
    const { isModelQuotaError } = await import('../../src/gateway/combo.js');
    for (const msg of ['RESOURCE_EXHAUSTED', 'Quota exceeded for quota metric', 'MONTHLY_REQUEST_COUNT reached']) {
      const e = Object.assign(new Error(msg), { status: 429 });
      assert.equal(isModelQuotaError(e), false, `"${msg}" phải được coi là quota account → đổi account`);
    }
  });

  test('status khác 429 luôn false', async () => {
    const { isModelQuotaError } = await import('../../src/gateway/combo.js');
    const e = Object.assign(new Error('capacity on this model'), { status: 500 });
    assert.equal(isModelQuotaError(e), false);
    assert.equal(isModelQuotaError(undefined), false);
    assert.equal(isModelQuotaError(null), false);
  });

  test('combo vẫn trượt sang model kế khi gặp lỗi này', async () => {
    const { shouldFallback } = await import('../../src/gateway/combo.js');
    const e = Object.assign(new Error('You have exhausted your capacity on this model.'), { status: 429 });
    assert.equal(shouldFallback(e), true, 'phải đổi MODEL, nếu không combo đứng im');
  });
});
