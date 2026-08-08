import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Hồi quy cho vụ 299/350 credential Kiro bị đánh `dead` OAN.
 *
 * Triệu chứng thật: dead thành mảng LIÊN TỤC (thehien150–299 + toàn bộ lovansam) trong
 * khi refresh thủ công từng cái đều HTTP 200. Nguyên nhân: checkAll() bắn hàng trăm
 * request liên tục vào endpoint auth, bị rate-limit giữa chừng, và `if (!res.ok) return
 * 'dead'` biến 429 thành "token chết vĩnh viễn" — kèm setStatus('new') để re-capture.
 *
 * Test đọc mã nguồn thay vì gọi mạng: hành vi cần khoá là "429/5xx KHÔNG bao giờ ra
 * dead", và điều đó phải đúng ở mọi nhánh provider.
 */
const SRC = readFileSync(new URL('../../src/health/tokenHealth.ts', import.meta.url), 'utf8');

describe('tokenHealth — lỗi tạm không được thành "dead"', () => {
  test('cả hai nhánh provider đều chặn 429/5xx trước khi kết luận dead', () => {
    const guards = SRC.match(/res\.status === 429 \|\| res\.status >= 500/g) ?? [];
    assert.equal(guards.length, 2, 'phải có guard ở CẢ checkAgy lẫn checkKiro');
    for (const fn of ['checkAgy', 'checkKiro']) {
      const at = SRC.indexOf(`function ${fn}`);
      // BỎ COMMENT trước khi so vị trí: phần giải thích ở trên có nhắc chữ 'dead',
      // so thô sẽ báo sai thứ tự dù mã đúng.
      const body = SRC.slice(at, at + 1800)
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const g = body.indexOf('res.status === 429');
      const d = body.indexOf("return 'dead'");
      assert.ok(g > 0, `${fn} thiếu guard 429/5xx`);
      assert.ok(d < 0 || g < d, `${fn}: guard phải đứng trước nhánh trả 'dead'`);
    }
  });

  test('429/5xx trả về "unknown" — không kết luận, để lần quét sau quyết', () => {
    assert.match(SRC, /res\.status === 429 \|\| res\.status >= 500\) return 'unknown'/);
  });

  test('checkAll giãn nhịp giữa các lần gọi', () => {
    assert.match(SRC, /GAP_MS/, 'checkAll phải có khoảng nghỉ giữa các credential');
    assert.match(SRC, /setTimeout\(r, GAP_MS\)/);
  });

  test('chỉ "dead" mới kích hoạt re-capture — unknown thì không', () => {
    assert.match(SRC, /if \(h === 'dead'\) \{[\s\S]{0,200}setStatus/);
  });
});
