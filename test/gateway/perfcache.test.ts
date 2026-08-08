import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Cache đường nóng (P2): ProxyAgent memoize theo URL + combo đã parse cache theo revision.
 *
 * AGY_HOME trỏ thư mục tạm TRƯỚC mọi import chạm dữ liệu — không đụng dữ liệu người dùng.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-perfcache-'));
process.env.AGY_HOME = TMP_HOME;

const { proxyDispatcher } = await import('../../src/gateway/antigravity.js');
const { listCombos } = await import('../../src/gateway/engine.js');
const { upsertComboRow, deleteComboRow, comboRevision } = await import('../../src/store/db.js');

after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

test('proxyDispatcher: cùng URL → CÙNG instance (tái dùng kết nối, không rò agent)', () => {
  const a = proxyDispatcher('http://user:pass@127.0.0.1:8080');
  const b = proxyDispatcher('http://user:pass@127.0.0.1:8080');
  assert.ok(a, 'phải tạo được agent');
  assert.equal(a, b, 'gọi lại cùng URL phải trả đúng instance đã cache');
});

test('proxyDispatcher: URL khác → instance khác; không có URL → direct (undefined)', () => {
  const a = proxyDispatcher('http://127.0.0.1:8080');
  const b = proxyDispatcher('http://127.0.0.1:9090');
  assert.ok(a && b);
  assert.notEqual(a, b);
  assert.equal(proxyDispatcher(''), undefined);
  assert.equal(proxyDispatcher(undefined), undefined);
});

test('listCombos: không đổi combo → trả kết quả cache (cùng reference, không re-parse)', () => {
  upsertComboRow({ id: 'pc1', name: 'PC1', strategy: 'priority', targets: [{ model: 'agy/gemini-3-flash' }] });
  const first = listCombos();
  const second = listCombos();
  assert.equal(first, second, 'gọi lại khi rev không đổi phải trả đúng mảng đã cache');
  assert.ok(first.some((c) => c.id === 'pc1'));
});

test('listCombos: thấy NGAY thay đổi sau upsert/delete (revision bump)', () => {
  const rev0 = comboRevision();
  upsertComboRow({ id: 'pc2', name: 'PC2', strategy: 'priority', targets: [{ model: 'agy/gemini-3-flash' }] });
  assert.equal(comboRevision(), rev0 + 1, 'upsert phải bump revision');
  assert.ok(listCombos().some((c) => c.id === 'pc2'), 'combo mới phải hiện ngay, không chờ TTL');

  deleteComboRow('pc2');
  assert.ok(!listCombos().some((c) => c.id === 'pc2'), 'combo đã xoá phải biến mất ngay');
});

test('listCombos: parse đúng targets + enabled từ row', () => {
  upsertComboRow({
    id: 'pc3', name: 'PC3', strategy: 'weighted',
    targets: [{ model: 'agy/gemini-3-flash', weight: 2 }, { model: 'agy/claude-sonnet-4-6' }],
    enabled: false,
  });
  const c = listCombos().find((x) => x.id === 'pc3')!;
  assert.equal(c.enabled, false);
  assert.equal(c.strategy, 'weighted');
  assert.deepEqual(c.targets, [{ model: 'agy/gemini-3-flash', weight: 2 }, { model: 'agy/claude-sonnet-4-6' }]);
});
