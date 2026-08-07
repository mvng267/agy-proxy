import { config } from '../config.js';
import { pruneQuotaHistory } from '../store/db.js';
import { pool, savePersist, ensureReady, dispatcherFor, refreshQuota } from './pool.js';
import { log, checkLiveAccount } from './engine.js';

/**
 * Các job nền của gateway: auto refresh quota/token, dò hạn mức Kiro, dọn lịch sử.
 * Gọi một lần lúc đăng ký route — mọi timer đều unref để không giữ process sống.
 */

/**
 * Chờ tới khi pool rảnh. Công việc nền (refresh quota/token) gọi hàm này trước mỗi
 * account để không cạnh tranh băng thông với request của client.
 */
async function waitWhileBusy(maxWaitMs = 30_000) {
  const until = Date.now() + maxWaitMs;
  while (Date.now() < until) {
    const busy = pool.list().reduce((n, a) => n + (a.inflight || 0), 0);
    if (busy === 0) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

export function startGatewayBackground(): void {
  // ---------------- Auto refresh quota (nền, ÁP NÓNG) ----------------
  // Timer tự lên lịch lại mỗi vòng → bật/tắt & đổi chu kỳ có hiệu lực NGAY, không cần restart.
  let quotaTimer: NodeJS.Timeout | null = null;
  const scheduleQuotaLoop = () => {
    if (quotaTimer) clearTimeout(quotaTimer);
    const mins = Math.max(1, config.gateway.quota?.intervalMin ?? 30);
    quotaTimer = setTimeout(async () => {
      if (config.gateway.quota?.autoRefresh) {
        for (const a of pool.list().filter((x) => x.enabled)) {
          await waitWhileBusy();
          await refreshQuota(a).catch(() => {});
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      scheduleQuotaLoop();
    }, mins * 60_000);
    quotaTimer.unref?.();
  };
  scheduleQuotaLoop();

  /**
   * Một lượt refresh quota NGAY sau boot (giãn nhịp, nền).
   * `scheduleQuotaLoop` đợi hết `intervalMin` mới chạy lần đầu → sau mỗi restart, quota
   * hiển thị là dữ liệu cũ từ persist. Đo thật: tuổi trung vị 558 phút.
   */
  if (config.gateway.quota?.autoRefresh) {
    setTimeout(async () => {
      for (const a of pool.list().filter((x) => x.enabled && x.health !== 'dead')) {
        // NHƯỜNG ĐƯỜNG cho request thật: đo được 7/20 request stream thất bại khi vòng
        // refresh (700 account) chạy song song với tải. Quota là việc nền, không được
        // cạnh tranh với client.
        await waitWhileBusy();
        await refreshQuota(a).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
      }
    }, 5_000).unref?.();
  }

  // ---------------- Auto refresh TOKEN (nền) ----------------
  /**
   * Trước đây refresh hoàn toàn LƯỜI: token chỉ được làm mới khi có request tới và token
   * đã hết hạn. Cộng với việc access token không được persist, mỗi lần restart là 700
   * account cùng phải refresh khi tải ập đến — đúng kiểu 429 hàng loạt đã gặp.
   *
   * Nay chủ động làm mới TRƯỚC khi hết hạn, giãn nhịp để không tự tạo burst.
   */
  let tokenTimer: NodeJS.Timeout | null = null;
  const scheduleTokenLoop = () => {
    if (tokenTimer) clearTimeout(tokenTimer);
    tokenTimer = setTimeout(async () => {
      try {
        const aheadMs = Math.max(1, config.gateway.tokenRefreshAheadMin) * 60_000;
        const now = Date.now();
        const due = pool
          .list()
          .filter((a) => a.enabled && a.health !== 'dead')
          // Chỉ account ĐÃ có token và sắp hết hạn. Account chưa có token thì để
          // request đầu tiên tự lo — refresh sẵn cả pool sẽ tự tạo burst.
          .filter((a) => a.token && a.token.expiresAt - now < aheadMs);
        for (const a of due) {
          await waitWhileBusy();
          await ensureReady(a, dispatcherFor(a)).catch(() => {});
          await new Promise((r) => setTimeout(r, 300)); // giãn nhịp
        }
        if (due.length) savePersist();
      } catch {
        /* vòng sau thử lại */
      }
      scheduleTokenLoop();
    }, 60_000); // quét mỗi phút, chỉ đụng account sắp hết hạn
    tokenTimer.unref?.();
  };
  scheduleTokenLoop();

  // ---------------- Tự dò hạn mức Kiro (Kiro KHÔNG có API quota) ----------------
  // Mỗi vòng chỉ dò 1 LÔ NHỎ account chưa biết trạng thái → tránh đốt hạn mức thật.
  let probeTimer: NodeJS.Timeout | null = null;
  const scheduleKiroProbe = () => {
    if (probeTimer) clearTimeout(probeTimer);
    const hours = Math.max(1, config.gateway.kiroProbeHours);
    probeTimer = setTimeout(async () => {
      if (config.gateway.kiroProbeEnabled) {
        const batch = Math.max(1, config.gateway.kiroProbeBatch);
        // ưu tiên account chưa dò bao giờ, rồi tới account dò lâu nhất
        const targets = pool
          .candidates(Date.now(), 'kr')
          .filter((a) => a.enabled)
          .sort((x, y) => (x.liveStatus ? 1 : 0) - (y.liveStatus ? 1 : 0) || (x.lastUsed || 0) - (y.lastUsed || 0))
          .slice(0, batch);
        for (const a of targets) {
          try {
            const r = await checkLiveAccount(a);
            log(a.email, r.status === 'ok' ? 'info' : 'warn', `dò hạn mức Kiro: ${r.status} (${r.ms}ms)`);
          } catch {
            /* bỏ qua, vòng sau dò lại */
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (targets.length) savePersist();
      }
      scheduleKiroProbe();
    }, hours * 3600_000);
    probeTimer.unref?.();
  };
  scheduleKiroProbe();

  // Dọn lịch sử cũ (theo cấu hình, mặc định 90 ngày): lúc boot + mỗi 24h.
  const prune = () => {
    try {
      pruneQuotaHistory(config.gateway.quota?.historyDays ?? 90);
    } catch { /* bỏ qua */ }
  };
  prune();
  setInterval(prune, 24 * 3600_000).unref?.();
}
