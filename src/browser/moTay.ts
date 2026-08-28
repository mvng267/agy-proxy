import type { BrowserContext } from 'playwright';
import type { Account, Proxy } from '../store/models.js';
import { store } from '../store/index.js';
import { openProfile } from './profile.js';
import { logger } from '../lib/logger.js';

/**
 * Mở profile Chrome của một account lên màn hình để thao tác tay.
 *
 * Vì sao cần: khi login fail, ba nguyên nhân hay gặp (tài khoản bị xoá, profile hỏng,
 * Google chặn) trông giống hệt nhau trong log — phải nhìn màn hình mới phân biệt được.
 * Trước đây chỉ có ảnh chụp tĩnh lúc fail; giờ mở được đúng profile ấy để bấm tay,
 * nhập captcha, xác minh 2 bước, hay xem Google đang nói gì.
 *
 * Khác `openProfile()` trong flow: KHÔNG đóng context sau khi xong. Cửa sổ sống tới khi
 * người dùng tự tắt hoặc gọi `dongPhien()`, vì mục đích là để thao tác tay.
 */

interface Phien {
  context: BrowserContext;
  moLuc: number;
}

/** Mỗi account tối đa một cửa sổ — bấm hai lần không mở hai cửa sổ tranh nhau profile. */
const dangMo = new Map<string, Phien>();

export interface KetQuaMo {
  ok: boolean;
  loi?: string;
  daMoTruoc?: boolean;
}

/**
 * Các phụ thuộc ngoài, tiêm được để test không phải mở Chrome thật.
 *
 * `node:test` ở dự án này không bật `mock.module` (cần flag experimental), nên tiêm qua
 * tham số là cách duy nhất kiểm được logic một-cửa-sổ-mỗi-account mà không tốn 5 giây
 * khởi động trình duyệt cho mỗi phép thử.
 */
export interface PhuThuoc {
  layAccount: (email: string) => Account | undefined;
  layProxy: (label: string) => Proxy | undefined;
  mo: (acc: Account, proxy?: Proxy) => Promise<{ context: BrowserContext }>;
  coManHinh: () => boolean;
}

const MAC_DINH: PhuThuoc = {
  layAccount: (email) => store.getAccount(email),
  layProxy: (label) => store.getProxy(label),
  // headless=false: đây là cả mục đích của hàm này.
  mo: (acc, proxy) => openProfile(acc, proxy, false),
  coManHinh,
};

/**
 * Chrome chỉ mở được khi có màn hình. Trên server Debian (systemd, không X11) sẽ ném lỗi
 * khó hiểu ở tầng Playwright, nên chặn sớm và nói thẳng lý do.
 */
function coManHinh(): boolean {
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export function dsPhienMo(): Array<{ email: string; moLuc: number }> {
  return [...dangMo.entries()].map(([email, p]) => ({ email, moLuc: p.moLuc }));
}

export async function moProfile(email: string, pt: PhuThuoc = MAC_DINH): Promise<KetQuaMo> {
  const cu = dangMo.get(email);
  if (cu) return { ok: true, daMoTruoc: true };

  if (!pt.coManHinh()) {
    return {
      ok: false,
      loi: 'Máy chủ không có màn hình (thiếu DISPLAY) — chỉ mở được trên máy có giao diện.',
    };
  }

  const acc = pt.layAccount(email);
  if (!acc) return { ok: false, loi: `không có account ${email}` };

  const proxy = acc.proxy ? pt.layProxy(acc.proxy) : undefined;

  try {
    const { context } = await pt.mo(acc, proxy);
    dangMo.set(email, { context, moLuc: Date.now() });

    // Người dùng tự tắt cửa sổ thì phải xoá khỏi map, không thì lần bấm sau tưởng
    // vẫn mở và không mở lại nữa.
    context.on('close', () => dangMo.delete(email));

    logger.info(`mở profile tay: ${email}`);
    return { ok: true };
  } catch (e) {
    const loi = e instanceof Error ? e.message : String(e);
    logger.warn(`mở profile tay hỏng: ${email} — ${loi}`);
    return { ok: false, loi };
  }
}

export async function dongPhien(email: string): Promise<boolean> {
  const p = dangMo.get(email);
  if (!p) return false;
  dangMo.delete(email);
  await p.context.close().catch(() => {});
  return true;
}
