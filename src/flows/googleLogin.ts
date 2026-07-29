import { RunContext } from './runner.js';
import { think, sleep, rand } from '../browser/human.js';
import {
  isSignedInByCookies,
  performGoogleLogin,
  handleSpeedbumps,
  dismissInterstitials,
} from './googleAuth.js';

export { isSignedInByCookies };

/**
 * Flow google-login đứng riêng: chỉ để thiết lập phiên Google trong profile
 * (hữu ích cho gweb). Mở accounts.google.com rồi chạy vòng lặp login chung.
 * Với provider OAuth (agy/gcli/kiro), login đã nằm TRONG luồng OAuth nên
 * KHÔNG cần chạy flow này trước.
 */
export async function googleLoginFlow(ctx: RunContext): Promise<void> {
  const { page, session } = ctx;

  ctx.log('Mở accounts.google.com');
  // goto có thể chậm khi Chrome khởi động nguội — timeout 60s + thử lại 1 lần
  try {
    await page.goto('https://accounts.google.com/?hl=en', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
  } catch {
    ctx.log('goto lần 1 chậm — thử lại', 'warn');
    await page.goto('https://accounts.google.com/?hl=en', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
  }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await think();

  if (await isSignedInByCookies(session.context)) {
    ctx.log('Profile đã có phiên Google — bỏ qua đăng nhập');
    return;
  }

  await performGoogleLogin(ctx, page);

  // Settle redirect + xử lý nốt ToS/challenge còn sót
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await sleep(rand(2000, 4000));
  await handleSpeedbumps(ctx, page);
  await ctx.guardChallenge();
  await dismissInterstitials(page);
  await sleep(rand(1000, 2000));

  if (await isSignedInByCookies(session.context)) {
    ctx.log('Đăng nhập Google thành công (cookie session có mặt)');
    return;
  }

  await ctx.guardChallenge();
  await sleep(rand(1000, 2000));
  if (await isSignedInByCookies(session.context)) {
    ctx.log('Đăng nhập Google thành công sau khi xử lý challenge');
    return;
  }

  const shot = await ctx.screenshot('login_uncertain');
  ctx.log(`Chưa xác nhận được đăng nhập. URL hiện tại: ${page.url()}`, 'warn', shot);
  throw new Error('login_not_confirmed');
}
