import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSetting, getSetting, allSettings, deleteSetting, recordQuota, quotaSeries, quotaForAccount, pruneQuotaHistory, db } from '../src/store/db.js';
import { config, setConfig, getConfigValue, CONFIG_KEYS, SECRET_KEYS, RESTART_KEYS } from '../src/config.js';

test('settings: ghi/đọc/xoá trong DB', () => {
  setSetting('__test_key', 'hello');
  assert.equal(getSetting('__test_key'), 'hello');
  setSetting('__test_key', 'world'); // upsert
  assert.equal(getSetting('__test_key'), 'world');
  assert.ok('__test_key' in allSettings());
  deleteSetting('__test_key');
  assert.equal(getSetting('__test_key'), undefined);
});

test('setConfig: áp vào RAM + GHI DB (sống qua restart)', () => {
  const old = config.gateway.cooldownSec;
  const changed = setConfig({ gatewayCooldownSec: 4242 });
  assert.deepEqual(changed, ['gatewayCooldownSec']);
  assert.equal(config.gateway.cooldownSec, 4242); // RAM
  assert.equal(getSetting('gatewayCooldownSec'), '4242'); // DB → không mất khi restart
  assert.equal(getConfigValue('gatewayCooldownSec'), 4242);
  setConfig({ gatewayCooldownSec: old }); // khôi phục
});

test('setConfig: bỏ qua key lạ, nhận boolean/number', () => {
  const changed = setConfig({ khongTonTai: 'x', quotaOnCall: false });
  assert.deepEqual(changed, ['quotaOnCall']);
  assert.equal(config.gateway.quota.onCall, false);
  setConfig({ quotaOnCall: true });
});

test('metadata cấu hình: đủ key, đánh dấu secret + cần restart', () => {
  assert.ok(CONFIG_KEYS.length >= 25, 'phải quản lý >=25 thiết lập');
  for (const k of ['port', 'host', 'omnirouteUrl', 'omniroutePassword', 'gatewayApiKey', 'tokenHealthHours', 'kiroRedirectUri', 'browserChannel']) {
    assert.ok(CONFIG_KEYS.includes(k), `thiếu key ${k}`);
  }
  assert.ok(SECRET_KEYS.has('omniroutePassword') && SECRET_KEYS.has('dashboardPassword'));
  assert.ok(RESTART_KEYS.has('port') && RESTART_KEYS.has('host'));
});

test('quota_history: ghi + gộp theo ngày + lọc theo account', () => {
  const base = Date.UTC(2021, 0, 15, 10, 0, 0);
  db.prepare('DELETE FROM quota_history WHERE email LIKE ?').run('__t%');
  recordQuota({ ts: base, email: '__t1@x', tier: 'Free', geminiPct: 90, thirdPct: 100 });
  recordQuota({ ts: base + 3600_000, email: '__t1@x', tier: 'Free', geminiPct: 80, thirdPct: 100 });
  recordQuota({ ts: base, email: '__t2@x', tier: 'Free', geminiPct: 70, thirdPct: 50 });

  const points = quotaForAccount('__t1@x', base - 1000, base + 7200_000);
  assert.equal(points.length, 2);
  assert.equal(points[0]!.gemini_pct, 90);

  const series = quotaSeries(base - 1000, base + 7200_000, 'day');
  assert.ok(series.length >= 1);
  assert.ok(series[0]!.n >= 3, 'gộp đủ 3 bản ghi');
  db.prepare('DELETE FROM quota_history WHERE email LIKE ?').run('__t%');
});

test('pruneQuotaHistory: xoá dòng cũ hơn N ngày', () => {
  const old = Date.now() - 200 * 86400_000; // 200 ngày trước
  recordQuota({ ts: old, email: '__old@x', geminiPct: 50, thirdPct: 50 });
  const before = quotaForAccount('__old@x', old - 1000, old + 1000).length;
  assert.equal(before, 1);
  pruneQuotaHistory(90);
  assert.equal(quotaForAccount('__old@x', old - 1000, old + 1000).length, 0);
});
