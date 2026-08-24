import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isModelCapacityError, isTransientError } from '../../src/gateway/poolScore.js';

/**
 * Tách lỗi MODEL khỏi lỗi ACCOUNT.
 *
 * Đo trên production: `gemini-2.5-pro` trả `503 No capacity available` 66 lần / 2 giờ. Pool
 * xử lý như lỗi account → cooldown từng cái 30s → mỗi account hỏng đúng một lần nên backoff
 * không kích hoạt → quét sạch 35 account trong 195 giây rồi vẫn hỏng.
 *
 * Đổi account vô ích khi upstream hết chỗ cho model đó.
 */
describe('isModelCapacityError — nhận đúng lỗi hết chỗ của model', () => {
  test('503 No capacity available (ca thật, 66 lần/2h)', () => {
    const that = 'generateContent 503: { "error": { "code": 503, "message": "No capacity available' ;
    assert.equal(isModelCapacityError(that, 503), true);
  });

  test('429 RESOURCE_EXHAUSTED cũng là hết chỗ', () => {
    assert.equal(isModelCapacityError('RESOURCE_EXHAUSTED: quota', 429), true);
  });

  test('403 suspended là lỗi ACCOUNT — không được nhận nhầm', () => {
    // Ca thật: Kiro đình chỉ agyproxy4/agyproxy16. Cooldown model là sai — account khác vẫn chạy.
    const kiro = 'Kiro 403 : Your User ID (64f8b4b8) temporarily is suspended.';
    assert.equal(isModelCapacityError(kiro, 403), false);
  });

  test('503 KHÔNG phải hết chỗ (lỗi hạ tầng) thì để nguyên đường cũ', () => {
    assert.equal(isModelCapacityError('Bad Gateway', 503), false);
  });

  test('vẫn là transient — không mất cơ chế cũ', () => {
    // Cooldown model là THÊM, không thay thế: account vẫn cần nghỉ ngắn sau 5xx.
    assert.equal(isTransientError('No capacity available', 503), true);
  });
});

describe('Pool.modelCooldown — model nghỉ, không quét account', () => {
  test('đủ 3 lần báo mới cho nghỉ — 1 account lẻ hỏng không đủ kết luận', async () => {
    const { Pool } = await import('../../src/gateway/pool.js');
    const p = new Pool();
    const M = 'agy/gemini-2.5-pro';

    p.reportModelCapacity(M);
    assert.equal(p.modelResting(M), 0, '1 lần: có thể do account đó, chưa chặn');
    p.reportModelCapacity(M);
    assert.equal(p.modelResting(M), 0, '2 lần: vẫn chưa chắc');
    p.reportModelCapacity(M);
    assert.ok(p.modelResting(M) > 0, '3 account liên tiếp ⇒ upstream hết chỗ thật');
  });

  test('hết giờ nghỉ thì tự mở lại', async () => {
    const { Pool } = await import('../../src/gateway/pool.js');
    const p = new Pool();
    const M = 'agy/x';
    for (let i = 0; i < 3; i++) p.reportModelCapacity(M);
    const sau = Date.now() + 6 * 60_000;
    assert.equal(p.modelResting(M, sau), 0, 'nghỉ 5 phút, quá mốc phải mở');
  });

  test('thành công xoá bộ đếm — lỗi rải rác không cộng dồn thành cooldown oan', async () => {
    const { Pool } = await import('../../src/gateway/pool.js');
    const p = new Pool();
    const M = 'agy/y';
    p.reportModelCapacity(M);
    p.reportModelCapacity(M);
    p.clearModelFails(M);
    p.reportModelCapacity(M);
    assert.equal(p.modelResting(M), 0, 'đếm lại từ đầu sau khi model chạy được');
  });

  test('model khác KHÔNG bị vạ lây', async () => {
    const { Pool } = await import('../../src/gateway/pool.js');
    const p = new Pool();
    for (let i = 0; i < 3; i++) p.reportModelCapacity('agy/gemini-2.5-pro');
    assert.equal(p.modelResting('agy/gemini-3-flash'), 0);
  });
});

describe('health=dead trong RAM không bị store ghi đè', () => {
  /**
   * `syncFromStore()` chạy mỗi 2 giây và truyền `health` từ credentials.csv. Luật cũ
   * "store chỉ nâng cấp, không hạ" đúng cho `unknown`, nhưng khiến `alive` cũ trong CSV
   * xoá mất `dead` vừa phát hiện trong RAM.
   *
   * Đo thật: `agyproxy4`/`agyproxy16` bị AWS đình chỉ (403 suspended), CSV vẫn `alive` →
   * mọi request Kiro thử hai cái này trước, hỏng, mới tới cái thứ ba. Tốn 540ms/request.
   */
  test('upsert với health=alive KHÔNG hồi sinh account đã dead', async () => {
    const { Pool } = await import('../../src/gateway/pool.js');
    const p = new Pool();
    const base = { provider: 'kr' as const, email: 'a@t', credential: '{}', refreshToken: 'x' };

    p.upsert(base);
    p.report(p.accounts.get('kr:a@t')!, {
      ok: false, status: 403,
      err: 'Kiro 403 : Your User ID (abc) temporarily is suspended.',
    });
    assert.equal(p.accounts.get('kr:a@t')!.health, 'dead');

    // syncFromStore đọc CSV còn ghi 'alive' — không được hồi sinh
    p.upsert({ ...base, health: 'alive' });
    assert.equal(p.accounts.get('kr:a@t')!.health, 'dead', 'CSV cũ không được xoá phát hiện mới');
  });

  test('account dead bị loại khỏi candidates', async () => {
    const { Pool } = await import('../../src/gateway/pool.js');
    const p = new Pool();
    p.upsert({ provider: 'kr', email: 'song@t', credential: '{}', refreshToken: 'x' });
    p.upsert({ provider: 'kr', email: 'chet@t', credential: '{}', refreshToken: 'y' });
    p.accounts.get('kr:chet@t')!.health = 'dead';

    const ds = p.candidates(Date.now(), 'kr').map((a) => a.email);
    assert.deepEqual(ds, ['song@t']);
  });
});
