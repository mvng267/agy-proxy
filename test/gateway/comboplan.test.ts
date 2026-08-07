import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  planCombo, shouldFallback, setRrCursor, getRrCursor,
  type Combo, type PoolSnapshot,
} from '../../src/gateway/combo.js';

/**
 * planCombo/shouldFallback là hàm THUẦN — test không cần mạng, không cần store.
 * Đây là bộ não xếp thứ tự thử của combo; vòng chạy thật nằm ở engine (xem
 * test/api/combo-loop.test.ts).
 */

const combo = (strategy: Combo['strategy'], targets: Combo['targets']): Combo => ({
  id: 'test', name: 'test', strategy, targets, enabled: true,
});

const SNAP: PoolSnapshot = {
  agy: { provider: 'agy', available: 5, total: 10, quotaAvg: 20, p95Ms: 900, successRate: 0.9, inflight: 0 },
  kr: { provider: 'kr', available: 9, total: 10, quotaAvg: null, p95Ms: 1500, successRate: 0.8, inflight: 1 },
};

describe('planCombo', () => {
  test('priority: giữ nguyên thứ tự người dùng khai báo', () => {
    const c = combo('priority', [{ model: 'agy/gemini-3-flash' }, { model: 'kr/claude-sonnet-4' }]);
    const plan = planCombo(c, SNAP);
    assert.deepEqual(plan.map((t) => t.model), ['agy/gemini-3-flash', 'kr/claude-sonnet-4']);
  });

  test('round-robin: mỗi request xoay điểm bắt đầu, hết vòng quay lại đầu', () => {
    const c = combo('round-robin', [{ model: 'a/1' }, { model: 'a/2' }, { model: 'a/3' }]);
    setRrCursor(0);
    assert.deepEqual(planCombo(c, SNAP).map((t) => t.model), ['a/1', 'a/2', 'a/3']);
    assert.deepEqual(planCombo(c, SNAP).map((t) => t.model), ['a/2', 'a/3', 'a/1']);
    assert.deepEqual(planCombo(c, SNAP).map((t) => t.model), ['a/3', 'a/1', 'a/2']);
    assert.deepEqual(planCombo(c, SNAP).map((t) => t.model), ['a/1', 'a/2', 'a/3']);
    assert.equal(getRrCursor(), 4, 'con trỏ phải tiến sau mỗi lần plan');
  });

  test('weighted: weight 9-vs-1 → model nặng đứng đầu ~94% (phân phối thật, không phải luôn luôn)', () => {
    // Công thức k = rand/weight ⇒ P(A đứng đầu | wA=9, wB=1) = 1 − 1/(2·9) ≈ 0.944.
    // 2000 lượt, sd ≈ 0.5% → biên 0.90–0.98 đủ rộng để không flaky mà vẫn bắt được
    // lỗi đảo trọng số (khi đó tỉ lệ tụt về ~0.056).
    const c = combo('weighted', [{ model: 'a/heavy', weight: 9 }, { model: 'a/light', weight: 1 }]);
    let heavyFirst = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      if (planCombo(c, SNAP)[0]!.model === 'a/heavy') heavyFirst++;
    }
    const rate = heavyFirst / N;
    assert.ok(rate > 0.9 && rate < 0.98, `tỉ lệ heavy đứng đầu phải ~0.94, đo được ${rate}`);
  });

  test('weighted: thiếu weight → mặc định 1, vẫn có mặt đủ mọi bước', () => {
    const c = combo('weighted', [{ model: 'a/1' }, { model: 'a/2', weight: 3 }]);
    const plan = planCombo(c, SNAP);
    assert.equal(plan.length, 2);
    assert.deepEqual(plan.map((t) => t.model).sort(), ['a/1', 'a/2']);
  });

  test('highest-quota: provider quota cao đứng trước (Kiro không có API quota → dùng tỉ lệ available)', () => {
    // agy quotaAvg=20; kr null → proxy = available/total·100 = 90 ⇒ kr đứng đầu.
    const c = combo('highest-quota', [{ model: 'agy/gemini-3-flash' }, { model: 'kr/claude-sonnet-4' }]);
    const plan = planCombo(c, SNAP);
    assert.equal(plan[0]!.model, 'kr/claude-sonnet-4');
  });

  test('targets rỗng → plan rỗng (không ném)', () => {
    assert.deepEqual(planCombo(combo('priority', []), SNAP), []);
  });
});

describe('shouldFallback', () => {
  test('hết hạn mức (402/429) và 5xx → trượt bước', () => {
    assert.equal(shouldFallback({ status: 429 }), true);
    assert.equal(shouldFallback({ status: 402 }), true);
    assert.equal(shouldFallback({ status: 500 }), true);
    assert.equal(shouldFallback({ status: 503 }), true);
  });

  test('lỗi người dùng (400/401/403) → dừng, không đốt quota bước sau', () => {
    assert.equal(shouldFallback({ status: 400, message: 'bad request' }), false);
    assert.equal(shouldFallback({ status: 401 }), false);
    assert.equal(shouldFallback({ status: 403 }), false);
  });

  test('NGOẠI LỆ: 400 vì prompt quá dài → VẪN trượt (model kế có ngữ cảnh lớn hơn)', () => {
    assert.equal(shouldFallback({ status: 400, message: 'Input is too long for requested model' }), true);
    assert.equal(shouldFallback({ status: 400, message: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD' }), true);
  });

  test('lỗi mạng/timeout không có status → trượt theo message', () => {
    assert.equal(shouldFallback({ message: 'fetch failed' }), true);
    assert.equal(shouldFallback({ message: 'ETIMEDOUT: connect timeout' }), true);
    assert.equal(shouldFallback({ message: 'lỗi lạ không nhận diện được' }), false);
  });
});
