import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { db, recordGatewayUsage, usageTotals, usageSeries, usageByModel, usageByAccount } from '../../src/store/db.js';

// Dùng khoảng thời gian cô lập trong quá khứ để không đụng dữ liệu thật.
const BASE = Date.UTC(2020, 0, 1, 0, 0, 0); // 2020-01-01
const DAY = 86400_000;
const FROM = BASE - DAY;
const TO = BASE + 10 * DAY;

before(() => { db.prepare('DELETE FROM gateway_usage WHERE ts >= ? AND ts < ?').run(FROM, TO); }); // idempotent

test('record + tổng hợp usage (totals/model/account)', () => {
  recordGatewayUsage({ ts: BASE, email: 'a@x', model: 'gemini-2.5-flash', promptTokens: 5, completionTokens: 7, ok: true, ms: 100 });
  recordGatewayUsage({ ts: BASE + 1000, email: 'a@x', model: 'gemini-2.5-flash', promptTokens: 3, completionTokens: 4, ok: true, ms: 120 });
  recordGatewayUsage({ ts: BASE + DAY, email: 'b@x', model: 'claude-sonnet-4-6', promptTokens: 10, completionTokens: 20, ok: false, ms: 200 });

  const t = usageTotals(FROM, TO);
  assert.equal(t.requests, 3);
  assert.equal(t.tokIn, 18);
  assert.equal(t.tokOut, 31);
  assert.equal(t.accounts, 2);

  const byM = usageByModel(FROM, TO);
  const flash = byM.find((m) => m.model === 'gemini-2.5-flash')!;
  assert.equal(flash.requests, 2);
  assert.equal(flash.tokIn, 8);

  const byA = usageByAccount(FROM, TO);
  assert.equal(byA.find((a) => a.email === 'a@x')!.requests, 2);
  assert.equal(byA.find((a) => a.email === 'b@x')!.requests, 1);
});

test('usageSeries gộp theo ngày', () => {
  const s = usageSeries(FROM, TO, 'day');
  // có ít nhất 2 mốc ngày (BASE và BASE+DAY)
  assert.ok(s.length >= 2);
  const totalReq = s.reduce((n, r) => n + r.requests, 0);
  assert.ok(totalReq >= 3);
  // mỗi bucket là chuỗi ngày YYYY-MM-DD
  assert.match(s[0]!.bucket, /^\d{4}-\d{2}-\d{2}$/);
});
