import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Có bản mới thì phải TỰ BÁO, không bắt người dùng đi tìm.
 *
 * Trạng thái trước: `UpdatePanel` chỉ nằm trong trang Cài đặt (`Settings.tsx:487`) và
 * KHÔNG poll (`staleTime: 5 phút`, không có `refetchInterval`). Nghĩa là muốn biết có bản
 * mới thì phải tự nhớ mà vào đúng trang đó bấm "Kiểm tra lại".
 *
 * Thực tế đo được: production chạy 8 commit cũ suốt nhiều ngày mà không ai biết — một
 * phần vì `hasUpdate` hỏng (đã sửa), một phần vì không có gì đập vào mắt.
 *
 * Yêu cầu: dashboard tự hỏi định kỳ, có bản mới thì hiện chỉ báo ở chỗ luôn nhìn thấy
 * (sidebar). Người dùng chỉ việc bấm vào.
 */

const ROOT = resolve(import.meta.dirname, '../..');

function code(f: string): string {
  return readFileSync(resolve(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('dashboard TỰ hỏi có bản mới không', () => {
  test('hook dùng chung, không mỗi nơi một bản', () => {
    /**
     * Sidebar và trang Cài đặt cùng cần dữ liệu này. Hai `useQuery` khác `queryKey` là
     * hai lời gọi mạng và hai nguồn sự thật — chúng sẽ lệch nhau.
     */
    const s = code('web/src/components/common/UpdatePanel.tsx');
    assert.match(s, /export function useUpdateCheck/, 'phải export hook dùng chung');
    assert.match(s, /queryKey: \["systemUpdate"\]/);
  });

  test('có poll định kỳ, không chỉ staleTime', () => {
    /**
     * `staleTime` chỉ nói "dữ liệu cũ sau bao lâu", KHÔNG tự gọi lại. Không có
     * `refetchInterval` thì thẻ đứng im cho tới khi người dùng bấm tay.
     */
    const s = code('web/src/components/common/UpdatePanel.tsx');
    assert.match(s, /refetchInterval:/, 'thiếu refetchInterval → không bao giờ tự phát hiện');
  });

  test('nhịp poll thưa — đây là việc nền, không phải số liệu sống', () => {
    /**
     * Hỏi GitHub API mỗi 10 giây là tự đốt hạn ngạch 60 lượt/giờ theo IP. Bản mới không
     * xuất hiện mỗi phút; vài chục phút một lần là quá đủ.
     */
    const s = code('web/src/components/common/UpdatePanel.tsx');
    // Viết dạng `30 * 60_000` nên phải tính tích, không đọc được một số đơn.
    const m = s.match(/refetchInterval:\s*([0-9_]+)\s*\*\s*([0-9_]+)|refetchInterval:\s*([0-9_]+)/);
    assert.ok(m, 'không đọc được nhịp poll');
    const so = (x?: string) => Number((x ?? '').replace(/_/g, ''));
    const ms = m![3] ? so(m![3]) : so(m![1]) * so(m![2]);
    assert.ok(ms >= 10 * 60_000, `poll mỗi ${ms / 60000} phút — quá dày, sẽ hết hạn ngạch GitHub API`);
  });
});

describe('chỉ báo hiện ở chỗ LUÔN nhìn thấy', () => {
  test('sidebar có chỉ báo bản mới', () => {
    /**
     * `UpdatePanel` nằm trong trang Cấu hình — người dùng không vào đó hằng ngày. Chỉ báo
     * phải ở sidebar, thứ luôn hiện trên mọi trang.
     */
    const s = code('web/src/components/AppSidebar.tsx');
    assert.match(s, /useUpdateCheck/, 'sidebar phải hỏi trạng thái cập nhật');
    assert.match(s, /hasUpdate/, 'phải dùng hasUpdate để quyết định hiện chỉ báo');
    assert.match(s, /item\.tab === "settings" && coBanMoi/, 'chỉ báo phải gắn vào mục Cấu hình');
  });

  test('chỉ báo dùng design token, không hard-code màu', () => {
    // Luật số 1 của dashboard: mọi màu phải là token (xem web/.claude/CLAUDE.md).
    const s = code('web/src/components/AppSidebar.tsx');
    const i = s.indexOf('coBanMoi &&');
    assert.ok(i > 0);
    const doan = s.slice(i, i + 400);
    assert.doesNotMatch(doan, /bg-(orange|emerald|red|blue|green)-[0-9]/, 'hard-code màu quanh chỉ báo');
  });
});
