#!/usr/bin/env node
/**
 * UI audit: login rồi chụp screenshot mọi tab dashboard ở desktop (1440) + mobile (390),
 * đồng thời gom console error / pageerror / API request lỗi cho từng màn.
 *
 * Dùng:  AGY_PASS=... node scripts/ui-audit.mjs [baseUrl] [outDir]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:7788';
const OUT = resolve(process.argv[3] || '/tmp/agy-shots');
const PASS = process.env.AGY_PASS || '';

const TABS = [
  { tab: 'overview', path: '/' },
  { tab: 'accounts', path: '/accounts' },
  { tab: 'proxies', path: '/proxies' },
  { tab: 'agy', path: '/agy' },
  { tab: 'models', path: '/models' },
  { tab: 'combo', path: '/combo' },
  { tab: 'quota', path: '/quota' },
  { tab: 'keys', path: '/keys' },
  { tab: 'usage', path: '/usage' },
  { tab: 'chat', path: '/chat' },
  { tab: 'gwlog', path: '/gwlog' },
  { tab: 'settings', path: '/settings' },
  { tab: 'connections', path: '/connections' },
  { tab: 'tools', path: '/tools' },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

mkdirSync(OUT, { recursive: true });
const report = [];

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL === 'bundled' ? undefined : 'chrome' });

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();

  const issues = { consoleErrors: [], pageErrors: [], badRequests: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') issues.consoleErrors.push(m.text().slice(0, 500));
  });
  page.on('pageerror', (e) => issues.pageErrors.push(String(e).slice(0, 500)));
  page.on('response', (r) => {
    if (r.status() >= 400) issues.badRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  const drain = (screen) => {
    const snap = {
      screen: `${vp.name}/${screen}`,
      consoleErrors: [...issues.consoleErrors],
      pageErrors: [...issues.pageErrors],
      badRequests: [...issues.badRequests],
    };
    issues.consoleErrors.length = 0;
    issues.pageErrors.length = 0;
    issues.badRequests.length = 0;
    if (snap.consoleErrors.length || snap.pageErrors.length || snap.badRequests.length) report.push(snap);
    return snap;
  };

  // ── Màn login ──
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/${vp.name}-00-login.png`, fullPage: true });
  drain('login');

  await page.fill('#pass', PASS);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 10000 }),
    page.click('#btn'),
  ]);
  drain('login-submit');

  // ── Từng tab ──
  for (const [i, t] of TABS.entries()) {
    await page.goto(`${BASE}${t.path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200); // chờ query + chart vẽ xong
    const n = String(i + 1).padStart(2, '0');
    await page.screenshot({ path: `${OUT}/${vp.name}-${n}-${t.tab}.png`, fullPage: true });
    drain(t.tab);
  }

  await ctx.close();
}

await browser.close();
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`Đã chụp xong → ${OUT}`);
for (const r of report) {
  console.log(`\n■ ${r.screen}`);
  for (const e of r.pageErrors) console.log(`  pageerror: ${e}`);
  for (const e of r.consoleErrors) console.log(`  console: ${e}`);
  for (const e of r.badRequests) console.log(`  http: ${e}`);
}
