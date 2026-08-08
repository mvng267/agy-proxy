import { store } from '../store/index.js';
import type { Credential } from '../store/models.js';

/**
 * Token health: định kỳ (và theo yêu cầu) verify refresh_token còn sống bằng
 * cách gọi endpoint refresh. Token chết -> đánh dấu + set account 'new' để
 * Auto Run re-capture. Hằng số trùng với oauthProvider.ts / kiro.ts (nguồn thật).
 */

import { AGY_TOKEN_URL, AGY_CLIENT_ID, AGY_CLIENT_SECRET } from '../config.js';
const KIRO_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';

export type Health = 'alive' | 'dead' | 'unknown';

async function checkAgy(refreshToken: string): Promise<Health> {
  if (!refreshToken.startsWith('1//')) return 'unknown'; // marker cũ, không có token thật
  try {
    const res = await fetch(AGY_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: AGY_CLIENT_ID,
        client_secret: AGY_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15000),
    });
    // Cùng lý do với Kiro: 429/5xx là lỗi tạm, không kết luận token chết.
    if (res.status === 429 || res.status >= 500) return 'unknown';
    return res.ok ? 'alive' : 'dead';
  } catch {
    return 'unknown'; // lỗi mạng -> không kết luận
  }
}

async function checkKiro(value: string): Promise<Health> {
  let refreshToken = value;
  try {
    const j = JSON.parse(value) as { refreshToken?: string };
    if (j.refreshToken) refreshToken = j.refreshToken;
  } catch {
    /* value là chuỗi thô */
  }
  if (!refreshToken) return 'unknown';
  try {
    const res = await fetch(KIRO_REFRESH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'kiro-cli' },
      body: JSON.stringify({ refreshToken }),
      signal: AbortSignal.timeout(15000),
    });
    // KHÔNG phải mọi lỗi HTTP đều là token chết. 429/5xx là chuyện của MÁY CHỦ hoặc
    // nhịp gọi, không nói gì về token — kết luận 'dead' ở đây là ĐÁNH DẤU SAI, và tai
    // hại vì dead còn kéo theo setStatus('new') để re-capture.
    //
    // Đo thật: 299/350 credential Kiro bị đánh dead thành mảng LIÊN TỤC (thehien150–299
    // + toàn bộ lovansam), trong khi refresh thủ công từng cái đều trả HTTP 200. Dấu
    // hiệu kinh điển của rate-limit giữa chừng vòng quét, không phải token hỏng.
    if (res.status === 429 || res.status >= 500) return 'unknown';
    if (!res.ok) return 'dead';
    const d = (await res.json().catch(() => ({}))) as { accessToken?: string };
    return d.accessToken ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}

/** Kiểm 1 credential; cập nhật health + (nếu dead) set account 'new' để re-capture. */
export async function checkCredential(c: Credential): Promise<Health> {
  let h: Health = 'unknown';
  if (c.target === 'agy') h = await checkAgy(c.value);
  else if (c.target === 'kiro') h = await checkKiro(c.value);
  else return 'unknown'; // gweb: cookie, không refresh kiểu này

  store.setCredentialHealth(c.email, c.target, h);
  if (h === 'dead') {
    const flow = c.target === 'agy' ? 'agy' : 'kiro';
    store.setStatus(c.email, flow, 'new'); // để Auto Run re-capture
  }
  return h;
}

/** Kiểm toàn bộ (hoặc lọc theo target). Trả về thống kê. */
export async function checkAll(filterTarget?: string): Promise<{ alive: number; dead: number; unknown: number; total: number }> {
  const creds = store
    .listCredentials()
    .filter((c) => (c.target === 'agy' || c.target === 'kiro') && (!filterTarget || c.target === filterTarget));
  let alive = 0,
    dead = 0,
    unknown = 0;
  // Giãn nhịp: quét 700 credential bằng vòng lặp trần là bắn 700 request liên tục vào
  // cùng một endpoint auth — đúng cách để bị rate-limit, và mỗi lần bị chặn lại đánh
  // dấu nhầm một account. 60ms/lần ≈ 17 req/s, đủ chậm để không bị chặn mà quét 700
  // cái vẫn chỉ mất ~42 giây.
  const GAP_MS = 60;
  for (const c of creds) {
    const h = await checkCredential(c);
    if (h === 'alive') alive++;
    else if (h === 'dead') dead++;
    else unknown++;
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return { alive, dead, unknown, total: creds.length };
}

let healthTimer: NodeJS.Timeout | null = null;
/** Vòng lặp health định kỳ (mặc định 6h). Không chạy trùng. */
export function startHealthLoop(hours: number): void {
  if (healthTimer || hours <= 0) return;
  healthTimer = setInterval(() => {
    checkAll().catch(() => {});
  }, hours * 3600 * 1000);
  healthTimer.unref?.();
}
/** Đổi chu kỳ lúc chạy (áp nóng, không cần restart). */
export function restartHealthLoop(hours: number): void {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  startHealthLoop(hours);
}
