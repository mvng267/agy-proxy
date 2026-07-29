import type { Page } from 'playwright';
import { RunContext } from './runner.js';
import { humanClick, think, sleep, rand } from '../browser/human.js';
import { performGoogleLogin } from './googleAuth.js';
import { store } from '../store/index.js';
import { omniroute } from '../omniroute/client.js';

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

/** Tiện: lặp consentStep vài lần (cho luồng không cần chờ code song song). */
export async function pickAccountAndConsent(ctx: RunContext, page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    if (!(await consentStep(ctx, page, ctx.account.email))) break;
  }
}

export function makeOAuthFlow(provider: string, target: 'agy' | 'gcli') {
  return async function oauthFlow(ctx: RunContext): Promise<void> {
    const { page, account } = ctx;

    ctx.log(`OAuth ${provider}: lấy authUrl từ OmniRoute`);
    const auth = await omniroute.oauthAuthorize(provider);
    if (!auth.authUrl) {
      throw new Error(`OmniRoute không trả authUrl cho ${provider} (flowType=${auth.flowType})`);
    }

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

    ctx.log(`Mở link OAuth ${provider} từ OmniRoute`);
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
      // Antigravity: LÀM CẢ 2. Code hiện tại (round 1) -> đăng ký OmniRoute;
      // round 2 (account đã login+grant nên nhanh) -> lấy Google refresh_token (1//...).
      let connId = '';
      try {
        ctx.log('Round 1: đăng ký vào OmniRoute (exchange)');
        await omniroute.oauthExchange(provider, {
          code: capturedCode,
          state: capturedState ?? auth.state,
          codeVerifier: auth.codeVerifier,
          redirectUri: auth.redirectUri,
        });
        const conn = await omniroute.findConnection(provider, account.email).catch(() => undefined);
        connId = conn?.id ?? '';
        ctx.log(`Đã đăng ký OmniRoute${connId ? ' (' + connId.slice(0, 8) + ')' : ''}`);
      } catch (e) {
        ctx.log(`OmniRoute exchange lỗi (vẫn lấy refresh_token): ${e instanceof Error ? e.message : e}`, 'warn');
      }

      ctx.log('Round 2: lấy refresh_token');
      const auth2 = await omniroute.oauthAuthorize(provider);
      capturedCode = null;
      const url2 = (auth2.authUrl ?? auth.authUrl) + (String(auth2.authUrl).includes('?') ? '&' : '?') + 'hl=en';
      await page.goto(url2, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await think(700, 1400);
      const dl2 = Date.now() + 90000;
      while (!capturedCode && Date.now() < dl2) {
        await ctx.guardChallenge();
        await consentStep(ctx, page, account.email).catch(() => false);
        await sleep(rand(600, 1200));
      }
      if (!capturedCode) {
        const shot = await ctx.screenshot('agy_no_code_r2');
        ctx.log('Round 2 không bắt được code', 'error', shot);
        throw new Error('antigravity_no_code_r2');
      }
      const refreshToken = await exchangeAntigravityToken(capturedCode, auth2.redirectUri);
      store.upsertCredential({
        email: account.email,
        target: 'agy',
        value: refreshToken,
        expires_at: '',
        omniroute_connection_id: connId,
        updated_at: '',
      });
      ctx.log(`Đã lưu refresh_token + OmniRoute cho ${account.email} (${refreshToken.slice(0, 8)}…)`);
      return;
    }

    ctx.log('Đã bắt được code — gọi OmniRoute exchange');
    const state = capturedState ?? auth.state;
    const result = await omniroute.oauthExchange(provider, {
      code: capturedCode,
      state,
      codeVerifier: auth.codeVerifier,
      redirectUri: auth.redirectUri,
    });
    ctx.log(`Exchange xong: ${JSON.stringify(result).slice(0, 200)}`);
    const conn = await omniroute.findConnection(provider, `${provider}:${account.email}`).catch(() => undefined);
    store.upsertCredential({
      email: account.email,
      target,
      value: 'stored_in_omniroute',
      expires_at: '',
      omniroute_connection_id: conn?.id ?? '',
      updated_at: '',
    });
    ctx.log(`OAuth ${provider} hoàn tất cho ${account.email}`);
  };
}

export const antigravityFlow = makeOAuthFlow('antigravity', 'agy');
export const geminiCliFlow = makeOAuthFlow('gemini-cli', 'gcli');
