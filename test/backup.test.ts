import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/store/index.js';
import { buildBackup, restoreBackup } from '../src/backup.js';

store.load();

test('buildBackup: shape đầy đủ', () => {
  const b = buildBackup();
  assert.equal(b.version, 2);
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
