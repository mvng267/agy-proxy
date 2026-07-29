import { RunContext } from './runner.js';
import { think, sleep, rand, humanScroll } from '../browser/human.js';
import { store } from '../store/index.js';
import { omniroute } from '../omniroute/client.js';

/**
 * Gemini Web (gweb): mở gemini.google.com, warm-up, rút cookie __Secure-1PSID
 * (+ __Secure-1PSIDTS) rồi tạo connection gemini-web trong OmniRoute (apiKey = chuỗi cookie).
 */
export async function geminiWebFlow(ctx: RunContext): Promise<void> {
  const { page, account, session } = ctx;

  ctx.log('Mở gemini.google.com (warm-up)');
  await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await think(1500, 3000);

  await ctx.guardChallenge();

  // Warm-up: cuộn nhẹ, đứng yên — tránh login->scrape tức thì (RULES B6)
  await humanScroll(page, rand(200, 500)).catch(() => {});
  await sleep(rand(20000, 40000));

  const cookies = await session.context.cookies('https://gemini.google.com');
  const psid = cookies.find((c) => c.name === '__Secure-1PSID');
  const psidts = cookies.find((c) => c.name === '__Secure-1PSIDTS');

  if (!psid) {
    const shot = await ctx.screenshot('gweb_no_cookie');
    ctx.log('Không tìm thấy cookie __Secure-1PSID — có thể chưa đăng nhập Google', 'error', shot);
    throw new Error('gweb_cookie_missing');
  }

  const parts = [`__Secure-1PSID=${psid.value}`];
  if (psidts) parts.push(`__Secure-1PSIDTS=${psidts.value}`);
  const cookieString = parts.join('; ');
  ctx.log(`Lấy được cookie gweb (${parts.length} cookie)`);

  // Lưu vào credentials.csv
  store.upsertCredential({
    email: account.email,
    target: 'gweb',
    value: cookieString,
    expires_at: psid.expires > 0 ? new Date(psid.expires * 1000).toISOString() : '',
    omniroute_connection_id: '',
    updated_at: '',
  });

  // Đẩy vào OmniRoute (idempotent theo tên = email)
  const name = `gweb:${account.email}`;
  const existing = await omniroute.findConnection('gemini-web', name);
  if (existing) {
    ctx.log(`Connection gemini-web đã tồn tại (${existing.id}) — xoá để cập nhật cookie mới`);
    await omniroute.deleteConnection(existing.id);
  }
  const conn = await omniroute.createConnection({
    provider: 'gemini-web',
    name,
    apiKey: cookieString,
  });
  ctx.log(`Đã tạo connection gemini-web: ${conn.id}`);

  store.upsertCredential({
    email: account.email,
    target: 'gweb',
    value: cookieString,
    expires_at: psid.expires > 0 ? new Date(psid.expires * 1000).toISOString() : '',
    omniroute_connection_id: conn.id,
    updated_at: '',
  });

  // Test connection
  try {
    await omniroute.testConnection(conn.id);
    ctx.log('Test connection gemini-web: gửi OK (xem kết quả trên OmniRoute)');
  } catch (e) {
    ctx.log(`Test connection cảnh báo: ${e instanceof Error ? e.message : e}`, 'warn');
  }
}
