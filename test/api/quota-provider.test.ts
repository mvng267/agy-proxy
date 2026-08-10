import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * Hạn mức phải TÁCH THEO PROVIDER — hai bên có mô hình khác hẳn nhau:
 *
 *   agy (Antigravity)  2 bể độc lập theo TUẦN: "Gemini Models" và "Claude and GPT
 *                      models", mỗi bể % + resetTime riêng, kèm % từng model.
 *   kr  (Kiro)         1 quỹ credit theo THÁNG (50 credit gói FREE). Không có bể nào,
 *                      không có Gemini.
 *
 * Bug: `/api/gateway/quota-summary` gộp cả 702 account vào một `geminiAvg`. Với Kiro,
 * `geminiPct()` trả về chính quỹ credit — cố ý, để rotation xếp hạng được account một-bể.
 * Nhưng dùng con số đó để HIỂN THỊ thì thành "Gemini TB 85%" cho một provider không có
 * Gemini: đúng số học, vô nghĩa về ý nghĩa.
 */
const TMP = mkdtempSync(resolve(tmpdir(), 'agy-qprov-'));
process.env.AGY_HOME = TMP;

const { store } = await import('../../src/store/index.js');
const { pool } = await import('../../src/gateway/pool.js');
const { registerGatewayRoutes } = await import('../../src/gateway/routes.js');
const Fastify = (await import('fastify')).default;
const formbody = (await import('@fastify/formbody')).default;
type FastifyInstance = import('fastify').FastifyInstance;

let app: FastifyInstance;

before(async () => {
  store.load();
  // Hai account mỗi provider, quota dựng đúng hình dạng thật của từng bên.
  store.upsertCredential({ email: 'a1@t.local', target: 'agy', value: '1//a1', updated_at: '' } as any);
  store.upsertCredential({ email: 'k1@t.local', target: 'kiro', value: JSON.stringify({ accessToken: 'x', refreshToken: 'y', profileArn: 'arn', region: 'us-east-1', expiresAt: new Date(Date.now() + 3600_000).toISOString() }), updated_at: '' } as any);

  app = Fastify();
  await app.register(formbody);
  await registerGatewayRoutes(app);
  await app.ready();

  // Gán quota SAU khi pool đã nạp account từ store.
  const a = pool.get('a1@t.local', 'agy');
  if (a) {
    a.quota = {
      tier: 'Antigravity Starter Quota',
      groups: [
        { name: 'Gemini Models', pct: 80, resetTime: '2026-08-14T00:00:00Z' },
        { name: 'Claude and GPT models', pct: 40, resetTime: '2026-08-14T00:00:00Z' },
      ],
      models: [{ id: 'gemini-3-flash', pct: 80 }],
      fetchedAt: Date.now(),
    } as any;
  }
  const k = pool.get('k1@t.local', 'kr');
  if (k) {
    k.quota = {
      tier: 'KIRO FREE',
      groups: [{ name: 'Credits', pct: 60, resetTime: '2026-09-01T00:00:00Z', desc: '20/50 credit' }],
      models: [],
      fetchedAt: Date.now(),
    } as any;
  }
});

after(async () => {
  await app?.close();
  rmSync(TMP, { recursive: true, force: true });
});

const summary = async () => (await app.inject({ method: 'GET', url: '/api/gateway/quota-summary' })).json();

describe('quota-summary tách theo provider', () => {
  test('có khối byProvider riêng cho từng provider', async () => {
    const j = await summary();
    assert.ok(j.byProvider, 'thiếu byProvider thì UI buộc phải tự đoán theo tên provider');
    assert.ok(j.byProvider.agy, 'thiếu agy');
    assert.ok(j.byProvider.kr, 'thiếu kr');
  });

  test('agy = nhiều bể, kr = một quỹ — phân biệt bằng `kind`', async () => {
    const j = await summary();
    assert.equal(j.byProvider.agy.kind, 'buckets');
    assert.equal(j.byProvider.kr.kind, 'credits');
  });

  test('agy có ĐÚNG 2 nhóm: Gemini và Claude/GPT', async () => {
    const j = await summary();
    const keys = j.byProvider.agy.groups.map((g: any) => g.key);
    assert.deepEqual(keys, ['gemini', 'claude']);
    assert.equal(j.byProvider.agy.groups[0].avg, 80);
    assert.equal(j.byProvider.agy.groups[1].avg, 40, 'bể Claude phải tách khỏi bể Gemini');
  });

  test('kr có ĐÚNG 1 nhóm, giữ tên gốc "Credits" — không bị gắn nhãn Gemini', async () => {
    const j = await summary();
    const g = j.byProvider.kr.groups;
    assert.equal(g.length, 1, 'Kiro không chia bể');
    assert.equal(g[0].key, 'credits');
    assert.equal(g[0].label, 'Credits', 'tên nhóm phải giữ nguyên bản upstream');
    assert.equal(g[0].avg, 60);
  });

  test('không nhóm nào của kr mang nhãn Gemini', async () => {
    // Đây chính là bug: Kiro hiện "Gemini 60%" trong khi nó không có Gemini.
    const j = await summary();
    for (const g of j.byProvider.kr.groups) {
      assert.doesNotMatch(g.label, /gemini/i, `nhóm "${g.label}" của Kiro không được gọi là Gemini`);
      assert.notEqual(g.key, 'gemini');
    }
  });

  test('tier tách riêng — hai bên tên gói khác nhau', async () => {
    const j = await summary();
    assert.ok('Antigravity Starter Quota' in j.byProvider.agy.tiers);
    assert.ok('KIRO FREE' in j.byProvider.kr.tiers);
    assert.ok(!('KIRO FREE' in j.byProvider.agy.tiers), 'tier Kiro không được lẫn vào agy');
  });

  test('vẫn giữ trường cũ ở cấp gốc — CLI/MCP/skill đang đọc chúng', async () => {
    const j = await summary();
    for (const k of ['fetched', 'total', 'geminiAvg', 'geminiMin', 'thirdPartyAvg', 'tiers']) {
      assert.ok(k in j, `mất trường "${k}" là phá client cũ`);
    }
  });
});
