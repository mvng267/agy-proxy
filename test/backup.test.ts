import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store } from '../src/store/index.js';
import { buildBackup, restoreBackup } from '../src/backup.js';

store.load();

test('buildBackup: shape đầy đủ', () => {
  const b = buildBackup();
  assert.equal(b.version, 1);
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

test('restoreBackup: từ chối file không hợp lệ', () => {
  assert.throws(() => restoreBackup({ version: 99 }));
  assert.throws(() => restoreBackup(null));
  assert.throws(() => restoreBackup({ accounts: [] })); // thiếu version
});
