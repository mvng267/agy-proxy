import { chromium, type BrowserContext, type Page } from 'playwright';
import { FingerprintInjector } from 'fingerprint-injector';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PROFILES_DIR, config } from '../config.js';
import type { Account, Proxy } from '../store/models.js';
import { getFingerprint } from './fingerprint.js';
import { geoForCountry } from './geo.js';

/**
 * Mở 1 profile Chrome thật, cố định cho mỗi account (xem RULES mục A).
 * KHÔNG stealth-patch fingerprint — chỉ giấu cờ automation lộ liễu và dùng
 * Chrome thật + proxy sticky + fingerprint ghim cố định theo account.
 */

export interface Session {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

function proxyToPlaywright(p: Proxy | undefined) {
  if (!p) return undefined;
  return {
    server: `http://${p.host}:${p.port}`,
    username: p.username || undefined,
    password: p.password || undefined,
  };
}

export async function openProfile(
  account: Account,
  proxy?: Proxy,
  headless: boolean = config.headless,
): Promise<Session> {
  const userDataDir = resolve(PROFILES_DIR, account.profile_dir);
  mkdirSync(userDataDir, { recursive: true });

  // Geo coherent theo quốc gia proxy (IP ↔ tz ↔ locale ↔ ngôn ngữ). Không có
  // proxy/country -> fallback tz/locale ghim của account.
  const geo = geoForCountry(proxy?.country);
  const locale = geo?.locale || account.locale || 'en-US';
  const timezoneId = geo?.timezoneId || account.tz || 'Asia/Ho_Chi_Minh';

  // Fingerprint riêng/account (macOS Chrome coherent), locale khớp geo.
  const fp = config.fingerprint ? getFingerprint(account, locale) : undefined;
  const nav = fp?.fingerprint.navigator;
  const scr = fp?.fingerprint.screen;

  // Channel qua env: 'chrome' (mặc định, host macOS — Chrome thật) hoặc 'bundled'
  // (Docker/Linux ARM64 — Chromium Playwright, vì Google Chrome không có bản arm64).
  const browserChannel = config.browserChannel || 'chrome';
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(browserChannel && browserChannel !== 'bundled' ? { channel: browserChannel } : {}),
    headless,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=IsolateOrigins,site-per-process',
      // Trong container (chạy root): cần no-sandbox + tránh /dev/shm nhỏ.
      ...(config.chromeNoSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ],
    proxy: proxyToPlaywright(proxy),
    userAgent: nav?.userAgent, // khớp fingerprint (vẫn là macOS Chrome)
    viewport: scr ? { width: scr.innerWidth || 1440, height: scr.innerHeight || 900 } : null,
    locale,
    timezoneId,
    geolocation: geo?.geolocation,
    acceptDownloads: false,
  });

  if (fp) {
    // Inject toàn bộ fingerprint (navigator/screen/canvas/WebGL/audio/fonts +
    // ẩn webdriver) một cách coherent.
    await new FingerprintInjector().attachFingerprintToPlaywright(context, fp);
  } else {
    await context.addInitScript(() => {
      // @ts-expect-error runtime
      if (navigator.webdriver) Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }

  const page = context.pages()[0] ?? (await context.newPage());

  const close = async () => {
    await context.close().catch(() => {});
  };

  return { context, page, close };
}
