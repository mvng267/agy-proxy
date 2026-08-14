import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { RunContext } from './runner.js';
import { humanClick, think, sleep, rand } from '../browser/human.js';
import { performGoogleLogin } from './googleAuth.js';
import { store } from '../store/index.js';

/**
 * Flow OAuth authorization-code dùng chung cho antigravity & gemini-cli.
 *  1. OmniRoute cấp authUrl (Google consent) + state + codeVerifier.
 *  2. Mở authUrl trong profile -> tự chọn account đúng email + bấm Allow/Continue.
 *  3. INTERCEPT redirect về localhost:8080/callback để rút `code` (không cần mở port).
 *  4. Gọi OmniRoute /exchange {code, state, codeVerifier} -> OmniRoute tự lưu token.
 */

// Antigravity OAuth (client public + secret mặc định — installed app, không PKCE).
// Dùng để TỰ exchange code lấy Google refresh_token (1//...) cho antigravity manager.
import { AGY_TOKEN_URL, AGY_CLIENT_ID, AGY_CLIENT_SECRET } from '../config.js';

async function exchangeAntigravityToken(code: string, redirectUri: string): Promise<string> {
  const res = await fetch(AGY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: AGY_CLIENT_ID,
      client_secret: AGY_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text) as { refresh_token?: string };
  if (!j.refresh_token) throw new Error('không có refresh_token trong response');
  return j.refresh_token;
}

/**
 * Scope khớp ĐÚNG những gì OmniRoute cấp (đọc từ connection.scope của account thật):
 * cloud-platform + userinfo.email/profile + experimentsandconfigs + cclog + openid.
 * 3 scope đầu là đủ để gateway chạy (đã kiểm: refresh + discoverProject + gọi model OK),
 * nhưng xin đủ bộ để token giống hệt bản OmniRoute cấp, tránh lệch về sau.
 */
const AGY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/cclog',
  'openid',
].join(' ');

/**
 * Tự dựng authUrl Google khi OmniRoute không phản hồi.
 *
 * OmniRoute chỉ là NƠI NHẬN (một chiều): thiếu nó ta vẫn phải lấy được refresh_token,
 * vì `exchangeAntigravityToken` gọi thẳng Google chứ không qua OmniRoute. Trước đây
 * `oauthAuthorize` là bước đầu tiên nên OmniRoute chết là cả luồng chết ngay
 * ("fetch failed"), không harvest được token nào.
 */
function localAuthUrl(): { authUrl: string; state: string; codeVerifier: string; redirectUri: string; flowType: string } {
  const state = randomUUID().replace(/-/g, '');
  const redirectUri = 'http://localhost:8080/callback';
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', AGY_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', AGY_SCOPES);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent'); // buộc trả refresh_token kể cả khi đã grant
  u.searchParams.set('state', state);
  return { authUrl: u.toString(), state, codeVerifier: '', redirectUri, flowType: 'local' };
}

/** Lấy authUrl: ưu tiên OmniRoute, hỏng thì tự dựng (chỉ dùng được cho target agy). */
async function getAuthUrl(
  provider: string,
  target: string,
  ctx: RunContext,
): Promise<{ authUrl: string; state: string; codeVerifier: string; redirectUri: string; flowType: string }> {
  /**
   * Tự dựng authUrl — KHÔNG qua OmniRoute nữa.
   *
   * `agy` dùng chung client_id + endpoint Google với Antigravity CLI nên tự dựng vẫn lấy
   * được refresh_token thật (đã kiểm chứng: refresh + discoverProject + gọi model đều OK),
   * và đó là đường DUY NHẤT chạy suốt từ 10/08 vì OmniRoute báo 401 mọi lần khởi động.
   *
   * `gcli` dùng client/scope khác hẳn nên không tự dựng thay được — flow đó đã ngừng dùng
   * (chưa chạy lần nào trên production, không có trong PIPELINE).
   */
  if (target === 'gcli') {
    throw new Error('flow gemini-cli đã ngừng dùng (cần OmniRoute, mà tích hợp đó đã gỡ)');
  }
  ctx.log('Tự dựng authUrl (không qua OmniRoute)');
  return localAuthUrl();
}

const CONFIRM =
  /^(continue|allow|sign in|confirm|next|agree|yes|tiếp tục|cho phép|đăng nhập|xác nhận|đồng ý|có)$/i;

