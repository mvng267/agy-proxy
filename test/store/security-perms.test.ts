import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Data files chứa secret (mật khẩu account, refresh/access token, sessionSecret)
 * phải là 0600 — user khác trên máy không đọc được. Và backup export/import không
 * được mang sessionSecret: nó chỉ ký cookie phiên của MÁY NÀY, lộ ra là giả được
 * cookie đăng nhập dashboard.
 *
 * AGY_HOME trỏ thư mục tạm TRƯỚC mọi import chạm dữ liệu → không đụng dữ liệu thật.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-perms-'));
process.env.AGY_HOME = TMP_HOME;

const { DATA_DIR } = await import('../../src/paths.js');
const { store } = await import('../../src/store/index.js');
const { getSetting } = await import('../../src/store/db.js');
const { buildBackup, restoreBackup } = await import('../../src/backup.js');
const { flushPersist } = await import('../../src/gateway/pool.js');

const modeOf = (f: string) => statSync(resolve(DATA_DIR, f)).mode & 0o777;

before(() => { store.load(); });
after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('CSV account/credential ghi ra với mode 0600', () => {
  store.upsertCredential({ email: 'perm@test.local', target: 'agy', value: '1//fake-perm', updated_at: '' } as any);
  store.upsertAccount({ email: 'perm@test.local' });
  assert.equal(modeOf('credentials.csv'), 0o600, 'credentials.csv chứa refresh token');
  assert.equal(modeOf('accounts.csv'), 0o600, 'accounts.csv chứa mật khẩu + TOTP');
});

test('state.db (settings có secret) mode 0600', () => {
  assert.equal(modeOf('state.db'), 0o600);
});

test('gateway.json (access token cả pool) ghi ra với mode 0600', () => {
  flushPersist();
  assert.equal(modeOf('gateway.json'), 0o600);
});

test('backup export KHÔNG chứa sessionSecret', () => {
  assert.ok(getSetting('sessionSecret'), 'config boot phải tự sinh sessionSecret');
  const b = buildBackup();
  assert.ok(b.settings && Object.keys(b.settings).length >= 0);
  assert.ok(!('sessionSecret' in b.settings!), 'sessionSecret không được vào file export');
});

test('restore BỎ QUA sessionSecret trong file backup cũ', () => {
  const cur = getSetting('sessionSecret');
  const b = buildBackup();
  restoreBackup({ ...b, settings: { ...b.settings, sessionSecret: 'HACKED-FROM-BACKUP' } }, { mode: 'merge' });
  assert.equal(getSetting('sessionSecret'), cur, 'sessionSecret cục bộ không được bị ghi đè');
});
