import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidates, planAuto, AUTO_VARIANTS, type PoolSnapshot, type ModelHealth } from '../../src/gateway/combo.js';

/**
 * `auto` phải chấm điểm theo TỪNG MODEL, không phải theo provider.
 *
 * Bản trước `scoreCandidates` chỉ đọc `successRate` của cả provider, nên mọi model `agy/`
 * cùng nhận một điểm. Đo trên production 12/08/2026:
 *
 *   agy/gemini-3-pro-high        97% lỗi (36/37)
 *   agy/gemini-3.6-flash-high    93% lỗi (27/29)
 *   agy/gemini-3.5-flash-low      1% lỗi (2078 lần)
 *
 * Ba model cùng provider, cùng điểm — và `auto` xếp model 97%-lỗi lên **bước 4**. Mỗi lần
 * trúng nó là một vòng chờ vô ích trước khi trượt sang bước kế.
 */

/** Snapshot pool tối thiểu — provider khoẻ đều nhau để chỉ còn khác biệt ở model. */
function snap(): PoolSnapshot {
  const mk = (provider: string) => ({
    provider: provider as never,
    available: 100,
    total: 100,
    quotaAvg: 80,
    p95Ms: 5000,
    successRate: 0.9, // provider trông khoẻ
    inflight: 0,
  });
  return { agy: mk('agy'), kr: mk('kr') };
}

const W = AUTO_VARIANTS.default!;

/** Điểm của một model trong bảng xếp hạng. */
function diem(list: ReturnType<typeof scoreCandidates>, model: string): number {
  return list.find((s) => s.model === model)?.score ?? -1;
}

describe('scoreCandidates — model hỏng phải bị hạ điểm', () => {
  test('không có ModelHealth → hành vi Y HỆT bản cũ', () => {
    // Quan trọng: thiếu dữ liệu thì không được đoán bừa, phải giữ nguyên cách cũ.
    const a = scoreCandidates(snap(), W);
    const b = scoreCandidates(snap(), W, new Map());
    assert.deepEqual(a.map((x) => x.model), b.map((x) => x.model));
  });

  test('model lỗi 97% xếp SAU model lỗi 1% của CÙNG provider', () => {
    /**
     * Đây chính là bug. Cùng provider `agy`, cùng mọi chỉ số provider — chỉ khác tỉ lệ
     * thành công thật của từng model.
     */
    const mh: ModelHealth = new Map([
      ['agy/gemini-3-pro-high', { n: 37, okRate: 0.03 }],
      ['agy/gemini-3.5-flash-low', { n: 2078, okRate: 0.99 }],
    ]);
    const r = scoreCandidates(snap(), W, mh);
    assert.ok(
      diem(r, 'agy/gemini-3.5-flash-low') > diem(r, 'agy/gemini-3-pro-high'),
      'model 1%-lỗi phải điểm cao hơn model 97%-lỗi',
    );
  });

  test('KHÔNG có ModelHealth thì hai model đó bằng điểm — đúng bug cũ', () => {
    // Bằng chứng trực tiếp rằng bản cũ không phân biệt được.
    const r = scoreCandidates(snap(), W);
    const a = r.find((x) => x.model === 'agy/gemini-3-pro-high');
    const b = r.find((x) => x.model === 'agy/gemini-3.5-flash-low');
    if (a && b) assert.equal(a.detail.success, b.detail.success, 'bản cũ dùng chung successRate provider');
  });

  test('model KHÔNG có trong ModelHealth → dùng số của provider, không bị phạt', () => {
    // Model mới thêm chưa có lịch sử không được coi là hỏng.
    const mh: ModelHealth = new Map([['agy/gemini-3-pro-high', { n: 37, okRate: 0.03 }]]);
    const r = scoreCandidates(snap(), W, mh);
    const khac = r.find((x) => x.provider === 'agy' && x.model !== 'agy/gemini-3-pro-high');
    assert.ok(khac);
    assert.equal(khac!.detail.success, 0.9, 'model chưa có dữ liệu vẫn dùng successRate provider');
  });

  test('model hỏng của provider này KHÔNG kéo model provider khác xuống', () => {
    const mh: ModelHealth = new Map([['agy/gemini-3-pro-high', { n: 50, okRate: 0.0 }]]);
    const r = scoreCandidates(snap(), W, mh);
    for (const s of r.filter((x) => x.provider === 'kr')) {
      assert.equal(s.detail.success, 0.9, 'kr không được ảnh hưởng');
    }
  });
});

