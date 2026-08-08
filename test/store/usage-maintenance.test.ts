import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Bảo trì bảng gateway_usage (P2.4): prune theo retention, lấy mẫu LIMIT trong SQL,
 * cache credit Kiro. AGY_HOME trỏ thư mục tạm TRƯỚC mọi import chạm dữ liệu.
 */
const TMP_HOME = mkdtempSync(resolve(tmpdir(), 'agy-usagemaint-'));
process.env.AGY_HOME = TMP_HOME;

const {
  recordGatewayUsage, pruneUsage, usageSamples, creditsUsedThisMonth,
} = await import('../../src/store/db.js');
const { config, applyConfig } = await import('../../src/config.js');

after(() => rmSync(TMP_HOME, { recursive: true, force: true }));

const NOW = Date.now();
const row = (over: Partial<Parameters<typeof recordGatewayUsage>[0]> = {}) => ({
  ts: NOW, email: 'u@test.local', model: 'agy/gemini-3-flash',
  promptTokens: 1, completionTokens: 1, ok: true, ms: 100, ...over,
});

test('pruneUsage: xoá đúng dòng quá hạn, giữ dòng mới; 0 ngày = giữ vĩnh viễn', () => {
  recordGatewayUsage(row({ ts: NOW - 100 * 86400_000 })); // 100 ngày trước
  recordGatewayUsage(row({ ts: NOW - 1000 }));            // vừa xong
  assert.equal(pruneUsage(0), 0, 'retention 0 phải là tắt, không xoá gì');
  const deleted = pruneUsage(90);
  assert.equal(deleted, 1, 'chỉ xoá dòng 100 ngày tuổi');
  assert.equal(usageSamples(0, 10).length, 1, 'dòng mới phải còn nguyên');
});

test('usageRetentionDays: có setter thật (trước đây chỉ có SPEC, đổi là rơi vào im lặng)', () => {
  const r = applyConfig({ usageRetentionDays: '30' });
  assert.deepEqual(r.rejected, []);
  assert.ok(r.changed.includes('usageRetentionDays'));
  assert.equal(config.gateway.usageRetentionDays, 30);
  assert.ok(applyConfig({ usageRetentionDays: '-1' }).rejected.length, 'giá trị âm phải bị chặn');
  applyConfig({ usageRetentionDays: '90' });
});

test('usageSamples: LIMIT lấy N dòng MỚI nhất, trả theo thời gian tăng dần', () => {
  for (let i = 0; i < 5; i++) recordGatewayUsage(row({ ts: NOW + i, ms: i }));
  const s = usageSamples(0, 3);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.ms), [2, 3, 4], 'phải là 3 dòng mới nhất, cũ trước mới sau');
});

test('creditsUsedThisMonth: cache trả cùng object, usage mới invalidate ngay', () => {
  recordGatewayUsage(row({ model: 'kr/claude-sonnet-4.5', email: 'kiro@test.local' }));
  const a = creditsUsedThisMonth('kr/');
  assert.equal(a['kiro@test.local'], 1);
  assert.equal(creditsUsedThisMonth('kr/'), a, 'không có usage mới → trả đúng cache');
  recordGatewayUsage(row({ model: 'kr/claude-sonnet-4.5', email: 'kiro@test.local' }));
  const b = creditsUsedThisMonth('kr/');
  assert.notEqual(b, a, 'usage mới phải invalidate cache');
  assert.equal(b['kiro@test.local'], 2);
});
