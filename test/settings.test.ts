import { test, describe } from 'node:test';
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
  // `provider` bắt buộc từ migration v6 — một email có cả agy lẫn kr, không có nó thì
  // hai bản ghi đè lên nhau (xem test/store/quota-provider.test.ts).
  recordQuota({ ts: base, email: '__t1@x', provider: 'agy', tier: 'Free', geminiPct: 90, thirdPct: 100 });
  recordQuota({ ts: base + 3600_000, email: '__t1@x', provider: 'agy', tier: 'Free', geminiPct: 80, thirdPct: 100 });
  recordQuota({ ts: base, email: '__t2@x', provider: 'agy', tier: 'Free', geminiPct: 70, thirdPct: 50 });

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
  recordQuota({ ts: old, email: '__old@x', provider: 'agy', geminiPct: 50, thirdPct: 50 });
  const before = quotaForAccount('__old@x', old - 1000, old + 1000).length;
  assert.equal(before, 1);
  pruneQuotaHistory(90);
  assert.equal(quotaForAccount('__old@x', old - 1000, old + 1000).length, 0);
});

test('maxBodyMb: mặc định 32MB (Fastify mặc định 1MB là quá nhỏ cho tool coding)', () => {
  assert.ok(config.maxBodyMb >= 8, 'body limit phải đủ lớn cho prompt kèm file');
  assert.ok(CONFIG_KEYS.includes('maxBodyMb'));
  assert.ok(RESTART_KEYS.has('maxBodyMb'), 'đổi giới hạn body phải khởi động lại mới có hiệu lực');
  const old = config.maxBodyMb;
  setConfig({ maxBodyMb: 16 });
  assert.equal(config.maxBodyMb, 16);
  assert.equal(getSetting('maxBodyMb'), '16');
  setConfig({ maxBodyMb: old });
});

// ---------------------------------------------------------------------------
// G7 — validate cấu hình. Trước đây giá trị sai bị nhận IM LẶNG.
// ---------------------------------------------------------------------------

test('applyConfig: từ chối rotation không hợp lệ, KHÔNG đổi giá trị đang dùng', async () => {
  const { applyConfig, config } = await import('../src/config.js');
  const old = config.gateway.rotation;
  const r = applyConfig({ gatewayRotation: 'chien-luoc-bia' });
  assert.equal(config.gateway.rotation, old, 'giá trị cũ phải giữ nguyên');
  assert.deepEqual(r.changed, []);
  assert.equal(r.rejected[0]?.key, 'gatewayRotation');
  assert.match(r.rejected[0]!.reason, /round-robin/);
});

test('applyConfig: nhận rotation hợp lệ', async () => {
  const { applyConfig, config } = await import('../src/config.js');
  const old = config.gateway.rotation;
  try {
    const r = applyConfig({ gatewayRotation: 'highest-first' });
    assert.deepEqual(r.changed, ['gatewayRotation']);
    assert.equal(config.gateway.rotation, 'highest-first');
  } finally {
    applyConfig({ gatewayRotation: old });
  }
});

test('applyConfig: chặn số ngoài khoảng', async () => {
  const { applyConfig, config } = await import('../src/config.js');
  const old = config.port;
  assert.ok(applyConfig({ port: 0 }).rejected.length, 'port 0 phải bị chặn');
  assert.ok(applyConfig({ port: 70000 }).rejected.length, 'port > 65535 phải bị chặn');
  assert.equal(config.port, old, 'port không được đổi');
});

test('applyConfig: khoá lạ nay báo rõ thay vì im lặng', async () => {
  const { applyConfig } = await import('../src/config.js');
  const r = applyConfig({ khongTonTaiDau: 'x' });
  assert.deepEqual(r.changed, []);
  assert.equal(r.rejected[0]?.reason, 'khoá không tồn tại');
});

test('applyConfig: pacingMin > pacingMax bị báo lỗi ràng buộc liên khoá', async () => {
  const { applyConfig, config } = await import('../src/config.js');
  const min = config.pacing.minSec;
  const max = config.pacing.maxSec;
  try {
    const r = applyConfig({ pacingMinSec: 900, pacingMaxSec: 60 });
    assert.ok(r.rejected.some((x) => x.key === 'pacingMinSec'), 'phải báo min > max');
  } finally {
    applyConfig({ pacingMinSec: min, pacingMaxSec: max });
  }
});

describe('passcode 6 số', () => {
  test('chỉ nhận đúng 6 chữ số', async () => {
    const { isPasscode } = await import('../src/security.js');
    for (const ok of ['481602', '000000', '999999']) assert.equal(isPasscode(ok), true, ok);
    for (const bad of ['12345', '1234567', 'abcdef', '12 456', '', '12345a']) {
      assert.equal(isPasscode(bad), false, bad);
    }
  });

  test('chặn passcode dễ đoán — đó là mã người dò thử ĐẦU TIÊN', () => {
    // Entropy chỉ 10^6; nếu để lọt 000000/123456 thì khoá 5 lần cũng không cứu được.
    const weak = ['000000', '111111', '999999', '123456', '654321', '345678'];
    const strong = ['481602', '203948', '100001', '135790'];
    return import('../src/security.js').then(({ isWeakPasscode }) => {
      for (const w of weak) assert.equal(isWeakPasscode(w), true, `${w} phải bị coi là yếu`);
      for (const s of strong) assert.equal(isWeakPasscode(s), false, `${s} không được coi là yếu`);
    });
  });

  test('chuỗi không phải passcode thì không bị gắn nhãn yếu', async () => {
    // Người vẫn có thể đặt mật khẩu chữ dài; hàm này chỉ nói về passcode số.
    const { isWeakPasscode } = await import('../src/security.js');
    for (const s of ['matkhaudai', '12345', 'abc123def']) assert.equal(isWeakPasscode(s), false, s);
  });

  test('giới hạn 5 lần sai vẫn là mặc định — passcode phụ thuộc vào nó', async () => {
    const { config } = await import('../src/config.js');
    assert.equal(config.loginMaxFail, 5, 'bỏ khoá này thì passcode 6 số dò được trong vài giờ');
    assert.ok(config.loginLockMin > 0);
  });
});
