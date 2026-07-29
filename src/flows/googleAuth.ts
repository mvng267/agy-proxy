import { authenticator } from 'otplib';
import type { Page, BrowserContext } from 'playwright';
import { RunContext } from './runner.js';
import { humanType, humanClick, think, sleep, rand, humanScroll } from '../browser/human.js';
import { detectChallenge } from '../browser/challenge.js';

/**
 * Login Google dùng chung cho MỌI luồng — kể cả khi login diễn ra BÊN TRONG
 * link OAuth mà OmniRoute/Kiro cấp (mở authUrl -> Google hiện login -> consent).
 * Không mở accounts.google.com "mò" trừ flow google-login đứng riêng.
 */

/** Đã đăng nhập chưa — dựa vào cookie session Google (chắc hơn URL). */
export async function isSignedInByCookies(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies('https://google.com').catch(() => []);
  const names = new Set(cookies.filter((c) => c.value).map((c) => c.name));
  return names.has('SID') || names.has('__Secure-1PSID') || names.has('SAPISID');
}

/** Tìm element hiển thị đầu tiên trong danh sách selector, timeout ngắn. */
export async function firstVisible(page: Page, selectors: string[], timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
    }
    await sleep(300);
  } while (Date.now() < deadline);
  return null;
}

/** Trang Workspace ToS "Welcome to your new account" -> cuộn xuống & Accept. */
export async function handleSpeedbumps(ctx: RunContext, page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (!/\/speedbump\//i.test(page.url())) return;
    ctx.log('Trang Workspace ToS (speedbump) — cuộn xuống & Accept');
    for (let s = 0; s < 6; s++) {
      await page.mouse.wheel(0, 1200);
      await sleep(rand(250, 600));
    }
    await page.keyboard.press('End').catch(() => {});
    await humanScroll(page, rand(600, 1200)).catch(() => {});
    await sleep(rand(500, 1200));

    const btn = page
      .getByRole('button', { name: /^(accept|i agree|agree|i understand|continue|got it|ok)$/i })
      .first();
    const alt = page.getByText(/^(accept|i agree|agree)$/i).first();
    const target =
      (await btn.count()) > 0 && (await btn.isVisible().catch(() => false))
        ? btn
        : (await alt.count()) > 0 && (await alt.isVisible().catch(() => false))
          ? alt
          : null;
    if (!target) return;
    await humanClick(page, target);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await sleep(rand(1500, 3000));
  }
}

/**
 * Bấm "Not now"/"Skip" trên màn xen giữa (passkey, đơn giản hoá đăng nhập) và
 * TỪ CHỐI prompt "Sign in to Chrome? / tạo work profile" của account Workspace
 * (bấm "Use Chrome Without an Account") — tránh Chrome enroll managed profile.
 * KHÔNG bấm "Continue as ..." (đồng ý tạo profile quản lý) và KHÔNG bấm "Cancel"
 * (trên màn consent OAuth, Cancel = huỷ cả luồng).
 */
export async function dismissInterstitials(page: Page): Promise<void> {
  const labels = [
    'Use Chrome Without an Account',
    'Dùng Chrome mà không có tài khoản',
    'Not now',
    'Chưa phải bây giờ',
    'Skip',
    'Bỏ qua',
  ];
  for (const label of labels) {
    const btn = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await humanClick(page, btn);
      await think(800, 1600);
    }
  }
}

async function clickNext(page: Page, ids: string[]): Promise<void> {
  const next =
    (await firstVisible(page, ids, 4000)) ??
    page.getByRole('button', { name: /next|verify|tiếp theo|xác minh/i }).first();
  await humanClick(page, next);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}

/**
 * Vòng lặp login: xử lý email -> password -> TOTP -> ToS -> challenge trên
 * BẤT KỲ trang login nào đang hiện (dù đứng riêng hay trong luồng OAuth).
 * Dừng khi không còn input login (đã tới màn consent / đã đăng nhập).
 */
/** Chờ 1 input biến mất (page đã chuyển bước) để vòng lặp không xử lý lại. */
async function waitGone(loc: import('playwright').Locator, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await loc.isVisible().catch(() => false))) return;
    await sleep(300);
  }
}

export async function performGoogleLogin(ctx: RunContext, page: Page): Promise<void> {
  const { account } = ctx;
  let emailDone = false;
  let pwDone = false;
  let totpDone = false;

  for (let i = 0; i < 14; i++) {
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});

    // ToS speedbump
    if (/\/speedbump\//i.test(page.url())) {
      await handleSpeedbumps(ctx, page);
      continue;
    }

    // Challenge cần người (verify it's you, captcha, insecure...) — pwd không tính
    const hit = await detectChallenge(page);
    if (hit) {
      await ctx.guardChallenge();
      continue;
    }

    // Email (chỉ 1 lần)
    if (!emailDone) {
      const emailInput = await firstVisible(page, ['input[type="email"]', '#identifierId'], 3500);
      if (emailInput) {
        ctx.log('Nhập email');
        await humanType(page, emailInput, account.email);
        await think();
        await clickNext(page, ['#identifierNext button', '#identifierNext']);
        emailDone = true;
        await waitGone(emailInput); // chờ rời trang email trước khi lặp
        await think(1000, 2200);
        continue;
      }
    }

    // Password (chỉ 1 lần)
    if (!pwDone) {
      const pwInput = await firstVisible(page, ['input[type="password"]', 'input[name="Passwd"]'], 3500);
      if (pwInput) {
        if (!account.password) throw new Error('Account thiếu mật khẩu');
        ctx.log('Nhập mật khẩu');
        await humanType(page, pwInput, account.password);
        await think();
        await clickNext(page, ['#passwordNext button', '#passwordNext']);
        pwDone = true;
        await waitGone(pwInput);
        await think(1200, 2600);
        continue;
      }
    }

    // TOTP (nếu có secret, chỉ 1 lần)
    if (account.totp_secret && !totpDone) {
      const totpInput = await firstVisible(
        page,
        ['input[name="totpPin"]', 'input#totpPin', 'input[type="tel"]'],
        2500,
      );
      if (totpInput) {
        ctx.log('Màn 2FA — tự sinh mã TOTP');
        await humanType(page, totpInput, authenticator.generate(account.totp_secret.replace(/\s+/g, '')));
        await think();
        await clickNext(page, ['#totpNext button', '#totpNext']);
        totpDone = true;
        await waitGone(totpInput);
        await think(1200, 2600);
        continue;
      }
    }

    // Không còn input login -> thoát (đã tới consent hoặc đã đăng nhập)
    break;
  }

  await dismissInterstitials(page);
}
