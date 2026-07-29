import type { Page } from 'playwright';

/**
 * Nhận diện màn hình challenge của Google (xem RULES mục C).
 * Khi gặp -> flow chuyển paused_needs_human để người xử lý tay.
 */

export type ChallengeKind =
  | 'password_reprompt'
  | 'verify_its_you'
  | 'two_factor'
  | 'insecure_browser'
  | 'captcha'
  | 'add_recovery'
  | 'rejected'
  | 'unknown_blocker';

export interface ChallengeHit {
  kind: ChallengeKind;
  detail: string;
}

const TEXT_SIGNALS: { kind: ChallengeKind; needles: string[] }[] = [
  { kind: 'insecure_browser', needles: ['this browser or app may not be secure', "couldn't sign you in"] },
  { kind: 'two_factor', needles: ['2-step verification', 'enter the code', 'get a verification code', 'verification code', 'authenticator'] },
  { kind: 'verify_its_you', needles: ["verify it's you", 'confirm your recovery', 'confirm it’s you', 'confirm it\'s you'] },
  { kind: 'captcha', needles: ["i'm not a robot", 'type the text', 'confirm you’re not a robot', "confirm you're not a robot"] },
  { kind: 'add_recovery', needles: ['add recovery', 'protect your account', 'add phone', 'recovery email'] },
  { kind: 'rejected', needles: ['sign-in was blocked', 'account has been disabled', 'access blocked'] },
];

/** Trả về challenge nếu trang hiện tại đang chặn tiến trình, ngược lại null. */
export async function detectChallenge(page: Page): Promise<ChallengeHit | null> {
  const url = page.url();

  if (/\/signin\/rejected|deniedsigninrejected|disabled\/explanation/i.test(url)) {
    return { kind: 'rejected', detail: `url=${url}` };
  }

  // recaptcha iframe
  const hasCaptcha = await page
    .locator('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]')
    .count()
    .catch(() => 0);
  if (hasCaptcha > 0) return { kind: 'captcha', detail: 'recaptcha iframe' };

  let body = '';
  try {
    body = (await page.locator('body').innerText({ timeout: 3000 })).toLowerCase();
  } catch {
    body = '';
  }

  for (const sig of TEXT_SIGNALS) {
    for (const n of sig.needles) {
      if (body.includes(n)) return { kind: sig.kind, detail: n };
    }
  }

  // Google v3 để trang nhập mật khẩu ở /signin/challenge/pwd — KHÔNG phải blocker.
  // Chỉ coi là blocker khi challenge type không nằm trong tập "flow tự xử lý được".
  const m = url.match(/\/signin\/(?:v\d+\/)?challenge\/([a-zA-Z0-9_-]+)/i);
  if (m) {
    const type = (m[1] ?? '').toLowerCase();
    const benign = ['pwd', 'p-pwd', 'password']; // trang mật khẩu bình thường
    if (benign.includes(type)) return null;
    // totp có secret thì flow tự điền (chạy trước guard); nếu tới đây nghĩa là cần người
    return { kind: 'unknown_blocker', detail: `challenge/${type} url=${url}` };
  }

  return null;
}

/** Đã đăng nhập Google thành công? */
export async function isGoogleLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();
  if (/myaccount\.google\.com/i.test(url)) return true;
  // trang account chọn dịch vụ, hoặc đã rời khỏi luồng signin
  if (/accounts\.google\.com\/(b\/0\/)?ManageAccount/i.test(url)) return true;
  return false;
}
