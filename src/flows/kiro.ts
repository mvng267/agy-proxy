import { createHash, randomBytes } from 'node:crypto';
import { RunContext } from './runner.js';
import { consentStep } from './oauthProvider.js';
import { performGoogleLogin } from './googleAuth.js';
import { think, sleep, rand } from '../browser/human.js';
import { store } from '../store/index.js';
import { config } from '../config.js';

/**
 * Kiro social auth (Google) — PKCE tự chạy để LẤY REFRESH TOKEN trực tiếp.
 * Hằng số lấy từ OmniRoute KIRO_CONFIG + reference AIClient2API (đã xác minh):
 *   login:   https://prod.us-east-1.auth.desktop.kiro.dev/login?idp=Google&redirect_uri=..&code_challenge=..&code_challenge_method=S256&state=..
 *   token:   POST https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token  {code, code_verifier, redirect_uri}
 *   refresh: POST https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken {refreshToken}
 *
 * Ta intercept redirect (không bind port thật) nên KHÔNG bị kẹt port 49153 —
 * nhiều account vẫn chạy tuần tự qua scheduler.
 */

const KIRO = {
  loginUrl: 'https://prod.us-east-1.auth.desktop.kiro.dev/login',
  tokenUrl: 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token',
  refreshUrl: 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken',
  // redirect_uri kiểu localhost mà Kiro IDE dùng; ta chỉ intercept, không mở port.
  get redirectUri(): string {
    return config.kiroRedirectUri || 'http://localhost:49153/oauth/callback';
  },
  region: 'us-east-1',
};

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}
function genVerifier(): string {
  return b64url(randomBytes(32));
}
function challenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

export interface KiroTokens {
  accessToken?: string;
  refreshToken?: string;
  profileArn?: string;
  expiresIn?: number;
  region: string;
}

export async function kiroFlow(ctx: RunContext): Promise<void> {
  const { page, account } = ctx;

  const codeVerifier = genVerifier();
  const codeChallenge = challenge(codeVerifier);
  const state = b64url(randomBytes(16));

  const authUrl =
    `${KIRO.loginUrl}?idp=Google` +
    `&redirect_uri=${encodeURIComponent(KIRO.redirectUri)}` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256` +
    `&state=${state}`;

  // Intercept redirect callback (không bind port thật)
  const redirect = new URL(KIRO.redirectUri);
  let code: string | null = null;
  let returnedState: string | null = null;
  // Hàm matcher (không glob) — code có thể chứa '/'.
  await page.route(
    (u) => u.host === redirect.host && u.pathname === redirect.pathname,
    async (route) => {
      const u = new URL(route.request().url());
      code = u.searchParams.get('code');
      returnedState = u.searchParams.get('state');
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><h2>Kiro: đã nhận code. Có thể đóng cửa sổ.</h2></body></html>',
      });
    },
  );

  ctx.log('Mở link Kiro login (kiro.dev, idp=Google)');
  await page.goto(authUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await think(1000, 2200);

  // Login Google ngay trong luồng Kiro (nếu chưa có phiên) rồi consent
  await performGoogleLogin(ctx, page);

  const deadline = Date.now() + 90000;
  while (!code && Date.now() < deadline) {
    await ctx.guardChallenge();
    await consentStep(ctx, page, account.email).catch(() => false);
    await sleep(rand(700, 1400));
  }

  if (!code) {
    const shot = await ctx.screenshot('kiro_no_code');
    ctx.log('Không bắt được code Kiro sau consent', 'error', shot);
    throw new Error('kiro_no_code');
  }
  if (returnedState && returnedState !== state) {
    ctx.log('Cảnh báo: state Kiro không khớp', 'warn');
  }

  ctx.log('Đổi code lấy refreshToken (POST /oauth/token)');
  const res = await fetch(KIRO.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'kiro-cli' },
    body: JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: KIRO.redirectUri }),
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.log(`Token exchange Kiro lỗi ${res.status}: ${text.slice(0, 200)}`, 'error');
    throw new Error(`kiro_token_exchange_${res.status}`);
  }
  const data = JSON.parse(text) as KiroTokens;
  if (!data.refreshToken) throw new Error('kiro_no_refresh_token');

  ctx.log(`Lấy được refreshToken Kiro (profileArn=${data.profileArn ?? 'n/a'})`);

  const payload = JSON.stringify({
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    profileArn: data.profileArn,
    region: KIRO.region,
    authMethod: 'social',
    expiresAt: data.expiresIn
      ? new Date(Date.now() + data.expiresIn * 1000).toISOString()
      : '',
  });

  store.upsertCredential({
    email: account.email,
    target: 'kiro',
    value: payload,
    expires_at: data.expiresIn ? new Date(Date.now() + data.expiresIn * 1000).toISOString() : '',
    omniroute_connection_id: '',
    updated_at: '',
  });


  ctx.log('Kiro hoàn tất — refreshToken đã lưu vào credentials.csv');
}
