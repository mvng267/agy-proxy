import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicToMessages,
  anthropicToolDefs,
  resultToAnthropic,
  toStopReason,
  toolResultText,
} from '../../src/gateway/anthropic.js';
import {
  openaiToAntigravity,
  antigravityToResult,
  toGeminiSchema,
  toolsToGemini,
  type GenResult,
} from '../../src/gateway/antigravity.js';

/**
 * Tool-use: Anthropic (Claude Code) ↔ nội bộ ↔ Gemini functionDeclarations.
 * Đây là vòng đời 1 lượt tool thật: model gọi tool → client chạy → gửi kết quả về.
 */

// ---------- Anthropic → nội bộ ----------

test('anthropicToolDefs: tools Anthropic → ToolDef (input_schema → parameters)', () => {
  const defs = anthropicToolDefs({
    model: 'x',
    messages: [],
    tools: [
      { name: 'Read', description: 'doc file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: '', description: 'bo qua vi thieu ten' } as any,
    ],
  });
  assert.equal(defs.length, 1);
  assert.equal(defs[0]!.name, 'Read');
  assert.equal(defs[0]!.description, 'doc file');
  assert.deepEqual(defs[0]!.parameters, { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
});

test('assistant tool_use → message có toolCalls (giữ id + input)', () => {
  const m = anthropicToMessages({
    model: 'x',
    messages: [
      { role: 'user', content: 'doc file a.txt' },
      { role: 'assistant', content: [
        { type: 'text', text: 'de toi doc' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } },
      ] },
    ],
  });
  assert.equal(m.length, 2);
  assert.equal(m[1]!.role, 'assistant');
  assert.equal(m[1]!.content, 'de toi doc');
  assert.deepEqual(m[1]!.toolCalls, [{ id: 'toolu_1', name: 'Read', input: { path: 'a.txt' } }]);
});

test('NHIỀU tool_result trong 1 message → tách thành nhiều message role tool', () => {
  const m = anthropicToMessages({
    model: 'x',
    messages: [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a1', name: 'Read', input: {} },
        { type: 'tool_use', id: 'b2', name: 'Bash', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a1', content: 'noi dung file' },
        { type: 'tool_result', tool_use_id: 'b2', content: 'ket qua lenh' },
      ] },
    ],
  });
  const tools = m.filter((x) => x.role === 'tool');
  assert.equal(tools.length, 2, 'mỗi tool_result là 1 message riêng');
  // Tên tool tra ngược từ tool_use trước đó — Gemini khớp functionResponse theo TÊN.
  assert.equal(tools[0]!.toolName, 'Read');
  assert.equal(tools[1]!.toolName, 'Bash');
  assert.equal(tools[0]!.content, 'noi dung file');
});

test('tool_result is_error → đánh dấu [error] để model biết tool hỏng', () => {
  const m = anthropicToMessages({
    model: 'x',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z', content: 'ENOENT', is_error: true }] }],
  });
  assert.match(String(m[0]!.content), /\[error\]/);
  assert.match(String(m[0]!.content), /ENOENT/);
});

test('toolResultText: string | mảng block | object', () => {
  assert.equal(toolResultText('abc'), 'abc');
  assert.equal(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(toolResultText([{ type: 'image', source: {} }]), '[image]');
  assert.equal(toolResultText(null), '');
  assert.equal(toolResultText({ k: 1 }), '{"k":1}');
});

test('tool_result kèm text → giữ cả hai, kết quả tool đứng TRƯỚC', () => {
  const m = anthropicToMessages({
    model: 'x',
    messages: [{ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a1', content: 'ket qua' },
      { type: 'text', text: 'lam tiep di' },
    ] }],
  });
  assert.equal(m[0]!.role, 'tool');
  assert.equal(m[1]!.role, 'user');
  assert.equal(m[1]!.content, 'lam tiep di');
});

// ---------- nội bộ → Gemini ----------

test('toGeminiSchema: lọc khoá lạ của JSON Schema, type in HOA', () => {
  const s = toGeminiSchema({
    type: 'object',
    $schema: 'http://json-schema.org/draft-07/schema#',
    additionalProperties: false,
    properties: { path: { type: 'string', description: 'duong dan' } },
    required: ['path'],
  })!;
  assert.equal(s.type, 'OBJECT');
  assert.equal((s as any).$schema, undefined, 'khoá lạ phải bị loại — Gemini từ chối');
  assert.equal((s as any).additionalProperties, undefined);
  assert.deepEqual((s as any).properties.path, { type: 'STRING', description: 'duong dan' });
  assert.deepEqual(s.required, ['path']);
});

test('toGeminiSchema: lồng nhau (array of object) vẫn sạch', () => {
  const s = toGeminiSchema({
    type: 'object',
    properties: { edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' } }, additionalProperties: true } } },
  })!;
  const items = (s as any).properties.edits.items;
  assert.equal(items.type, 'OBJECT');
  assert.equal(items.additionalProperties, undefined);
  assert.equal(items.properties.old.type, 'STRING');
});

test('toolsToGemini: tool không tham số vẫn có parameters OBJECT rỗng', () => {
  const t = toolsToGemini([{ name: 'ListDir' }])!;
  const d = (t[0]!.functionDeclarations as any[])[0];
  assert.equal(d.name, 'ListDir');
  assert.deepEqual(d.parameters, { type: 'OBJECT', properties: {} });
});

test('toolsToGemini: rỗng → undefined (không gửi khoá tools thừa)', () => {
  assert.equal(toolsToGemini([]), undefined);
  assert.equal(toolsToGemini(undefined), undefined);
});

test('openaiToAntigravity: tools → request.tools.functionDeclarations', () => {
  const b: any = openaiToAntigravity('gemini-3-flash', [{ role: 'user', content: 'hi' }], {
    projectId: 'p',
    tools: [{ name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  });
  assert.equal(b.request.tools.length, 1);
  assert.equal(b.request.tools[0].functionDeclarations[0].name, 'Read');
});

test('model ẢNH bỏ qua tools (image_gen không có function calling)', () => {
  const b: any = openaiToAntigravity('gemini-3.1-flash-image', [{ role: 'user', content: 'a cat' }], {
    projectId: 'p',
    tools: [{ name: 'Read' }],
  });
  assert.equal(b.request.tools, undefined);
});

test('lượt assistant có toolCalls → part functionCall; role tool → functionResponse', () => {
  const b: any = openaiToAntigravity('gemini-3-flash', [
    { role: 'user', content: 'doc a.txt' },
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'Read', input: { path: 'a.txt' } }] },
    { role: 'tool', content: 'noi dung', toolCallId: 't1', toolName: 'Read' },
  ], { projectId: 'p' });

  const [u, model, res] = b.request.contents;
  assert.equal(u.role, 'user');
  assert.equal(model.role, 'model');
  // id gửi kèm: upstream Anthropic (model claude-* qua agy) bắt buộc có.
  assert.deepEqual(model.parts[0].functionCall, { name: 'Read', args: { path: 'a.txt' }, id: 't1' });
  // Gemini quy ước functionResponse nằm ở lượt user.
  assert.equal(res.role, 'user');
  assert.deepEqual(res.parts[0].functionResponse, { name: 'Read', id: 't1', response: { result: 'noi dung' } });
});

// ---------- Gemini → nội bộ ----------

test('antigravityToResult: functionCall → toolCalls + finishReason tool_use', () => {
  const r = antigravityToResult({
    candidates: [{ content: { parts: [
      { text: 'de toi doc file' },
      { functionCall: { name: 'Read', args: { path: 'a.txt' } } },
    ] }, finishReason: 'STOP' }],
  }, 'gemini-3-flash');
  assert.equal(r.text, 'de toi doc file');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0]!.name, 'Read');
  assert.deepEqual(r.toolCalls[0]!.input, { path: 'a.txt' });
  assert.match(r.toolCalls[0]!.id, /^toolu_/, 'phải tự sinh id vì Gemini không trả');
  assert.equal(r.finishReason, 'tool_use', 'có tool call thì KHÔNG được báo stop');
});

