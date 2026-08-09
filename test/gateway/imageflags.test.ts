import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, isImageModel } from '../../src/gateway/antigravity.js';
import { KIRO_MODELS } from '../../src/gateway/kiro.js';

/**
 * Cờ ảnh: `imageIn` (nhận ảnh) vs `imageOut` (sinh ảnh).
 *
 * Trước đây chỉ có MỘT field `image` mang hai nghĩa TRÁI NGƯỢC tuỳ provider:
 *   - antigravity.ts → "model SINH ảnh"
 *   - kiro.ts        → "model NHẬN ảnh đầu vào"
 * Cả hai phơi chung qua `/api/gateway/models`, nên đo thật thấy API trả 8 model
 * `image: true` trong khi `isImageModel()` chỉ công nhận 1. UI không thể phân biệt.
 *
 * Tệ hơn: Kiro không làm được CẢ HAI chiều — `generate()` hardcode `images: []`,
 * `textOf()` lọc bỏ mọi part không phải text. Cờ `image: true` ở đó sai theo mọi nghĩa,
 * và nó mời người dùng gửi ảnh vào model sẽ lặng lẽ vứt đi.
 */

describe('imageOut — model sinh được ảnh', () => {
  test('Antigravity: đúng MỘT model sinh ảnh', () => {
    const sinh = MODELS.filter((m) => m.imageOut);
    assert.equal(sinh.length, 1, `phải đúng 1 model sinh ảnh, đang có ${sinh.length}: ${sinh.map((m) => m.id).join(', ')}`);
    assert.equal(sinh[0].id, 'gemini-3.1-flash-image');
  });

  test('imageOut khớp với isImageModel — hai nguồn không được lệch nhau', () => {
    // Chính sự lệch giữa hai nguồn là gốc của bug: catalog nói một đằng, hàm nhận
    // biết nói một nẻo, và `requestType: image_gen` chọn theo hàm.
    for (const m of MODELS) {
      assert.equal(
        !!m.imageOut, isImageModel(m.id),
        `${m.id}: imageOut=${m.imageOut} nhưng isImageModel=${isImageModel(m.id)}`,
      );
    }
  });

  test('Kiro: KHÔNG model nào sinh được ảnh', () => {
    // provider kiro hardcode `images: []` — mọi cờ true ở đây đều là nói dối.
    const sinh = KIRO_MODELS.filter((m) => m.imageOut ?? m.image);
    assert.deepEqual(sinh.map((m) => m.id), [], 'Kiro không sinh được ảnh');
  });
});

describe('imageIn — model nhận được ảnh trong prompt', () => {
  test('Gemini nhận ảnh (contentToParts chuyển image_url thành inlineData)', () => {
    const gemini = MODELS.filter((m) => m.id.startsWith('gemini-'));
    assert.ok(gemini.length > 5, 'phải có nhiều model gemini');
    for (const m of gemini) {
      assert.equal(m.imageIn, true, `${m.id} là Gemini nên phải nhận được ảnh`);
    }
  });

  test('gpt-oss KHÔNG nhận ảnh — không phải Gemini', () => {
    const oss = MODELS.find((m) => m.id === 'gpt-oss-120b-medium');
    assert.equal(oss?.imageIn, false);
  });

  test('Kiro: KHÔNG model nào nhận ảnh (textOf lọc bỏ part ảnh)', () => {
    const nhan = KIRO_MODELS.filter((m) => m.imageIn);
    assert.deepEqual(
      nhan.map((m) => m.id), [],
      'Kiro v1 không nhận ảnh — bật cờ này là mời người dùng gửi ảnh rồi vứt đi',
    );
  });
});

describe('tương thích ngược', () => {
  test('`image` vẫn là alias của imageOut cho client cũ', () => {
    for (const m of MODELS) {
      assert.equal(m.image, !!m.imageOut, `${m.id}: alias image phải bằng imageOut`);
    }
  });

  test('mọi model đều có đủ hai cờ mới — thêm model không được quên', () => {
    for (const m of MODELS) {
      assert.equal(typeof m.imageIn, 'boolean', `${m.id} thiếu imageIn`);
      assert.equal(typeof m.imageOut, 'boolean', `${m.id} thiếu imageOut`);
    }
  });
});
