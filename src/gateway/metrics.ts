/**
 * Số liệu runtime cho /api/metrics — cửa sổ trượt TRONG RAM, không đụng DB.
 *
 * Tách khỏi providerStats() (đọc gateway_usage trong DB, khung 24h) vì mục đích khác:
 * đây là "gateway ĐANG khoẻ không" (requests/sec, error rate, p99 vài phút gần nhất)
 * để cắm vào dashboard/alerting poll dày, còn providerStats là xu hướng dài hạn cho
 * chấm điểm định tuyến. Poll dày mà quét DB thì tự tạo tải cho chính mình.
 */

export interface LatencyStats {
  avgMs: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricsSnapshot {
  /** Độ dài cửa sổ THỰC TẾ (giây) — nhỏ hơn cấu hình khi process mới chạy. */
  windowSec: number;
  requests: number;
  errors: number;
  /** 0..1. Không có request trong cửa sổ → 0. */
  errorRate: number;
  /** requests/giây trung bình trong cửa sổ. */
  rps: number;
  /** null khi cửa sổ không có mẫu nào. */
  latency: LatencyStats | null;
  /** Luỹ kế từ lúc process chạy (không bị cửa sổ cắt). */
  totals: { requests: number; errors: number };
}

interface Sample {
  ts: number;
  ok: boolean;
  ms: number;
}

/** Phần tử thứ p (0..1) của mảng ĐÃ sắp tăng dần — cùng công thức với providerStats. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

export class MetricsRecorder {
  private samples: Sample[] = [];
  private totalRequests = 0;
  private totalErrors = 0;
  private startedAt: number | null = null;

  /**
   * @param windowMs  độ dài cửa sổ trượt (mặc định 5 phút)
   * @param cap       trần số mẫu giữ trong RAM — vượt thì bỏ mẫu cũ nhất. 20k mẫu
   *                  ~ 66 req/s liên tục suốt 5 phút, quá đủ cho quy mô gateway này.
   */
  constructor(private windowMs = 5 * 60_000, private cap = 20_000) {}

  record(ok: boolean, ms: number, now = Date.now()): void {
    if (this.startedAt == null) this.startedAt = now;
    this.totalRequests++;
    if (!ok) this.totalErrors++;
    this.samples.push({ ts: now, ok, ms });
    if (this.samples.length > this.cap) this.samples.splice(0, this.samples.length - this.cap);
    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    // Mẫu theo thứ tự thời gian → tìm điểm cắt rồi splice một lần.
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.ts < cutoff) drop++;
    if (drop) this.samples.splice(0, drop);
  }

  snapshot(now = Date.now()): MetricsSnapshot {
    this.prune(now);
    const n = this.samples.length;
    const errors = this.samples.reduce((s, x) => s + (x.ok ? 0 : 1), 0);
    // Cửa sổ hiệu dụng: process mới chạy 30s mà chia cho 300s thì rps bị pha loãng 10 lần.
    const aliveMs = this.startedAt == null ? this.windowMs : Math.max(1000, now - this.startedAt);
    const windowMs = Math.min(this.windowMs, aliveMs);

    let latency: LatencyStats | null = null;
    if (n) {
      const ms = this.samples.map((s) => s.ms).sort((a, b) => a - b);
      latency = {
        avgMs: Math.round(ms.reduce((s, x) => s + x, 0) / n),
        p50: percentile(ms, 0.5),
        p95: percentile(ms, 0.95),
        p99: percentile(ms, 0.99),
      };
    }
    return {
      windowSec: Math.round(windowMs / 1000),
      requests: n,
      errors,
      errorRate: n ? errors / n : 0,
      rps: Number((n / (windowMs / 1000)).toFixed(3)),
      latency,
      totals: { requests: this.totalRequests, errors: this.totalErrors },
    };
  }
}

/** Singleton của gateway — engine.afterCall ghi vào đây, /api/metrics đọc ra. */
export const gatewayMetrics = new MetricsRecorder();
