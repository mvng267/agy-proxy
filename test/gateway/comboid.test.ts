import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelId, ModelIdError } from '../../src/gateway/providers/index.js';

/**
 * Cách viết `combo/<tên>` mà gateway chấp nhận.
 *
 * Bug đã xảy ra: `combo/FAST` trả 404 trong khi combo `fast` tồn tại. Nguyên nhân —
 * `parseModelId` hạ chữ thường phần PREFIX (`head.toLowerCase()`) nhưng giữ nguyên phần
 * TÊN, còn `admin.ts` khi tạo combo lại luôn ép id về chữ thường. Hai bên lệch nhau nên
 * client viết hoa tên combo là chết mà không hiểu vì sao — thông báo chỉ nói "không tồn tại".
 */

describe('combo/<tên> — dạng viết được chấp nhận', () => {
  test('chữ thường: dạng chuẩn', () => {
    const p = parseModelId('combo/fast');
    assert.equal(p.kind, 'combo');
    assert.equal(p.combo, 'fast');
    assert.equal(p.prefixed, 'combo/fast');
  });

  test('CHỮ HOA phải tra ra cùng combo — id trong DB luôn là chữ thường', () => {
    for (const raw of ['combo/FAST', 'COMBO/FAST', 'Combo/Fast', 'combo/FaSt']) {
      const p = parseModelId(raw);
      assert.equal(p.combo, 'fast', `${raw} phải quy về combo "fast"`);
      assert.equal(p.prefixed, 'combo/fast', `${raw}: prefixed phải chuẩn hoá để log/usage đồng nhất`);
    }
  });

  test('tên có gạch ngang và gạch dưới giữ nguyên', () => {
    assert.equal(parseModelId('combo/claude-hiennt-2').combo, 'claude-hiennt-2');
    assert.equal(parseModelId('combo/__t_combo').combo, '__t_combo');
  });

  test('thiếu tên → 400 kèm hướng dẫn, không phải 404', () => {
    // 404 nghĩa là "combo không tồn tại"; đây là request sai cú pháp.
    assert.throws(
      () => parseModelId('combo/'),
      (e: any) => e instanceof ModelIdError && e.status === 400 && /combo\/<tên>/.test(e.message),
    );
  });

  test('thiếu prefix combo/ → 400 nói rõ thiếu prefix', () => {
    assert.throws(
      () => parseModelId('fast'),
      (e: any) => e instanceof ModelIdError && /thiếu prefix/i.test(e.message),
    );
  });
});

describe('auto — combo ảo dựng theo request', () => {
  test('auto trần', () => {
    const p = parseModelId('auto');
    assert.equal(p.kind, 'auto');
    assert.equal(p.combo, 'default');
  });

  test('auto/<biến thể> cũng chuẩn hoá chữ thường', () => {
    assert.equal(parseModelId('auto/FAST').combo, 'fast');
    assert.equal(parseModelId('AUTO/Fast').prefixed, 'auto/fast');
  });
});

describe('không nhầm combo với provider', () => {
  test('agy/ kr/ vẫn là provider, không phải combo', () => {
    assert.equal(parseModelId('agy/gemini-3-flash').kind, 'provider');
    assert.equal(parseModelId('kr/claude-sonnet-4.5').kind, 'provider');
  });

  test('model provider GIỮ NGUYÊN hoa/thường — khác combo', () => {
    // Tên model do upstream định nghĩa, không phải id ta tự sinh. Hạ chữ thường ở đây
    // sẽ phá những model có chữ hoa hợp lệ.
    const p = parseModelId('agy/gemini-3-flash');
    assert.equal(p.model, 'gemini-3-flash');
  });

  test('prefix lạ → 400 liệt kê prefix hợp lệ', () => {
    assert.throws(
      () => parseModelId('openai/gpt-4'),
      (e: any) => e instanceof ModelIdError && /combo\/|agy\/|kr\//.test(e.message),
    );
  });
});
