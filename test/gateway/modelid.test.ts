import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelId, ModelIdError, allModels, providerOfTarget, getProvider, setBareMode, PROVIDER_IDS } from '../../src/gateway/providers/index.js';
import { planCombo, planAuto, shouldFallback, isContextTooLong, validateTargets, scoreCandidates, AUTO_VARIANTS, type Combo, type PoolSnapshot } from '../../src/gateway/combo.js';
import { messagesToCodeWhisperer, parseKiroCredential, resolveKiroUpstream } from '../../src/gateway/kiro.js';
import { anthropicToMessages, resultToAnthropic, toStopReason, resolveAnthropicModel, sseFrame } from '../../src/gateway/anthropic.js';

// ---------- model id (PREFIX BẮT BUỘC) ----------
test('prefix hợp lệ → phân tích đúng', () => {
  assert.deepEqual(parseModelId('agy/gemini-2.5-flash'), { kind: 'provider', provider: 'agy', model: 'gemini-2.5-flash', prefixed: 'agy/gemini-2.5-flash' });
  assert.deepEqual(parseModelId('kr/claude-sonnet-4'), { kind: 'provider', provider: 'kr', model: 'claude-sonnet-4', prefixed: 'kr/claude-sonnet-4' });
  assert.equal(parseModelId('kiro/claude-sonnet-4').provider, 'kr', 'bí danh kiro/');
  assert.equal(parseModelId('antigravity/gemini-3-flash').provider, 'agy', 'bí danh antigravity/');
});

test('THIẾU prefix → 400 kèm gợi ý đúng', () => {
  assert.throws(() => parseModelId('gemini-2.5-flash'), (e: any) => e instanceof ModelIdError && e.status === 400 && e.suggestion === 'agy/gemini-2.5-flash');
  assert.throws(() => parseModelId('claude-sonnet-4'), (e: any) => e.suggestion === 'kr/claude-sonnet-4');
  assert.throws(() => parseModelId(''), ModelIdError);
  assert.throws(() => parseModelId(undefined), ModelIdError);
});

test('prefix lạ (openai/…) không bị hiểu nhầm là provider', () => {
  assert.throws(() => parseModelId('openai/gpt-4o'), (e: any) => e instanceof ModelIdError && /không phải provider/.test(e.message));
});

test('combo + auto có namespace riêng', () => {
  assert.deepEqual(parseModelId('auto'), { kind: 'auto', prefixed: 'auto', combo: 'default' });
  assert.equal(parseModelId('auto/fast').combo, 'fast');
  assert.deepEqual(parseModelId('combo/main'), { kind: 'combo', prefixed: 'combo/main', combo: 'main' });
  assert.throws(() => parseModelId('combo/'), ModelIdError);
});

test('registry: model đều có prefix, target store map đúng', () => {
  const ms = allModels();
  assert.ok(ms.length >= 13);
  // Suy prefix từ REGISTRY, không khoá cứng: thêm provider mới thì test tự bao phủ,
  // không phải sửa lại danh sách ở đây.
  const re = new RegExp(`^(${PROVIDER_IDS.join('|')})/`);
  assert.ok(ms.every((m) => re.test(m.prefixed)), `model có prefix lạ: ${ms.find((m) => !re.test(m.prefixed))?.prefixed}`);
  assert.equal(new Set(ms.map((m) => m.prefixed)).size, ms.length, 'id không được trùng');
  assert.equal(providerOfTarget('agy')?.id, 'agy');
  assert.equal(providerOfTarget('kiro')?.id, 'kr', "target CSV là 'kiro', không phải 'kr'");
  assert.equal(providerOfTarget('openrouter')?.id, 'or');
  assert.equal(providerOfTarget('gweb'), undefined);
  assert.equal(getProvider('kr')?.label, 'Kiro');
});

// ---------- combo ----------
const snap: PoolSnapshot = {
  agy: { provider: 'agy', available: 100, total: 100, quotaAvg: 100, p95Ms: 3000, successRate: 0.99, inflight: 0 },
  kr: { provider: 'kr', available: 10, total: 100, quotaAvg: null, p95Ms: 1500, successRate: 0.6, inflight: 5 },
};
const combo = (strategy: any, models: string[]): Combo => ({ id: 'c', name: 'c', strategy, enabled: true, targets: models.map((m) => ({ model: m })) });

test('planCombo: priority giữ nguyên thứ tự', () => {
  const p = planCombo(combo('priority', ['agy/gemini-3-flash', 'kr/claude-sonnet-4']), snap);
  assert.deepEqual(p.map((t) => t.model), ['agy/gemini-3-flash', 'kr/claude-sonnet-4']);
});

test('planCombo: round-robin xoay điểm bắt đầu', () => {
  const c = combo('round-robin', ['a1', 'a2', 'a3']);
  const first = planCombo(c, snap)[0]!.model;
  const second = planCombo(c, snap)[0]!.model;
  assert.notEqual(first, second, 'lần gọi sau phải bắt đầu từ target khác');
});