test('antigravityToResult: id mỗi tool call là DUY NHẤT', () => {
  const r = antigravityToResult({
    candidates: [{ content: { parts: [
      { functionCall: { name: 'A', args: {} } },
      { functionCall: { name: 'B', args: {} } },
    ] } }],
  }, 'm');
  assert.notEqual(r.toolCalls[0]!.id, r.toolCalls[1]!.id);
});

test('không có tool → toolCalls rỗng, finishReason giữ nguyên', () => {
  const r = antigravityToResult({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }, 'm');
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.finishReason, 'STOP');
});

// ---------- nội bộ → Anthropic ----------

const base = (over: Partial<GenResult> = {}): GenResult => ({
  text: '', images: [], toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  finishReason: 'STOP', model: 'm', ...over,
});

test('resultToAnthropic: toolCalls → block tool_use + stop_reason tool_use', () => {
  const r: any = resultToAnthropic('claude-sonnet-4-5', base({
    text: 'dang doc',
    toolCalls: [{ id: 'toolu_x', name: 'Read', input: { path: 'a.txt' } }],
    finishReason: 'tool_use',
  }));
  assert.equal(r.stop_reason, 'tool_use');
  assert.equal(r.content[0].type, 'text');
  assert.equal(r.content[1].type, 'tool_use');
  assert.equal(r.content[1].id, 'toolu_x');
  assert.equal(r.content[1].name, 'Read');
  assert.deepEqual(r.content[1].input, { path: 'a.txt' });
});

