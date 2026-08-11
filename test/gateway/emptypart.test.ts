import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openaiToAntigravity } from '../../src/gateway/antigravity.js';

/**
 * KHÔNG BAO GIỜ gửi part text rỗng lên Antigravity.
 *
 * Đo thật trên upstream 11/08/2026 (account còn quota Claude, model claude-sonnet-4-6):
 *   parts: [{ text: '1+1?' }]  → 200
 *   parts: [{ text: '' }]      → 400  messages.0.content.0.text.text: Field required
 *   parts: []                  → 400  messages: Field required
 *   parts: [{ text: ' ' }]     → 400  messages: text content blocks must contain non-whitespace text
 *   bỏ hẳn message rỗng        → 200  ← chỉ cách này chạy
 *
 * Số trong câu lỗi trỏ ĐÚNG vị trí message rỗng (`messages.1...` khi nó đứng thứ hai).
 *
 * Vì sao chỉ Claude vỡ mà Gemini không: proto3 không emit field scalar rỗng, nên `text: ''`
 * biến mất lúc serialize; Antigravity dịch parts → block Anthropic ra `{"type":"text"}`
 * thiếu hẳn field `text`. Gemini không qua bước dịch đó. Bug nằm im từ commit đầu tiên tới
 * khi Antigravity siết validate phía Claude — làm chết TOÀN BỘ model `agy/claude-*`.
 */

const OPT = { projectId: 'p' };

/** Mọi part text trong payload — để khẳng định không cái nào rỗng. */
function moiPartText(body: Record<string, unknown>): string[] {
  const req = body.request as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
  return (req.contents ?? []).flatMap((c) => (c.parts ?? []).filter((p) => 'text' in p).map((p) => p.text ?? ''));
}

function contents(body: Record<string, unknown>) {
  return (body.request as { contents: Array<{ role: string; parts: unknown[] }> }).contents;
}

describe('không sinh part text rỗng', () => {
  test('message content rỗng → BỎ message đó, không độn part rỗng', () => {
    const b = openaiToAntigravity('agy/claude-sonnet-4-6', [
      { role: 'user', content: '' },
      { role: 'user', content: 'that su hoi' },
    ] as never, OPT);
    assert.deepEqual(moiPartText(b), ['that su hoi'], 'message rỗng phải biến mất hẳn');
    assert.equal(contents(b).length, 1);
  });

  test('message rỗng ĐỨNG SAU vẫn bị bỏ — chính ca upstream báo messages.1', () => {
    const b = openaiToAntigravity('agy/claude-sonnet-4-6', [
      { role: 'user', content: '1+1?' },
      { role: 'assistant', content: '' },
    ] as never, OPT);
    assert.deepEqual(moiPartText(b), ['1+1?']);
  });

  test('content mảng không có block text nào → bỏ message', () => {
    // Client Anthropic gửi message chỉ có block `thinking` là ra đúng ca này.
    const b = openaiToAntigravity('agy/claude-sonnet-4-6', [
      { role: 'user', content: [] },
      { role: 'user', content: 'thuc te' },
    ] as never, OPT);
    assert.deepEqual(moiPartText(b), ['thuc te']);
  });

  test('block text rỗng trong mảng → không lọt xuống payload', () => {
    const b = openaiToAntigravity('agy/claude-sonnet-4-6', [
      { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'co chu' }] },
    ] as never, OPT);
    assert.ok(!moiPartText(b).includes(''), 'part rỗng lọt qua là 400 ngay');
  });

  test('MỌI message rỗng → vẫn có đúng 1 message, nội dung KHÁC rỗng', () => {
    /**
     * Không được để `contents: []` — upstream trả `messages: Field required`. Cũng không
     * được dùng khoảng trắng — `text content blocks must contain non-whitespace text`.
     */
    const b = openaiToAntigravity('agy/claude-sonnet-4-6', [{ role: 'user', content: '' }] as never, OPT);
    const parts = moiPartText(b);
    assert.equal(contents(b).length, 1, 'contents rỗng → 400 messages: Field required');
    assert.equal(parts.length, 1);
    assert.notEqual(parts[0], '', 'text rỗng → 400 content.0.text.text: Field required');
    assert.match(parts[0]!, /\S/, 'chỉ khoảng trắng → 400 must contain non-whitespace text');
  });

  test('danh sách message RỖNG HOÀN TOÀN cũng ra payload hợp lệ', () => {
    const b = openaiToAntigravity('agy/claude-sonnet-4-6', [] as never, OPT);
    assert.equal(contents(b).length, 1);
    assert.match(moiPartText(b)[0]!, /\S/);
  });

  test('bất biến: KHÔNG part text nào rỗng hay chỉ khoảng trắng, với mọi đầu vào', () => {
    const CA: Array<Array<Record<string, unknown>>> = [
      [{ role: 'user', content: '' }],
      [{ role: 'user', content: '   ' }],
      [{ role: 'user', content: [] }],
      [{ role: 'user', content: [{ type: 'text', text: '' }] }],
      [{ role: 'system', content: '' }, { role: 'user', content: '' }],
      [{ role: 'user', content: 'a' }, { role: 'assistant', content: '' }, { role: 'user', content: 'b' }],
      [],
    ];
    for (const msgs of CA) {
      const b = openaiToAntigravity('agy/claude-sonnet-4-6', msgs as never, OPT);
      const cs = contents(b);
      assert.ok(cs.length >= 1, `contents rỗng với ${JSON.stringify(msgs)}`);
      for (const c of cs) {
        assert.ok(c.parts.length >= 1, `message không có part nào: ${JSON.stringify(msgs)}`);
      }
      for (const t of moiPartText(b)) {
        assert.match(t, /\S/, `part rỗng/khoảng trắng lọt qua với ${JSON.stringify(msgs)}`);
      }
    }
  });
});