test('planCombo: highest-quota đưa provider quota cao lên đầu', () => {
  const p = planCombo(combo('highest-quota', ['kr/claude-sonnet-4', 'agy/gemini-3-flash']), snap);
  assert.equal(p[0]!.model, 'agy/gemini-3-flash', 'agy 100% phải đứng trước kr (10/100)');
});

test('shouldFallback: chỉ trượt khi đáng', () => {
  assert.equal(shouldFallback({ status: 402, message: 'MONTHLY_REQUEST_COUNT' }), true);
  assert.equal(shouldFallback({ status: 429 }), true);
  assert.equal(shouldFallback({ status: 500 }), true);
  assert.equal(shouldFallback({ message: 'fetch failed' }), true);
  assert.equal(shouldFallback({ status: 400, message: 'bad model' }), false, 'lỗi người dùng KHÔNG trượt (tránh tốn quota)');
  assert.equal(shouldFallback({ status: 401 }), false);
});

test('validateTargets: chặn combo trỏ vào combo / model lạ', () => {
  assert.equal(validateTargets([{ model: 'agy/gemini-3-flash' }]).ok, true);
  assert.equal(validateTargets([]).ok, false);
  const r1 = validateTargets([{ model: 'combo/other' }]);
  assert.equal(r1.ok, false);
  assert.match((r1 as any).error, /không được trỏ tới/);
  assert.equal(validateTargets([{ model: 'agy/khong-co-model-nay' }]).ok, false);
});

test('scoreCandidates: xếp hạng theo trọng số, provider hết account = 0 điểm', () => {
  const fast = scoreCandidates(snap, AUTO_VARIANTS.fast!);
  assert.ok(fast.length > 0);
  const dead: PoolSnapshot = { ...snap, kr: { ...snap.kr!, available: 0 } };
  assert.ok(scoreCandidates(dead, AUTO_VARIANTS.default!).filter((s) => s.provider === 'kr').every((s) => s.score === 0));
  const plan = planAuto('quota', snap);
  assert.equal(plan[0]!.model.startsWith('agy/'), true, 'auto/quota ưu tiên provider còn nhiều quota');
});

// ---------- Kiro ----------
test('parseKiroCredential: chỉ nhận JSON có refreshToken', () => {
  assert.equal(parseKiroCredential('1//google-token'), null);
  assert.equal(parseKiroCredential('{}'), null);
  assert.equal(parseKiroCredential(''), null);
  const c = parseKiroCredential('{"refreshToken":"x","profileArn":"arn:aws:y"}');
  assert.equal(c?.refreshToken, 'x');
});

test('resolveKiroUpstream: bí danh gạch ngang → id thật (dấu chấm)', () => {
  assert.equal(resolveKiroUpstream('claude-sonnet-4'), 'claude-sonnet-4');
  assert.equal(resolveKiroUpstream('claude-haiku-4-5'), 'claude-haiku-4.5');
});

test('messagesToCodeWhisperer: system gộp vào user đầu, user cuối vào currentMessage', () => {
  const body: any = messagesToCodeWhisperer('claude-sonnet-4', [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Q1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'Q2' },
  ], { profileArn: 'arn:aws:test', conversationId: 'cid' });

  assert.equal(body.profileArn, 'arn:aws:test', 'profileArn phải ở TOP LEVEL');
  const cur = body.conversationState.currentMessage.userInputMessage;
  assert.equal(cur.content, 'Q2', 'tin user cuối là currentMessage');
  assert.equal(cur.modelId, 'claude-sonnet-4');
  assert.equal(cur.origin, 'AI_EDITOR');
  const h = body.conversationState.history;
  assert.equal(h.length, 2);
  assert.match(h[0].userInputMessage.content, /Be terse\./, 'system gộp vào user đầu');
  assert.match(h[0].userInputMessage.content, /Q1/);
  assert.equal(h[1].assistantResponseMessage.content, 'A1');
});

test('messagesToCodeWhisperer: ép history xen kẽ (gộp cùng vai, bỏ assistant đứng đầu)', () => {
  const body: any = messagesToCodeWhisperer('claude-sonnet-4', [
    { role: 'assistant', content: 'thua ra' },
    { role: 'user', content: 'A' },
    { role: 'user', content: 'B' },
    { role: 'assistant', content: 'C' },
    { role: 'user', content: 'D' },
  ], { profileArn: 'arn' });
  const h = body.conversationState.history;
  assert.equal(h.length, 2, 'assistant đứng đầu bị bỏ, 2 user liền nhau gộp lại');
  assert.equal(h[0].userInputMessage.content, 'A\nB');
  assert.equal(body.conversationState.currentMessage.userInputMessage.content, 'D');
});

// ---------- Anthropic ----------
test('anthropicToMessages: system string + block array', () => {
  assert.equal(anthropicToMessages({ model: 'x', system: 'S', messages: [{ role: 'user', content: 'hi' }] })[0]!.role, 'system');
  const m = anthropicToMessages({ model: 'x', system: [{ type: 'text', text: 'S1' }, { type: 'text', text: 'S2' }], messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(m[0]!.content, 'S1\nS2');
});

test('anthropicToMessages: ảnh base64 → data URL đúng shape sẵn có', () => {
  const m = anthropicToMessages({
    model: 'x',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'xem' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }],
  });
  const parts = m[0]!.content as any[];
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, 'data:image/png;base64,AAA');
});