describe('planAuto — model hỏng không lọt vào top', () => {
  test('model 97%-lỗi bị đẩy xuống dưới model khoẻ cùng provider', () => {
    /**
     * Trên production, `auto` xếp `agy/gemini-3-pro-high` ở BƯỚC 4 — nghĩa là nó lọt vào
     * top và được thử thật. Với ModelHealth thì nó phải xuống sau.
     */
    const mh: ModelHealth = new Map([
      ['agy/gemini-3-pro-high', { n: 37, okRate: 0.03 }],
      ['agy/gemini-3.6-flash-high', { n: 29, okRate: 0.07 }],
      ['agy/gemini-3.5-flash-low', { n: 2078, okRate: 0.99 }],
    ]);
    const co = planAuto('default', snap(), mh).map((t) => t.model);
    const khong = planAuto('default', snap()).map((t) => t.model);

    const viTri = (arr: string[], m: string) => {
      const i = arr.indexOf(m);
      return i < 0 ? 999 : i;
    };
    assert.ok(
      viTri(co, 'agy/gemini-3-pro-high') > viTri(khong, 'agy/gemini-3-pro-high') ||
        viTri(co, 'agy/gemini-3-pro-high') === 999,
      'model hỏng phải tụt hạng (hoặc rơi khỏi danh sách) so với bản không có ModelHealth',
    );
  });

  test('vẫn giữ luật tối đa 2 model mỗi provider', () => {
    const mh: ModelHealth = new Map([['agy/gemini-3.5-flash-low', { n: 100, okRate: 1 }]]);
    const plan = planAuto('default', snap(), mh);
    const dem = new Map<string, number>();
    for (const t of plan) {
      const p = t.model.split('/')[0]!;
      dem.set(p, (dem.get(p) ?? 0) + 1);
    }
    for (const [p, n] of dem) assert.ok(n <= 2, `${p} có ${n} model, vượt trần 2`);
  });

  test('provider chưa có account nào vẫn bị loại hẳn', () => {
    const s = snap();
    s.kr!.total = 0;
    const plan = planAuto('default', s, new Map());
    assert.ok(!plan.some((t) => t.model.startsWith('kr/')), 'provider total=0 phải bị loại');
  });
});

describe('minN — không phạt oan model mới', () => {
  test('modelStats bỏ qua model có quá ít lượt gọi', async () => {
    /**
     * 2 lần gọi mà trượt cả 2 chưa đủ kết luận model hỏng. Không có ngưỡng thì một model
     * vừa thêm gặp đúng lúc mạng chập là bị đánh giá 0% và không bao giờ được thử lại.
     */
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const TMP = mkdtempSync(resolve(tmpdir(), 'agy-mh-'));
    process.env.AGY_HOME = TMP;
    try {
      const { db, recordGatewayUsage, modelStats } = await import('../../src/store/db.js');
      db.exec('DELETE FROM gateway_usage');
      const ts = Date.now() - 1000;
      const ghi = (model: string, ok: boolean) =>
        recordGatewayUsage({ ts, email: 'a@t', model, promptTokens: 1, completionTokens: 0, ok, ms: 10 } as never);
      // model mới: 2 lần, trượt cả 2
      ghi('agy/moi', false);
      ghi('agy/moi', false);
      // model cũ: 10 lần, trượt 9
      for (let i = 0; i < 9; i++) ghi('agy/cu', false);
      ghi('agy/cu', true);

      const st = modelStats(ts - 60_000, 5);
      assert.equal(st.get('agy/moi'), undefined, 'model 2 lượt chưa đủ để kết luận');
      assert.equal(st.get('agy/cu')?.okRate, 0.1, 'model 10 lượt thì tính được');
    } finally {
      rmSync(TMP, { recursive: true, force: true });
    }
  });
});
