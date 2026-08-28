import type { Account, FlowKey } from './models.js';
import { FLOW_KEYS, statusField } from './models.js';

/**
 * Đánh dấu account không còn đăng nhập được vì lý do NGOÀI tầm xử lý của hệ thống —
 * điển hình là tài khoản đã bị xoá khỏi Google Workspace (màn "Account deleted").
 *
 * Vì sao cần: `failed` không phân biệt "hỏng tạm, chạy lại là được" với "chết hẳn, chạy lại
 * vô ích". Dải 300-346 đã ngốn hàng chục lượt login chỉ để fail y hệt nhau, vì nhìn vào
 * dashboard không thấy khác gì một lỗi mạng thoáng qua. `needs_human` là trạng thái sẵn có
 * đúng nghĩa: máy đã bó tay, cần người vào Admin Console khôi phục.
 */
export const LY_DO_XOA = 'Đã xoá khỏi Google Workspace — khôi phục ở Admin Console (Users → Deleted users → Restore)';

/**
 * Chỉ đánh dấu flow ĐANG dùng thật.
 *
 * Đánh dấu cả `google`/`gweb`/`gcli`/`nous` thì `/api/health` dựng lên ba provider mới với
 * "total 47", trông như hệ thống có chạy Gemini Web/CLI — chưa từng chạy. Trạng thái phải
 * kể đúng chuyện đã xảy ra, không thì dashboard tự sinh nhiễu.
 */
export const FLOW_DUNG: FlowKey[] = ['agy', 'kiro'];

/**
 * Trả về bản sao account đã đánh dấu chết, hoặc `null` nếu không có gì đổi.
 *
 * Trả `null` khi đã đúng trạng thái để lệnh chạy lại nhiều lần không ghi CSV vô ích và
 * không dập `last_run` — mỗi lần ghi accounts.csv là một lần đua ghi đè với tiến trình khác.
 */
export function danhDauChet(acc: Account, lyDo: string, flows: FlowKey[] = FLOW_DUNG): Account | null {
  const moi = { ...acc };
  let doi = false;
  for (const f of FLOW_KEYS) {
    const key = statusField(f);
    // Flow không dùng phải về 'new' — nếu lần chạy trước lỡ đánh dấu thì đây là chỗ gỡ.
    const dich = flows.includes(f) ? 'needs_human' : moi[key] === 'needs_human' ? 'new' : moi[key];
    if (moi[key] !== dich) {
      (moi as unknown as Record<string, string>)[key] = dich as string;
      doi = true;
    }
  }
  if (moi.note !== lyDo) {
    moi.note = lyDo;
    doi = true;
  }
  return doi ? moi : null;
}

/** "300-346" → [300..346] · "56" → [56] · "56,300-302" → [56,300,301,302] */
export function docKhoang(s: string): number[] {
  const ra: number[] = [];
  for (const phan of s.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(phan.trim());
    if (!m) throw new Error(`khoảng không hợp lệ: ${phan}`);
    const dau = Number(m[1]);
    const cuoi = m[2] ? Number(m[2]) : dau;
    if (cuoi < dau) throw new Error(`cuối < đầu: ${phan}`);
    for (let i = dau; i <= cuoi; i++) ra.push(i);
  }
  return ra;
}