test('anthropicToMessages: tool_result → message role tool (KHÔNG phẳng hoá nữa)', () => {
  const m = anthropicToMessages({ model: 'x', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ket qua' }] }] });
  assert.equal(m.length, 1);
  assert.equal(m[0]!.role, 'tool');
  assert.equal(m[0]!.content, 'ket qua');
  assert.equal(m[0]!.toolCallId, 'tu_1');
});

test('resultToAnthropic + toStopReason', () => {
  const r = resultToAnthropic('claude-sonnet-4-5', { text: 'hi', images: [], usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 }, finishReason: 'STOP', model: 'x' });
  assert.equal(r.type, 'message');
  assert.equal(r.content[0]!.text, 'hi');
  assert.deepEqual(r.usage, { input_tokens: 3, output_tokens: 2 });
  assert.equal(toStopReason('MAX_TOKENS'), 'max_tokens');
  assert.equal(toStopReason('STOP'), 'end_turn');
});

test('resolveAnthropicModel: id Anthropic thật → map theo config (ngoại lệ có chủ đích)', () => {
  const cfg = { big: 'kr/claude-sonnet-4.5', small: 'kr/claude-haiku-4.5' };
  assert.equal(resolveAnthropicModel('claude-sonnet-4-5-20250929', cfg), cfg.big);
  assert.equal(resolveAnthropicModel('claude-3-5-haiku-20241022', cfg), cfg.small);
  assert.equal(resolveAnthropicModel('agy/gemini-3-flash', cfg), 'agy/gemini-3-flash', 'đã có prefix thì giữ nguyên');
  assert.equal(resolveAnthropicModel('', cfg), cfg.big);
});

test('sseFrame có dòng event: (bắt buộc với Anthropic)', () => {
  const f = sseFrame('message_stop', { type: 'message_stop' });
  assert.match(f, /^event: message_stop\ndata: \{.*\}\n\n$/);
});

// ---------- chế độ id trần (cắm vào OmniRoute/LiteLLM) ----------
test('bareMode: id trần gọi được, đuôi -kr chỉ đúng model Kiro', () => {
  setBareMode(true);
  try {
    assert.equal(parseModelId('gemini-2.5-flash').prefixed, 'agy/gemini-2.5-flash');
    assert.equal(parseModelId('qwen3-coder-next').prefixed, 'kr/qwen3-coder-next');
    // 'auto' vẫn là combo ảo, KHÔNG được hiểu thành model auto của Kiro
    assert.equal(parseModelId('auto').kind, 'auto');
    assert.equal(parseModelId('auto-kr').prefixed, 'kr/auto');
    // id lạ vẫn báo lỗi rõ ràng
    assert.throws(() => parseModelId('khong-co-model-nay'), ModelIdError);
  } finally {
    setBareMode(false);
  }
});

test('tắt bareMode: id trần lại báo 400 kèm gợi ý (mặc định an toàn)', () => {
  assert.throws(() => parseModelId('gemini-2.5-flash'), (e: any) => e.suggestion === 'agy/gemini-2.5-flash');
});

test('shouldFallback: đầu vào quá dài → TRƯỢT sang model ngữ cảnh lớn hơn', () => {
  // Kiro chặn quanh ~100k token dù công bố 200k; Antigravity nhận 1M → trượt là đúng
  assert.equal(shouldFallback({ status: 400, message: 'Kiro 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD: Input is too long.' }), true);
  assert.equal(shouldFallback({ status: 400, message: 'Failed to buffer the request body: length limit exceeded' }), true);
  assert.equal(isContextTooLong({ message: 'context length exceeded' }), true);
  // lỗi người dùng thật vẫn KHÔNG trượt (tránh đốt quota account khác)
  assert.equal(shouldFallback({ status: 400, message: 'invalid model id' }), false);
  assert.equal(isContextTooLong({ message: 'invalid model id' }), false);
});

test('isContextTooLong: bắt đủ cách diễn đạt của các upstream', () => {
  for (const m of [
    'Prompt is too long',                                   // Anthropic (agy/claude-*)
    'Kiro 400 CONTENT_LENGTH_EXCEEDS_THRESHOLD: Input is too long.',
    'Failed to buffer the request body: length limit exceeded',
    'context_length_exceeded',
    'This model has a maximum context length of 200000 tokens',
  ]) {
    assert.equal(isContextTooLong({ message: m }), true, `phải nhận: ${m}`);
    assert.equal(shouldFallback({ status: 400, message: m }), true, `phải trượt: ${m}`);
  }
  // không được bắt nhầm lỗi khác
  for (const m of ['invalid model id', 'unauthorized', 'account bị khoá']) {
    assert.equal(isContextTooLong({ message: m }), false, `không được nhận: ${m}`);
  }
});
