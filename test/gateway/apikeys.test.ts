import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../src/config.js';
import { db } from '../../src/store/db.js';
import {
  resolveApiKey, createApiKey, removeApiKey, patchApiKey, listPublicApiKeys, clearApiKeyCache,
} from '../../src/gateway/apikeys.js';

/**
 * Test dùng DB THẬT (~/.agyproxy/data/state.db) — mọi key tạo ra đều có tên bắt đầu
 * bằng TEST_PREFIX và được dọn sạch ở before/after để không đụng dữ liệu thật.
 */
const TEST_PREFIX = '__test_key_';
const savedLegacy = config.gateway.apiKey;

function cleanup() {
  db.prepare(`DELETE FROM api_keys WHERE name LIKE ?`).run(TEST_PREFIX + '%');
  clearApiKeyCache();
}

before(cleanup);
after(() => {
  cleanup();
  config.gateway.apiKey = savedLegacy;
});

test('key hợp lệ resolve đúng id và tên; sai 1 ký tự → null', () => {
  config.gateway.apiKey = 'legacy-abc';
  const c = createApiKey(TEST_PREFIX + 'a');
  try {
    const ok = resolveApiKey(c.key);
    assert.equal(ok?.keyId, c.id);
    assert.equal(ok?.keyName, TEST_PREFIX + 'a');

    // Đổi ký tự CUỐI: prefix vẫn khớp nên vào tới bước so hash — đúng nhánh cần kiểm.
    const bad = c.key.slice(0, -1) + (c.key.endsWith('x') ? 'y' : 'x');
    assert.equal(resolveApiKey(bad), null);
  } finally {
    removeApiKey(c.id);
  }
});

test('key bị tắt (enabled=0) → null ngay, không đợi TTL cache', () => {
  config.gateway.apiKey = 'legacy-abc';
  const c = createApiKey(TEST_PREFIX + 'b');
  try {
    assert.ok(resolveApiKey(c.key), 'trước khi tắt phải hợp lệ');
    patchApiKey(c.id, { enabled: false });
    assert.equal(resolveApiKey(c.key), null, 'thu hồi phải có hiệu lực ngay');
  } finally {
    removeApiKey(c.id);
  }
});

test('key đã xoá → null', () => {
  config.gateway.apiKey = 'legacy-abc';
  const c = createApiKey(TEST_PREFIX + 'c');
  assert.ok(resolveApiKey(c.key));
  removeApiKey(c.id);
  assert.equal(resolveApiKey(c.key), null);
});

test('TƯƠNG THÍCH NGƯỢC: GATEWAY_API_KEY cũ vẫn hợp lệ khi đã có key mới', () => {
  config.gateway.apiKey = 'legacy-abc';
  const c = createApiKey(TEST_PREFIX + 'd');
  try {
    const ctx = resolveApiKey('legacy-abc');
    assert.equal(ctx?.keyId, 'legacy', 'key cũ phải sống — Hermes/Claude Code đang dùng');
  } finally {
    removeApiKey(c.id);
  }
});

test('HÀNH VI CŨ: chưa cấu hình key nào → cho qua (không chặn deploy hiện có)', () => {
  // DB thật có thể đang chứa key của client production → tạm ẩn để dựng đúng tình huống
  // "cài mới, chưa cấu hình gì", rồi trả lại nguyên trạng.
  const live = db.prepare(`SELECT id, enabled FROM api_keys WHERE enabled = 1`).all() as Array<{ id: string }>;
  db.prepare(`UPDATE api_keys SET enabled = 0 WHERE enabled = 1`).run();
  clearApiKeyCache();
  config.gateway.apiKey = '';
  try {
    const ctx = resolveApiKey('');
    assert.equal(ctx?.keyId, '', 'phải cho qua như trước đây (`if (!key) return true`)');
  } finally {
    for (const k of live) db.prepare(`UPDATE api_keys SET enabled = 1 WHERE id = ?`).run(k.id);
    clearApiKeyCache();
  }
});

test('có key trong bảng → request KHÔNG kèm key bị từ chối', () => {
  config.gateway.apiKey = '';
  const c = createApiKey(TEST_PREFIX + 'e');
  try {
    assert.equal(resolveApiKey(''), null);
    assert.equal(resolveApiKey('sai-hoan-toan'), null);
  } finally {
    removeApiKey(c.id);
  }
});

test('HIỆU NĂNG: 200 lần resolve < 200ms (chứng minh không hash chậm mỗi request)', () => {
  config.gateway.apiKey = 'legacy-abc';
  const c = createApiKey(TEST_PREFIX + 'f');
  try {
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) assert.ok(resolveApiKey(c.key));
    const ms = Date.now() - t0;
    assert.ok(ms < 200, `200 lần resolve mất ${ms}ms — quá chậm cho đường nóng`);
  } finally {
    removeApiKey(c.id);
  }
});

test('key thô KHÔNG bao giờ lộ qua listPublicApiKeys', () => {
  config.gateway.apiKey = 'legacy-abc';
  const c = createApiKey(TEST_PREFIX + 'g');
  try {
    const row = listPublicApiKeys().find((k) => k.id === c.id);
    assert.ok(row);
    const json = JSON.stringify(row);
    assert.ok(!json.includes(c.key), 'không được chứa key thô');
    assert.ok(!json.includes('hash'), 'không được chứa hash');
    assert.equal(row!.prefix, c.key.slice(0, 12));
  } finally {
    removeApiKey(c.id);
  }
});
