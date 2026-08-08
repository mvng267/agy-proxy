/**
 * Circuit breaker THEO PROVIDER — cắt sớm khi cả provider hỏng, thay vì failover vô hạn.
 *
 * Failover từng account (engine.runProviderCall) xử lý tốt khi MỘT VÀI account hỏng,
 * nhưng khi cả upstream sập (deploy hỏng, endpoint đổi, mạng đứt) thì mỗi request client
 * vẫn đốt 3 lượt gọi mạng + hàng chục vòng pick trước khi bỏ cuộc — pool càng to càng
 * lâu, và hàng trăm request dồn vào một upstream đang hấp hối chỉ làm nó lâu hồi hơn.
 *
 * Ba trạng thái kinh điển, half-open DẪN XUẤT theo thời gian (không giữ bộ đếm thăm dò
 * riêng — bộ đếm phải được trả lại ở mọi đường thoát của engine, quên một đường là kẹt
 * mạch vĩnh viễn; thời gian thì không rò được):
 *   closed    → cho qua hết; đếm lỗi hạ tầng LIÊN TIẾP (thành công nào cũng reset).
 *   open      → chặn ngay (fail-fast 503) trong `openMs`.
 *   half-open → hết openMs: cho qua để thăm dò. Thành công đầu tiên → closed;
 *               lỗi hạ tầng đầu tiên → mở lại từ đầu (openedAt = now).
 *
 * CHỈ lỗi hạ tầng (5xx/timeout/mạng) mới tính vào ngưỡng. Quota (402/429) là chuyện của
 * TỪNG account — pool đã cooldown đúng account/bể rồi, cả provider vẫn khoẻ.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOpts {
  /** Số lỗi hạ tầng LIÊN TIẾP để nhảy sang open. */
  failureThreshold?: number;
  /** Thời gian chặn (ms) trước khi cho thăm dò lại. */
  openMs?: number;
}

interface KeyState {
  consecutiveFails: number;
  /** 0 = chưa từng mở. >0 = thời điểm mở gần nhất. */
  openedAt: number;
}

export class CircuitBreakerOpenError extends Error {
  status = 503;
  retryAfterMs: number;
  constructor(key: string, retryAfterMs: number) {
    super(
      `Circuit breaker "${key}" đang MỞ — provider lỗi hạ tầng liên tiếp, ` +
        `chặn tạm ${Math.ceil(retryAfterMs / 1000)}s để upstream hồi.`,
    );
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  private keys = new Map<string, KeyState>();
  private threshold: number;
  private openMs: number;

  constructor(opts: BreakerOpts = {}) {
    this.threshold = opts.failureThreshold ?? 10;
    this.openMs = opts.openMs ?? 30_000;
  }

  private of(key: string): KeyState {
    let s = this.keys.get(key);
    if (!s) {
      s = { consecutiveFails: 0, openedAt: 0 };
      this.keys.set(key, s);
    }
    return s;
  }

  /** Xin phép gọi upstream. Ném CircuitBreakerOpenError khi đang chặn. */
  allow(key: string, now = Date.now()): void {
    const s = this.keys.get(key);
    if (!s || !s.openedAt) return;
    const elapsed = now - s.openedAt;
    if (s.consecutiveFails >= this.threshold && elapsed < this.openMs) {
      throw new CircuitBreakerOpenError(key, this.openMs - elapsed);
    }
    // hết openMs → half-open: cho qua, chờ ok()/fail() quyết định
  }

  /** Báo 1 lượt gọi upstream THÀNH CÔNG → đóng mạch. */
  ok(key: string): void {
    const s = this.keys.get(key);
    if (!s) return;
    s.consecutiveFails = 0;
    s.openedAt = 0;
  }

  /** Báo 1 lượt gọi upstream lỗi HẠ TẦNG (đừng gọi cho lỗi quota/4xx). */
  fail(key: string, now = Date.now()): void {
    const s = this.of(key);
    s.consecutiveFails++;
    if (s.consecutiveFails >= this.threshold) s.openedAt = now;
    // half-open mà fail: consecutiveFails vốn đã ≥ threshold → openedAt=now mở lại từ đầu
  }

  /** Trạng thái hiện tại (cho /api/metrics + test). */
  state(key: string, now = Date.now()): BreakerState {
    const s = this.keys.get(key);
    if (!s || !s.openedAt || s.consecutiveFails < this.threshold) return 'closed';
    return now - s.openedAt < this.openMs ? 'open' : 'half-open';
  }

  /** Ảnh chụp mọi key — cho /api/metrics. */
  snapshot(now = Date.now()): Record<string, { state: BreakerState; consecutiveFails: number }> {
    const out: Record<string, { state: BreakerState; consecutiveFails: number }> = {};
    for (const [k, s] of this.keys) {
      out[k] = { state: this.state(k, now), consecutiveFails: s.consecutiveFails };
    }
    return out;
  }

  /** Xoá sạch trạng thái (test / admin gỡ chặn tay). */
  reset(key?: string): void {
    if (key) this.keys.delete(key);
    else this.keys.clear();
  }
}

/**
 * Singleton của gateway. Ngưỡng 10 khớp với thực tế failover: mỗi request client thử
 * tối đa 3 account (maxTry) → cần ~4 request client liên tiếp toàn lỗi hạ tầng mới
 * cắt mạch, đủ chậm để không cắt oan vì 1-2 cú 500 lẻ tẻ.
 */
export const providerBreaker = new CircuitBreaker({
  failureThreshold: Number(process.env.AGY_BREAKER_THRESHOLD) || 10,
  openMs: (Number(process.env.AGY_BREAKER_OPEN_SEC) || 30) * 1000,
});