describe('không phá đường đang chạy', () => {
  test('hội thoại bình thường giữ nguyên thứ tự và nội dung', () => {
    const b = openaiToAntigravity('agy/claude-sonnet-4-6', [
      { role: 'user', content: 'cau 1' },
      { role: 'assistant', content: 'tra loi 1' },
      { role: 'user', content: 'cau 2' },
    ] as never, OPT);
    assert.deepEqual(moiPartText(b), ['cau 1', 'tra loi 1', 'cau 2']);
    assert.deepEqual(contents(b).map((c) => c.role), ['user', 'model', 'user']);
  });

  test('system đi vào systemInstruction, không thành message rỗng', () => {
    const b = openaiToAntigravity('agy/claude-sonnet-4-6', [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ] as never, OPT);
    assert.deepEqual(moiPartText(b), ['hi'], 'system không được lẫn vào contents');
    assert.ok((b.request as { systemInstruction?: unknown }).systemInstruction);
  });

  test('assistant có tool_call nhưng content rỗng → GIỮ, vì functionCall là nội dung thật', () => {
    /**
     * Ca này KHÔNG được rơi vào nhánh "bỏ message rỗng": nó có part `functionCall`, chỉ là
     * không có part text. Bỏ đi là mất lượt gọi tool và hỏng hẳn tool-use nhiều vòng.
     */
    const b = openaiToAntigravity('agy/claude-sonnet-4-6', [
      { role: 'user', content: 'thoi tiet?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'get_weather', input: { q: 'HN' } }] },
    ] as never, OPT);
    const cs = contents(b);
    assert.equal(cs.length, 2, 'message có functionCall bị bỏ mất → tool-use chết');
    const parts = cs[1]!.parts as Array<Record<string, unknown>>;
    assert.ok(parts.some((p) => p.functionCall), 'thiếu functionCall');
    assert.ok(!parts.some((p) => p.text === ''), 'vẫn không được có text rỗng');
  });

  test('ảnh không kèm text → giữ message, part ảnh là nội dung thật', () => {
    const b = openaiToAntigravity('agy/gemini-3-pro-high', [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }],
      },
    ] as never, OPT);
    const cs = contents(b);
    assert.equal(cs.length, 1, 'message chỉ có ảnh bị bỏ mất');
    assert.ok((cs[0]!.parts as Array<Record<string, unknown>>).some((p) => p.inlineData || p.inline_data));
  });
});
