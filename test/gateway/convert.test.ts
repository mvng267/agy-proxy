import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openaiToAntigravity,
  antigravityToResult,
  resolveUpstreamModel,
  isImageModel,
} from '../../src/gateway/antigravity.js';

test('openaiToAntigravity: body cơ bản đúng schema', () => {
  const b: any = openaiToAntigravity('gemini-2.5-flash', [{ role: 'user', content: 'hi' }], { projectId: 'proj-1' });
  assert.equal(b.userAgent, 'antigravity');
  assert.equal(b.requestType, 'agent');
  assert.equal(b.project, 'proj-1');
  assert.match(b.requestId, /^agent-/);
  assert.equal(b.model, 'gemini-2.5-flash');
  assert.deepEqual(b.request.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  assert.ok(b.request.sessionId);
});

test('system message → systemInstruction; assistant → role model', () => {
  const b: any = openaiToAntigravity('gemini-2.5-flash', [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ], { projectId: 'p' });
  assert.deepEqual(b.request.systemInstruction, { parts: [{ text: 'be brief' }] });
  assert.equal(b.request.contents[0].role, 'user');
  assert.equal(b.request.contents[1].role, 'model');
});

test('image model → requestType image_gen + requestId image_gen/', () => {
  const b: any = openaiToAntigravity('gemini-3.1-flash-image', [{ role: 'user', content: 'a cat' }], { projectId: 'p' });
  assert.equal(b.requestType, 'image_gen');
  assert.match(b.requestId, /^image_gen\//);
});

test('image_url data URL → inlineData', () => {
  const b: any = openaiToAntigravity('gemini-2.5-flash', [
    { role: 'user', content: [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ] },
  ], { projectId: 'p' });
  const parts = b.request.contents[0].parts;
  assert.deepEqual(parts[0], { text: 'what is this' });
  assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/png', data: 'QUJD' } });
});

test('resolveUpstreamModel: map gemini-3-pro-* → gemini-pro-agent', () => {
  assert.equal(resolveUpstreamModel('gemini-3-pro-high'), 'gemini-pro-agent');
  assert.equal(resolveUpstreamModel('gemini-3-pro-low'), 'gemini-pro-agent');
  assert.equal(resolveUpstreamModel('gemini-3.1-pro-preview'), 'gemini-pro-agent');
  // Theo danh mục Antigravity CLI: "Gemini 3.5 Flash (High)" = upstream gemini-3-flash-agent.
  // Trước đây map sang gemini-3.5-flash-low, nhưng đó là bản Medium → High bị hạ cấp âm thầm.
  assert.equal(resolveUpstreamModel('gemini-3.5-flash-high'), 'gemini-3-flash-agent');
  assert.equal(resolveUpstreamModel('gemini-2.5-flash'), 'gemini-2.5-flash'); // không map
});

test('openaiToAntigravity dùng upstream cho model đã map', () => {
  const b: any = openaiToAntigravity('gemini-3-pro-high', [{ role: 'user', content: 'hi' }], { projectId: 'p' });
  assert.equal(b.model, 'gemini-pro-agent');
});

test('isImageModel', () => {
  assert.equal(isImageModel('gemini-3.1-flash-image'), true);
  assert.equal(isImageModel('gemini-2.5-flash'), false);
});

test('antigravityToResult: bóc text + usage (bọc .response)', () => {
  const resp = {
    response: {
      candidates: [{ content: { parts: [{ text: 'PONG' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    },
  };
  const r = antigravityToResult(resp, 'gemini-2.5-flash');
  assert.equal(r.text, 'PONG');
  assert.equal(r.finishReason, 'STOP');
  assert.deepEqual(r.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
});

test('antigravityToResult: inlineData → images data URL (không bọc .response)', () => {
  const resp = {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'QQ==' } }] } }],
  };
  const r = antigravityToResult(resp, 'gemini-3.1-flash-image');
  assert.equal(r.images.length, 1);
  assert.equal(r.images[0], 'data:image/jpeg;base64,QQ==');
});