async function visibleClick(page: Page, loc: import('playwright').Locator): Promise<boolean> {
  if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
    await humanClick(page, loc);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Một BƯỚC consent: làm tối đa 1 hành động nếu có (chọn account / Advanced /
 * bấm nút xác nhận). Trả về true nếu đã làm gì đó. Gọi lặp để đi qua nhiều màn
 * (account chooser -> "Make sure you downloaded this app" -> scopes -> redirect).
 */
export async function consentStep(ctx: RunContext, page: Page, email: string): Promise<boolean> {
  const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();

  // 1) "Google hasn't verified this app" -> Advanced -> Go to (ưu tiên vì có link riêng)
  if (bodyText.includes("hasn't verified") || bodyText.includes('not verified') || bodyText.includes('unsafe')) {
    const advanced = page.getByText(/advanced/i).first();
    if (await visibleClick(page, advanced)) {
      ctx.log('Màn "app chưa xác minh" — Advanced', 'warn');
      await think(500, 1200);
      await visibleClick(page, page.getByRole('link', { name: /go to|continue to/i }).first());
      return true;
    }
  }

  // 2) Nút xác nhận (Sign in / Continue / Allow…) — ƯU TIÊN hơn account chip,
  //    vì màn "Make sure you downloaded this app" cũng hiện account chip.
  if (await visibleClick(page, page.getByRole('button', { name: CONFIRM }).first())) {
    ctx.log('Bấm nút xác nhận consent');
    await think(700, 1500);
    return true;
  }
  if (await visibleClick(page, page.getByRole('link', { name: CONFIRM }).first())) {
    ctx.log('Bấm link xác nhận consent');
    await think(700, 1500);
    return true;
  }

  // 3) Account chooser (chỉ khi KHÔNG có nút xác nhận -> đúng là trang chọn account)
  const chooser = page.locator(`[data-identifier="${email}"], div[data-email="${email}"]`).first();
  if (await visibleClick(page, chooser)) {
    ctx.log('Chọn account trong account chooser');
    await think(900, 1800);
    return true;
  }

  return false;
}

// ĐÃ GỠ `pickAccountAndConsent()` — 0 caller; `makeOAuthFlow` tự lặp `consentStep`.

export function makeOAuthFlow(provider: string, target: 'agy' | 'gcli') {
  return async function oauthFlow(ctx: RunContext): Promise<void> {
    const { page, account } = ctx;

    ctx.log(`OAuth ${provider}: lấy authUrl`);
    const auth = await getAuthUrl(provider, target, ctx);

    // Intercept redirect callback để rút code (redirect_uri nằm trong container:8080)
    const redirect = new URL(auth.redirectUri);
    let capturedCode: string | null = null;
    let capturedState: string | null = null;

    // Dùng HÀM matcher (không phải glob) vì code của Google chứa '/' (vd 4/0A...)
    // khiến glob '*' không khớp được phần query.
    await page.route(
      (u) => u.host === redirect.host && u.pathname === redirect.pathname,
      async (route) => {
        const u = new URL(route.request().url());
        capturedCode = u.searchParams.get('code');
        capturedState = u.searchParams.get('state');
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<html><body><h2>Đã nhận code. Có thể đóng cửa sổ.</h2></body></html>',
        });
      },
    );

    // Ép giao diện tiếng Anh cho consent (matcher ổn định)
    const authUrlEn = auth.authUrl.includes('hl=')
      ? auth.authUrl
      : auth.authUrl + (auth.authUrl.includes('?') ? '&' : '?') + 'hl=en';

    ctx.log(`Mở link OAuth ${provider}`);
    await page.goto(authUrlEn, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await think(1000, 2200);

    // Login NGAY trong luồng OAuth nếu Google hiện màn đăng nhập (chưa có phiên).
    // Nếu đã đăng nhập, vòng lặp thoát ngay và sang bước chọn account + consent.
    await performGoogleLogin(ctx, page);

    // Vòng lặp: vừa chờ code intercept vừa liên tục bấm consent qua nhiều màn
    // (chooser -> "Make sure you downloaded this app" -> scopes -> redirect).
    const deadline = Date.now() + 90000;
    while (!capturedCode && Date.now() < deadline) {
      await ctx.guardChallenge();
      await consentStep(ctx, page, account.email).catch(() => false);
      await sleep(rand(700, 1400));
    }

    if (!capturedCode) {
      const shot = await ctx.screenshot(`${target}_no_code`);
      ctx.log('Không bắt được authorization code sau consent', 'error', shot);
      throw new Error(`${provider}_no_code`);
    }

    if (target === 'agy') {
      /**
       * MỘT vòng là đủ: đổi code lấy refresh_token Google.
       *
       * Bản trước làm HAI vòng — vòng 1 đăng ký vào OmniRoute, vòng 2 mới lấy token. Bỏ
       * vòng 1 cùng lúc gỡ OmniRoute: nó tốn thêm một lượt đăng nhập Google cho mỗi
       * account (tăng rủi ro checkpoint) mà kết quả không ai dùng.
       */
      const refreshToken = await exchangeAntigravityToken(capturedCode, auth.redirectUri);
      store.upsertCredential({
        email: account.email,
        target: 'agy',
        value: refreshToken,
        expires_at: '',
        // Cột giữ lại cho accounts.csv cũ đọc được; không còn ghi giá trị vào nữa.
        omniroute_connection_id: '',
        updated_at: '',
      });
      ctx.log(`Đã lưu refresh_token cho ${account.email} (${refreshToken.slice(0, 8)}…)`);
      return;
    }


    /**
     * Tới đây nghĩa là target KHÔNG phải 'agy' — chỉ còn 'gcli', mà flow đó cần OmniRoute
     * để đổi code (client/scope khác hẳn, không tự dựng thay được). Tích hợp OmniRoute đã
     * gỡ nên chặn ngay từ `getAuthUrl`; nhánh này không bao giờ chạy tới.
     */
    throw new Error(`flow ${provider} đã ngừng dùng — cần OmniRoute, mà tích hợp đó đã gỡ`);
  };
}

export const antigravityFlow = makeOAuthFlow('antigravity', 'agy');
export const geminiCliFlow = makeOAuthFlow('gemini-cli', 'gcli');
