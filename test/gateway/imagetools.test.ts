import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openaiToAntigravity } from '../../src/gateway/antigravity.js';
import { shouldFallback, isModelIncompatible } from '../../src/gateway/combo.js';

/**
 * Model ảnh + lịch sử có tool_use = 400 "Function call is missing a thought_signature".
 *
 * Sự cố thật 11/08/2026 trên production, `combo/combo-samlv`:
 *   17:15:12  ERR 400  agy/gemini-3.1-flash-image  ← ✗ Function call is missing a thought…
 * Lần vết theo request_id: 4 lần thử liên tiếp ĐỀU cùng model đó, client hỏng hẳn — dù
 * combo có 7 bước và bước 5 là `kr/claude-sonnet-4.5` thừa sức xử lý.
 *
 * Hai lỗi độc lập cộng lại:
 *   1. Payload lệch: model ảnh bỏ `tools` (không có function calling) nhưng VẪN gửi
 *      `functionCall` trong lịch sử. Gemini thấy lượt gọi tool mà không có tool nào để
 *      đối chiếu → đòi thought_signature.
 *   2. Combo không trượt: quy tắc "400 thì không fallback" (đúng cho lỗi người dùng) chặn
 *      luôn cả lỗi tương thích model — thứ mà model kế xử lý được.
 */

const OPT = { projectId: 'p' };

const TOOLS = [{ name: 'get_weather', description: 'd', parameters: { type: 'object' as const } }];

/** Hội thoại có một lượt gọi tool — đúng thứ làm vỡ. */
const LICH_SU = [
  { role: 'user', content: 'thoi tiet HN?' },
  { role: 'assistant', content: 'de toi tra cuu', toolCalls: [{ id: 't1', name: 'get_weather', input: { q: 'HN' } }] },
  { role: 'tool', content: '25 do', toolCallId: 't1', toolName: 'get_weather' },
  { role: 'user', content: 've cai anh con meo' },
];

function moiPart(body: Record<string, unknown>) {
  const req = body.request as { contents?: Array<{ parts?: Array<Record<string, unknown>> }> };
  return (req.contents ?? []).flatMap((c) => c.parts ?? []);
}

function coTools(body: Record<string, unknown>) {
  return !!(body.request as { tools?: unknown }).tools;
}

describe('model ảnh: tools và functionCall phải nhất quán', () => {
  test('model ảnh KHÔNG gửi functionCall (vì cũng không gửi tools)', () => {
    const b = openaiToAntigravity('gemini-3.1-flash-image', LICH_SU as never, { ...OPT, tools: TOOLS });
    assert.equal(coTools(b), false, 'model ảnh không có function calling');
    assert.equal(
      moiPart(b).filter((p) => p.functionCall).length,
      0,
      'gửi functionCall mà không gửi tools → 400 thought_signature',
    );
  });

  test('nhưng phần TEXT của lượt đó vẫn giữ — đó là nội dung thật', () => {
    const b = openaiToAntigravity('gemini-3.1-flash-image', LICH_SU as never, { ...OPT, tools: TOOLS });
    const texts = moiPart(b).map((p) => p.text).filter(Boolean);
    assert.ok(texts.includes('de toi tra cuu'), 'bỏ cả text là mất ngữ cảnh hội thoại');
    assert.ok(texts.includes('ve cai anh con meo'));
  });

  test('model THƯỜNG vẫn gửi đủ tools + functionCall — không được phá tool-use', () => {
    const b = openaiToAntigravity('gemini-3-pro-high', LICH_SU as never, { ...OPT, tools: TOOLS });
    assert.equal(coTools(b), true);
    assert.equal(moiPart(b).filter((p) => p.functionCall).length, 1, 'model thường mất functionCall là chết tool-use');
  });

  test('BẤT BIẾN: không bao giờ có functionCall khi không có tools', () => {
    // Chính sự lệch pha này sinh ra lỗi. Khoá lại cho mọi model.
    for (const m of ['gemini-3.1-flash-image', 'gemini-3-pro-high', 'claude-sonnet-4-6']) {
      const b = openaiToAntigravity(m, LICH_SU as never, { ...OPT, tools: TOOLS });
      const fc = moiPart(b).filter((p) => p.functionCall).length;
      if (fc > 0) assert.equal(coTools(b), true, `${m}: gửi functionCall mà thiếu tools`);
    }
  });

  test('model ảnh không có lịch sử tool → không đổi gì', () => {
    const b = openaiToAntigravity('gemini-3.1-flash-image', [{ role: 'user', content: 've con meo' }] as never, OPT);
    assert.deepEqual(moiPart(b).map((p) => p.text), ['ve con meo']);
  });
});

describe('combo phải trượt khi model không tương thích', () => {
  const loi = (msg: string, status = 400) => ({ status, message: msg });

  test('thought_signature → TRƯỢT sang model kế', () => {
    // Đây là ca đã làm client hỏng: 4 lần thử cùng một model, không bao giờ sang bước 5.
    assert.equal(shouldFallback(loi('Function call is missing a thought_signature in functionCall parts')), true);
  });

  test('các cách diễn đạt khác của "model không hỗ trợ tool"', () => {
    for (const m of [
      'Function calling is not supported for this model',
      'This model does not support function calling',
      'This model does not support tools',
      'tools are not supported by this model',
    ]) {
      assert.equal(isModelIncompatible(loi(m)), true, `không nhận ra: ${m}`);
    }
  });

  test('400 do NGƯỜI DÙNG vẫn KHÔNG trượt — đổi model cũng hỏng y hệt', () => {
    /**
     * Ranh giới quan trọng: trượt vì lỗi người dùng chỉ tốn quota của mọi model trong
     * combo rồi vẫn trả cùng một lỗi.
     */
    for (const m of [
      'Invalid JSON payload received',
      'messages.0.content.0.text.text: Field required',
      'max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens',
    ]) {
      assert.equal(shouldFallback(loi(m)), false, `không được trượt với: ${m}`);
    }
  });

  test('401/403 vẫn không trượt', () => {
    assert.equal(shouldFallback({ status: 401, message: 'unauthorized' }), false);
    assert.equal(shouldFallback({ status: 403, message: 'forbidden' }), false);
  });

  test('không phá các quy tắc trượt sẵn có', () => {
    assert.equal(shouldFallback({ status: 429, message: 'quota' }), true, 'hết hạn mức phải trượt');
    assert.equal(shouldFallback({ status: 500, message: 'server' }), true);
    assert.equal(shouldFallback({ status: 400, message: 'Prompt is too long' }), true, 'vượt ngữ cảnh phải trượt');
  });
});