test('chỉ gọi tool, không có text → KHÔNG chèn block text rỗng', () => {
  const r: any = resultToAnthropic('m', base({ toolCalls: [{ id: 't', name: 'Read', input: {} }] }));
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, 'tool_use');
});

test('không tool và không text → vẫn có 1 block text (content KHÔNG được rỗng)', () => {
  const r: any = resultToAnthropic('m', base());
  assert.equal(r.content.length, 1);
  assert.equal(r.content[0].type, 'text');
});

test('toStopReason: TOOL_USE → tool_use', () => {
  assert.equal(toStopReason('TOOL_USE'), 'tool_use');
  assert.equal(toStopReason('MAX_TOKENS'), 'max_tokens');
  assert.equal(toStopReason('STOP'), 'end_turn');
});

// ---------- vòng lặp đầy đủ ----------

test('VÒNG ĐỜI: model gọi tool → client trả kết quả → gửi lại upstream đúng cặp', () => {
  // 1. Gemini trả functionCall
  const r = antigravityToResult({
    candidates: [{ content: { parts: [{ functionCall: { name: 'Read', args: { path: 'a.txt' } } }] } }],
  }, 'gemini-3-flash');
  // 2. Gateway trả Claude Code dạng Anthropic
  const anth: any = resultToAnthropic('claude-sonnet-4-5', r);
  const useId = anth.content[0].id;
  // 3. Claude Code chạy tool rồi gửi lại nguyên văn lượt trước + tool_result
  const msgs = anthropicToMessages({
    model: 'x',
    messages: [
      { role: 'user', content: 'doc a.txt' },
      { role: 'assistant', content: anth.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: useId, content: 'xin chao' }] },
    ],
  });
  // 4. Dựng lại body Gemini — functionCall và functionResponse phải khớp TÊN
  const body: any = openaiToAntigravity('gemini-3-flash', msgs, { projectId: 'p' });
  const parts = body.request.contents.flatMap((c: any) => c.parts);
  const call = parts.find((p: any) => p.functionCall);
  const resp = parts.find((p: any) => p.functionResponse);
  assert.ok(call, 'phải có functionCall của lượt trước');
  assert.ok(resp, 'phải có functionResponse cho kết quả');
  assert.equal(call.functionCall.name, resp.functionResponse.name, 'tên phải khớp, nếu không Gemini báo lỗi');
  assert.equal(resp.functionResponse.response.result, 'xin chao');
});

// ---------- VÒNG 2: chữ ký + id phải khứ hồi ----------
// Đây là phần từng hỏng thật ngoài đời: vòng 1 gọi tool OK nhưng gửi tool_result về
// thì upstream trả 400. Hai nguyên nhân khác nhau ở hai upstream.

test('Gemini: thoughtSignature ở cấp PART được đọc vào ToolCall.signature', () => {
  const r = antigravityToResult({
    candidates: [{ content: { parts: [
      { thoughtSignature: 'SIG_ABC', functionCall: { name: 'Read', args: { path: 'a' }, id: 'gem_1' } },
    ] } }],
  }, 'gemini-3-flash');
  assert.equal(r.toolCalls[0]!.signature, 'SIG_ABC');
  assert.equal(r.toolCalls[0]!.id, 'gem_1', 'id upstream phải giữ, KHÔNG tự sinh đè lên');
});

