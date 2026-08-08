import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/store/index.js';
import { buildBackup, restoreBackup } from '../src/backup.js';

store.load();

test('buildBackup: shape đầy đủ', () => {
  const b = buildBackup();
  assert.equal(b.version, 3);
  assert.ok(b.settings && typeof b.settings === 'object', 'v2 phải kèm settings');
  assert.ok(b.exportedAt);
  assert.ok(Array.isArray(b.accounts) && Array.isArray(b.proxies) && Array.isArray(b.credentials));
  assert.equal(b.counts.accounts, b.accounts.length);
  assert.equal(b.counts.proxies, b.proxies.length);
  assert.equal(b.counts.credentials, b.credentials.length);
  assert.ok(b.gateway && typeof b.gateway === 'object');
  assert.ok(b.config && b.config.gateway && b.config.pacing);
});

test('restoreBackup: identity (replace) giữ nguyên counts (không mất data)', () => {
  const before = buildBackup(); // snapshot hiện tại
  const r = restoreBackup(before, { mode: 'replace' }); // phục hồi chính nó = no-op an toàn
  assert.equal(r.restored.accounts, before.accounts.length);
  assert.equal(r.restored.proxies, before.proxies.length);
  assert.equal(r.restored.credentials, before.credentials.length);
  const after = buildBackup();
  assert.equal(after.counts.accounts, before.counts.accounts);
  assert.equal(after.counts.proxies, before.counts.proxies);
  assert.equal(after.counts.credentials, before.counts.credentials);
});

test('backup KHÔNG mang sessionSecret (lộ = giả được cookie phiên dashboard)', () => {
  const b = buildBackup();
  assert.ok(!('sessionSecret' in (b.settings ?? {})), 'sessionSecret phải bị loại khỏi export');
});

test('restoreBackup: từ chối file không hợp lệ', () => {
  assert.throws(() => restoreBackup({ version: 99 }));
  assert.throws(() => restoreBackup(null));
  assert.throws(() => restoreBackup({ accounts: [] })); // thiếu version
});

test('backup v2 kèm ĐỦ trạng thái: quota + liveStatus + cooldown + combo', () => {
  const b = buildBackup();
  assert.ok(Array.isArray(b.combos), 'phải có khối combos');
  const gw = Object.values(b.gateway ?? {}) as any[];
  if (gw.length) {
    // toPersist phải mang theo trạng thái đã đồng bộ, không chỉ counter
    const keys = new Set(gw.flatMap((x) => Object.keys(x)));
    for (const k of ['enabled', 'requests', 'quota', 'liveStatus', 'cooldownUntil', 'projectId']) {
      assert.ok(keys.has(k), `gateway state thiếu "${k}" → khôi phục sẽ mất trạng thái`);
    }
    // khoá phải là dạng ghép provider:email
    assert.ok(Object.keys(b.gateway).every((k) => k.includes(':')), 'khoá gateway phải là provider:email');
  }
});

test('restoreBackup: combo được khôi phục', () => {
  const b = buildBackup();
  const fake = { ...b, combos: [{ id: '__t_combo', name: 'T', strategy: 'priority', targets: [{ model: 'agy/gemini-2.5-flash' }], enabled: true }] };
  restoreBackup(fake, { mode: 'merge' });
  const after = buildBackup();
  assert.ok(after.combos!.some((c) => c.id === '__t_combo'), 'combo phải có sau khi khôi phục');
});

describe('backup v3 — chuyển toàn bộ hệ thống giữa server', () => {
  test('mặc định KHÔNG kèm lịch sử nhưng LUÔN có api_keys', () => {
    const b = buildBackup();
    assert.equal(b.version, 3);
    // api_keys lưu dạng hash → mất là phải phát lại key cho từng người dùng.
    assert.ok(b.tables, 'v3 phải có trường tables');
    assert.ok(!('quota_history' in (b.tables ?? {})), 'lịch sử không được vào backup mặc định');
    assert.ok(!('gateway_usage' in (b.tables ?? {})), 'lịch sử không được vào backup mặc định');
  });

  test('history:true mới kèm bảng lịch sử', () => {
    const b = buildBackup({ history: true });
    const t = b.tables ?? {};
    // quota_history một mình chiếm ~71% dung lượng file, nên phải là lựa chọn.
    const hasHistory = 'quota_history' in t || 'gateway_usage' in t || 'runs' in t;
    assert.ok(hasHistory, 'history:true phải kèm ít nhất một bảng lịch sử');
  });

  test('backup kèm lịch sử NẶNG hơn hẳn — lý do tách tuỳ chọn', () => {
    const light = JSON.stringify(buildBackup()).length;
    const full = JSON.stringify(buildBackup({ history: true })).length;
    assert.ok(full >= light, 'bản đầy đủ không thể nhỏ hơn bản gọn');
  });

  test('restore chấp nhận cả v1/v2 (backup cũ) lẫn v3', () => {
    const b = buildBackup();
    for (const v of [1, 2, 3]) {
      assert.doesNotThrow(() => restoreBackup({ ...b, version: v }, { mode: 'merge' }), `v${v} phải nhận được`);
    }
    assert.throws(() => restoreBackup({ ...b, version: 99 }, { mode: 'merge' }), /không hợp lệ/);
  });

  test('bảng lạ trong file không làm hỏng restore', () => {
    // File từ bản tương lai có thể mang bảng mình chưa biết — phải bỏ qua êm.
    const b: any = buildBackup();
    b.tables = { ...(b.tables ?? {}), bang_khong_ton_tai: [{ x: 1 }] };
    assert.doesNotThrow(() => restoreBackup(b, { mode: 'merge' }));
  });
});
