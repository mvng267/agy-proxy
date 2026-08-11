import { RunContext } from './runner.js';
import { consentStep } from './oauthProvider.js';
import { performGoogleLogin } from './googleAuth.js';
import { think, sleep } from '../browser/human.js';
import { store } from '../store/index.js';
import { NOUS_CLIENT_ID, NOUS_SCOPE } from '../gateway/providers/nous.js';

/**
 * Nous Research — lấy refresh_token qua OAuth DEVICE-CODE, đăng nhập bằng Google.
 *
 * Vì sao device-code chứ không tự động điền form trên portal: đây là API chính thức của
 * Nous (hermes-cli dùng đúng đường này), nên không phụ thuộc DOM của trang đăng ký và
 * không phải đoán selector. Đã xác minh gọi thật 11/08/2026 — endpoint trả `user_code`,
 * `verification_uri_complete`, `expires_in: 600`, `interval: 5`.
 *
 * Luồng:
 *  1. POST /api/oauth/device/code  → device_code + link xác thực
 *  2. Mở link trong profile của account, đăng nhập Google (dùng lại performGoogleLogin)
 *  3. Bấm nút chấp thuận trên portal
 *  4. Poll POST /api/oauth/token tới khi có access_token + refresh_token
 *  5. Lưu credential target 'nous'
 */

const PORTAL = 'https://portal.nousresearch.com';

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

async function xinDeviceCode(): Promise<DeviceCode> {
  const res = await fetch(`${PORTAL}/api/oauth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: NOUS_CLIENT_ID, scope: NOUS_SCOPE }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`nous_device_code_${res.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text) as DeviceCode;
  if (!j.device_code || !j.verification_uri_complete) throw new Error('nous_device_code_thieu_field');
  return j;
}

/**
 * Hỏi Portal xem người dùng chấp thuận chưa.
 *
 * `authorization_pending` / `slow_down` là trạng thái BÌNH THƯỜNG của device-code, không
 * phải lỗi — trả null để vòng ngoài chờ tiếp. Chỉ ném khi hỏng thật (hết hạn, bị từ chối).
 */
async function hoiToken(deviceCode: string): Promise<{ accessToken: string; refreshToken: string } | null> {
  const res = await fetch(`${PORTAL}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: NOUS_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (res.ok) {
    const j = JSON.parse(text) as { access_token?: string; refresh_token?: string };
    if (!j.refresh_token) throw new Error('nous_thieu_refresh_token');
    return { accessToken: j.access_token ?? '', refreshToken: j.refresh_token };
  }
  const err = String(text).toLowerCase();
  if (err.includes('authorization_pending') || err.includes('slow_down')) return null;
  throw new Error(`nous_token_${res.status}: ${text.slice(0, 160)}`);
}

export async function nousFlow(ctx: RunContext): Promise<void> {
  const { page, account } = ctx;

  const dc = await xinDeviceCode();
  ctx.log(`Device code: ${dc.user_code} — mở ${dc.verification_uri}`);

  await page.goto(dc.verification_uri_complete, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await think(600, 1400);

  // Đăng nhập Google nếu portal chuyển sang accounts.google.com. Hàm này đã lo speedbump,
  // TOTP, chọn đúng account — không viết lại.
  if (/accounts\.google\.com/.test(page.url())) {
    ctx.log('Portal chuyển sang Google — đăng nhập');
    await performGoogleLogin(ctx, page);
  } else {
    // Portal có thể hiện nút "Sign in with Google" trước.
    const btn = page.getByRole('button', { name: /google/i }).first();
    const link = page.getByRole('link', { name: /google/i }).first();
    for (const el of [btn, link]) {
      if (await el.isVisible().catch(() => false)) {
        ctx.log('Bấm "Sign in with Google"');
        await el.click().catch(() => {});
        await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
        break;
      }
    }
    if (/accounts\.google\.com/.test(page.url())) await performGoogleLogin(ctx, page);
  }

  // Trang chấp thuận: vài vòng vì Google/portal hay chèn màn trung gian.
  for (let i = 0; i < 6; i++) {
    if (!(await consentStep(ctx, page, account.email))) break;
    await sleep(800);
  }

  /**
   * Poll tới khi người dùng (hoặc automation ở trên) chấp thuận xong.
   *
   * Tôn trọng `interval` và `expires_in` mà Portal trả về thay vì tự đặt số — Portal có
   * quyền đổi nhịp, và poll dày hơn `interval` thì nó trả `slow_down`.
   */
  const hetHan = Date.now() + Math.min(dc.expires_in, 600) * 1000;
  const nhip = Math.max(dc.interval, 3) * 1000;
  let tok: { accessToken: string; refreshToken: string } | null = null;
  while (Date.now() < hetHan) {
    tok = await hoiToken(dc.device_code);
    if (tok) break;
    // Còn chờ người dùng — thử bấm tiếp nút chấp thuận nếu trang vừa hiện thêm.
    await consentStep(ctx, page, account.email).catch(() => false);
    await sleep(nhip);
  }
  if (!tok) {
    const shot = await ctx.screenshot('nous-timeout').catch(() => undefined);
    ctx.log('Hết 10 phút chờ chấp thuận device-code', 'error', shot);
    throw new Error('nous_timeout');
  }

  ctx.log('Lấy được refresh_token Nous');
  store.upsertCredential({
    email: account.email,
    target: 'nous',
    // `provider: 'nous'` là DẤU HIỆU để parseNousCredential nhận ra — credential OpenRouter
    // cũng là JSON, không có nó thì hai provider tranh nhau account này.
    value: JSON.stringify({ provider: 'nous', refreshToken: tok.refreshToken }),
    expires_at: '',
    omniroute_connection_id: '',
    updated_at: '',
  });

  ctx.log('Nous hoàn tất — refreshToken đã lưu vào credentials.csv');
}
