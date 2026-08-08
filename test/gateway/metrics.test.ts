import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRecorder } from '../../src/gateway/metrics.js';

/**
 * MetricsRecorder — cửa sổ trượt trong RAM cho /api/metrics.
 * Test thuần với `now` truyền tay: không sleep, không phụ thuộc đồng hồ thật.
 */

const T0 = 1_700_000_000_000;

test('snapshot rỗng: không request → errorRate 0, latency null', () => {
  const m = new MetricsRecorder();
  const s = m.snapshot(T0);
  assert.equal(s.requests, 0);
  assert.equal(s.errors, 0);
  assert.equal(s.errorRate, 0);
  assert.equal(s.latency, null);
  assert.deepEqual(s.totals, { requests: 0, errors: 0 });
});

test('đếm request/error + errorRate trong cửa sổ', () => {
  const m = new MetricsRecorder();
  m.record(true, 100, T0);
  m.record(true, 200, T0 + 1000);
  m.record(false, 300, T0 + 2000);
  m.record(false, 400, T0 + 3000);
  const s = m.snapshot(T0 + 3000);
  assert.equal(s.requests, 4);
  assert.equal(s.errors, 2);
  assert.equal(s.errorRate, 0.5);
  assert.deepEqual(s.totals, { requests: 4, errors: 2 });
});

test('mẫu ngoài cửa sổ bị loại; totals thì KHÔNG bị cắt', () => {
  const m = new MetricsRecorder(60_000); // cửa sổ 1 phút
  m.record(false, 100, T0);
  m.record(true, 200, T0 + 90_000); // mẫu đầu đã quá 60s
  const s = m.snapshot(T0 + 90_000);
  assert.equal(s.requests, 1, 'chỉ còn mẫu trong cửa sổ');
  assert.equal(s.errors, 0);
  assert.deepEqual(s.totals, { requests: 2, errors: 1 }, 'luỹ kế giữ đủ cả 2');
});

test('latency: avg/p50/p95/p99 đúng trên phân phối biết trước', () => {
  const m = new MetricsRecorder();
  // 100 mẫu: 1..100ms — p50=51, p95=96, p99=100 (index floor(n*p), cùng công thức providerStats)
  for (let i = 1; i <= 100; i++) m.record(true, i, T0 + i);
  const s = m.snapshot(T0 + 100);
  assert.ok(s.latency);
  assert.equal(s.latency.avgMs, Math.round(5050 / 100));
  assert.equal(s.latency.p50, 51);
  assert.equal(s.latency.p95, 96);
  assert.equal(s.latency.p99, 100);
});

test('rps: chia theo cửa sổ HIỆU DỤNG khi process mới chạy', () => {
  const m = new MetricsRecorder(300_000);
  // 10 request trong 10 giây đầu đời — rps phải ~1, không phải 10/300
  for (let i = 0; i < 10; i++) m.record(true, 50, T0 + i * 1000);
  const s = m.snapshot(T0 + 10_000);
  assert.equal(s.windowSec, 10);
  assert.equal(s.rps, 1);
});

test('cap: vượt trần mẫu → bỏ mẫu cũ nhất, không phình RAM', () => {
  const m = new MetricsRecorder(300_000, 100);
  for (let i = 0; i < 250; i++) m.record(i < 150, 10, T0 + i);
  const s = m.snapshot(T0 + 250);
  assert.equal(s.requests, 100, 'chỉ giữ đúng cap mẫu');
  // 100 mẫu cuối là i=150..249 → toàn lỗi
  assert.equal(s.errors, 100);
  assert.deepEqual(s.totals, { requests: 250, errors: 100 });
});