test('thiếu id upstream → tự sinh (Anthropic bắt buộc có id)', () => {
  const r = antigravityToResult({
    candidates: [{ content: { parts: [{ functionCall: { name: 'Read', args: {} } }] } }],
  }, 'm');
  assert.match(r.toolCalls[0]!.id, /^toolu_/);
  assert.equal(r.toolCalls[0]!.signature, undefined);
});

test('gửi lại: thoughtSignature CÙNG CẤP functionCall, kèm id', () => {
  const b: any = openaiToAntigravity('gemini-3-flash', [
    { role: 'user', content: 'doc a' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'tc_9', name: 'Read', input: { path: 'a' }, signature: 'SIG_X' }] },
    { role: 'tool', content: 'noi dung', toolCallId: 'tc_9', toolName: 'Read' },
  ], { projectId: 'p' });

  const part = b.request.contents[1].parts[0];
  // Thiếu chữ ký → Gemini 3 trả 400 "missing a thought_signature"
  assert.equal(part.thoughtSignature, 'SIG_X');
  assert.equal(part.functionCall.thoughtSignature, undefined, 'phải ở cấp part, KHÔNG lồng trong functionCall');
  // Thiếu id → Claude qua Antigravity trả 400 "tool_use.id: Field required"
  assert.equal(part.functionCall.id, 'tc_9');
  assert.equal(b.request.contents[2].parts[0].functionResponse.id, 'tc_9');
});

test('không có chữ ký (model Claude) → KHÔNG chèn khoá thừa', () => {
  const b: any = openaiToAntigravity('claude-sonnet-4-6', [
    { role: 'assistant', content: '', toolCalls: [{ id: 'x1', name: 'Read', input: {} }] },
  ], { projectId: 'p' });
  const part = b.request.contents[0].parts[0];
  assert.equal('thoughtSignature' in part, false);
  assert.equal(part.functionCall.id, 'x1');
});

test('Anthropic: chữ ký đi khứ hồi qua block tool_use', () => {
  const out: any = resultToAnthropic('m', base({
    toolCalls: [{ id: 'tu_1', name: 'Read', input: { path: 'a' }, signature: 'SIG_RT' }],
  }));
  const block = out.content.find((c: any) => c.type === 'tool_use');
  assert.equal(block._signature, 'SIG_RT', 'phải phát ra để client trả lại');

  // Client gửi trả nguyên văn block → phải đọc lại được chữ ký
  const msgs = anthropicToMessages({ model: 'x', messages: [{ role: 'assistant', content: out.content }] });
  assert.equal(msgs[0]!.toolCalls![0]!.signature, 'SIG_RT');
  assert.equal(msgs[0]!.toolCalls![0]!.id, 'tu_1');
});

test('VÒNG ĐỜI ĐẦY ĐỦ: chữ ký + id sống sót qua cả 2 vòng', () => {
  // 1. Upstream trả tool call kèm chữ ký
  const r = antigravityToResult({
    candidates: [{ content: { parts: [
      { thoughtSignature: 'SIG_E2E', functionCall: { name: 'Read', args: { path: 'a.txt' }, id: 'up_77' } },
    ] } }],
  }, 'gemini-3-flash');
  // 2. Trả cho Claude Code
  const anth: any = resultToAnthropic('claude-sonnet-4-5', r);
  // 3. Claude Code gửi lại nguyên văn + tool_result
  const msgs = anthropicToMessages({
    model: 'x',
    messages: [
      { role: 'user', content: 'doc a.txt' },
      { role: 'assistant', content: anth.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'up_77', content: 'XIN CHAO' }] },
    ],
  });
  // 4. Dựng lại request — cả chữ ký lẫn id phải còn nguyên
  const body: any = openaiToAntigravity('gemini-3-flash', msgs, { projectId: 'p' });
  const parts = body.request.contents.flatMap((c: any) => c.parts);
  const call = parts.find((p: any) => p.functionCall);
  const resp = parts.find((p: any) => p.functionResponse);
  assert.equal(call.thoughtSignature, 'SIG_E2E', 'mất chữ ký → 400 ở vòng 2');
  assert.equal(call.functionCall.id, 'up_77', 'mất id → 400 với model Claude');
  assert.equal(resp.functionResponse.id, 'up_77');
  assert.equal(resp.functionResponse.response.result, 'XIN CHAO');
});
