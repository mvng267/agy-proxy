import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuotaInfo } from '../../src/gateway/antigravity.js';

const SUMMARY = {
  groups: [
    { displayName: 'Gemini Models', description: 'Gemini Flash, Gemini Pro', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9988896, resetTime: '2026-08-04T17:23:24Z', description: 'refresh in 6 days' }] },
    { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-08-04T17:22:59Z' }] },
  ],
};
const MODELS = {
  models: {
    'gemini-2.5-flash': { quotaInfo: { remainingFraction: 0.5, resetTime: '2026-08-04T00:00:00Z' } },
    'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 0.12, resetTime: '2026-08-04T00:00:00Z' } },
    'no-quota-model': { displayName: 'x' },
  },
};
const LOAD = { allowedTiers: [{ id: 'free-tier', isDefault: true }, { id: 'standard-tier' }] };

test('buildQuotaInfo: nhóm weekly → pct đúng', () => {
  const q = buildQuotaInfo(SUMMARY, MODELS, LOAD, 111);
  assert.equal(q.groups.length, 2);
  assert.equal(q.groups[0]!.name, 'Gemini Models');
  assert.equal(q.groups[0]!.pct, 100); // round(0.9988896*100)=100
  assert.equal(q.groups[0]!.resetTime, '2026-08-04T17:23:24Z');
  assert.equal(q.groups[1]!.pct, 100);
  assert.equal(q.fetchedAt, 111);
});

test('buildQuotaInfo: per-model pct + bỏ model không có quotaInfo', () => {
  const q = buildQuotaInfo(SUMMARY, MODELS, LOAD);
  assert.equal(q.models.length, 2); // no-quota-model bị bỏ
  const flash = q.models.find((m) => m.id === 'gemini-2.5-flash')!;
  assert.equal(flash.pct, 50);
  const sonnet = q.models.find((m) => m.id === 'claude-sonnet-4-6')!;
  assert.equal(sonnet.pct, 12);
});

test('buildQuotaInfo: tier từ allowedTiers isDefault', () => {
  assert.equal(buildQuotaInfo(SUMMARY, MODELS, LOAD).tier, 'free-tier');
  assert.equal(buildQuotaInfo(SUMMARY, MODELS, { paidTier: { name: 'Pro Quota' } }).tier, 'Pro Quota');
});

test('buildQuotaInfo: input null → rỗng, không crash', () => {
  const q = buildQuotaInfo(null, null, null, 5);
  assert.deepEqual(q, { tier: null, groups: [], models: [], fetchedAt: 5 });
});
