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
