import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Máy chủ không có màn hình thì KHÔNG được mở cửa sổ trình duyệt.
 *
 * Sự cố thật trên production (log 10/08): gặp captcha khi headless, runner leo thang
 * sang headful bằng `attempt(false)` — nhưng Debian không chạy X nên Chrome chết ngay:
 *
 *   Missing X server or $DISPLAY
 *   The platform failed to initialize. Exiting.
 *
 * Người vận hành chỉ thấy "browserType.launchPersistentContext: Target page, context or
 * browser has been closed" kèm 30 dòng log Chrome, và tưởng trình duyệt hỏng. Nguyên nhân
 * thật — captcha cần người xử lý — bị chôn mất. Account bị đánh `failed` dù có thể vẫn tốt.
 *
 * Kiểm bằng cách đọc mã nguồn: hàm này phụ thuộc biến môi trường và platform nên gọi
 * trực tiếp trong test sẽ ra kết quả của máy chạy test, không phải của production.
 */

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = readFileSync(resolve(ROOT, 'src/flows/runner.ts'), 'utf8');

describe('leo thang headful — chỉ khi máy có màn hình', () => {
  test('có hàm kiểm màn hình trước khi mở cửa sổ', () => {
    assert.match(SRC, /function canOpenWindow\(\)/, 'thiếu hàm kiểm');
    // Guard phải đứng TRƯỚC attempt(false), nếu không thì vô nghĩa.
    const i = SRC.indexOf('if (!canOpenWindow())');
    const j = SRC.indexOf('await attempt(false)');
    assert.ok(i > 0 && j > i, 'guard phải chặn TRƯỚC khi gọi attempt(false)');
  });

  test('nhận biết qua DISPLAY / WAYLAND_DISPLAY', () => {
    // Chrome đọc biến môi trường, không đọc socket — kiểm /tmp/.X11-unix là sai hướng.
    const fn = SRC.slice(SRC.indexOf('function canOpenWindow()'), SRC.indexOf('/** Đăng ký các run'));
    assert.match(fn, /process\.env\.DISPLAY/);
    assert.match(fn, /WAYLAND_DISPLAY/);
    assert.match(fn, /process\.platform !== 'linux'/, 'macOS/Windows luôn mở được cửa sổ');
  });

  test('không màn hình → needs_human, KHÔNG phải failed', () => {
    /**
     * Phân biệt quan trọng: account chưa chắc hỏng, chỉ là việc này cần người và người
     * phải làm ở nơi có màn hình. Đánh `failed` là đổ oan cho account.
     */
    assert.match(SRC, /challenge_no_display/, 'phải có mã lỗi riêng để phân biệt');
    const map = SRC.slice(SRC.indexOf('const canHuman ='), SRC.indexOf('const canHuman =') + 220);
    assert.match(map, /challenge_no_display/, 'mã này phải map sang needs_human');
    assert.match(map, /needs_human/);
  });

  test('log nói rõ nguyên nhân và cách xử lý', () => {
    // Log cũ chôn nguyên nhân dưới 30 dòng Chrome log; log mới phải nói thẳng.
    const i = SRC.indexOf('if (!canOpenWindow())');
    const block = SRC.slice(i, i + 400);
    assert.match(block, /captcha/i, 'phải nói đây là captcha');
    assert.match(block, /màn hình|X server/i, 'phải nói máy chủ thiếu gì');
    assert.match(block, /xvfb/i, 'phải gợi ý cách khắc phục');
  });
});
