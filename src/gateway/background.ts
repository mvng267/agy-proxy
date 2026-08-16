import { config } from '../config.js';
import { pruneQuotaHistory, pruneUsage, recordMetrics, pruneMetricsHistory, pruneSessionBody } from '../store/db.js';
import { pool, savePersist, ensureReady, dispatcherFor, refreshQuota, geminiPct, claudePct } from './pool.js';
import { PROVIDERS } from './providers/index.js';
import { log, checkLiveAccount } from './engine.js';
import { gatewayMetrics } from './metrics.js';
import { quetQuota, nhuongDuong, type QuotaLoopDeps } from './quotaLoop.js';

/**
 * Các job nền của gateway: auto refresh quota/token, dò hạn mức Kiro, dọn lịch sử.
 * Gọi một lần lúc đăng ký route — mọi timer đều unref để không giữ process sống.
 */

const nghi = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

/** Tổng số request đang chạy trong pool. */
const dangBan = () => pool.list().reduce((n, a) => n + (a.inflight || 0), 0);

/**
 * Nhường đường cho request thật, theo NGƯỠNG.
 *
 * Bản cũ (`waitWhileBusy`) đòi TỔNG inflight toàn pool = 0 — điều kiện không bao giờ đúng
 * khi 700 account phục vụ liên tục, nên nó biến thành `sleep(30s)` cố định trước MỖI
 * account. Đo thật trên production: vòng quota cần ~6 giờ trong khi chu kỳ đặt 4 giờ, và
 * lần đo cuối là 28,3 giờ trước.
 *
 * Ý định ban đầu vẫn giữ: job nền không tranh băng thông với client.
 */
const nhuong = () => nhuongDuong({ dangBan, nghi }, { tran: 4, toiDaCho: 10 });

/** Deps để vòng quét hạn mức chạy trên pool thật. */
function quotaDeps(danhSach: () => ReturnType<typeof pool.list>): QuotaLoopDeps {
  return {
    danhSach: () => danhSach() as never,
    // Kiro không có API hạn mức — `refreshQuota` trả `undefined` ngay ở dòng đầu
    // (`pool.ts` `if (!p.quota) return undefined`). Cho vào vòng chỉ tốn lượt chờ.
    coApiQuota: (a) => Boolean(PROVIDERS[(a as { provider: keyof typeof PROVIDERS }).provider]?.quota),
    doQuota: (a) => refreshQuota(a as never),
    dangBan,
    nghi,
    ghiLog: (m) => log('system', 'info', m),
  };
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
        /**
         * Bao gồm CẢ account đang tắt khi bật `autoDisable`.
         *
         * Bản trước lọc `x.enabled` — hợp lý khi người ta tắt account thủ công (không
         * định dùng thì đo làm gì). Nhưng với tự-tắt-theo-hạn-mức thì đó là bẫy chết:
         * account bị tắt vì cạn quota sẽ không bao giờ được refresh, quota đóng băng ở
         * giá trị cũ, và không bao giờ đủ điều kiện bật lại.
         */
        const soi = () => (config.gateway.autoDisable?.enabled
          ? pool.list().filter((x) => x.health !== 'dead')
          : pool.list().filter((x) => x.enabled));
        await quetQuota(quotaDeps(soi), { song: 6, nghiMs: 200, choMs: 1_000, toiDaCho: 10 });
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
    setTimeout(() => {
      // NHƯỜNG ĐƯỜNG cho request thật nằm trong `quetQuota` — đo được 7/20 request stream
      // thất bại khi vòng refresh (700 account) chạy song song với tải.
      void quetQuota(quotaDeps(() => pool.list().filter((x) => x.enabled && x.health !== 'dead')),
        { song: 6, nghiMs: 200, choMs: 1_000, toiDaCho: 10 });
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
        let loi = 0;
        for (const a of due) {
          await nhuong();
          // Đếm lỗi thay vì nuốt: đây là vòng làm mới token chủ động. Nuốt lỗi ở đây nghĩa
          // là không bao giờ biết token đang hỏng hàng loạt, cho tới khi request thật đâm vào.
          await ensureReady(a, dispatcherFor(a)).catch(() => { loi++; });
          await nghi(300); // giãn nhịp
        }
        if (due.length) {
          savePersist();
          if (loi) log('system', 'warn', `làm mới token: ${due.length - loi}/${due.length} ok · lỗi ${loi}`);
        }
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

  /**
   * Chụp metrics mỗi 60 giây vào DB.
   *
   * Vì sao cần: `gatewayMetrics` chỉ giữ cửa sổ trượt 5 phút TRONG RAM và tự xoá mẫu cũ,
   * nên trang /metrics buộc phải tự tích luỹ điểm trong RAM trình duyệt — F5 là trắng, và
   * restart server cũng mất sạch. Ghi xuống DB làm lịch sử bền vững.
   *
   * 60s chứ không phải 5s như nhịp poll của UI: 5s sinh ~17k dòng/ngày cho một thứ chỉ
   * để vẽ đường xu hướng; 60s còn ~1.4k dòng và vẫn đủ mịn.
   */
  const sampleMetrics = () => {
    try {
      const now = Date.now();
      const m = gatewayMetrics.snapshot(now);
      // Dùng chính `pool.candidates()` mà /api/metrics dùng — tự đếm lại bằng tay sẽ lệch
      // với con số hiển thị trên KPI (và `cooldownUntil` là epoch ms chứ không phải cờ).
      recordMetrics({
        // Làm tròn về mốc phút để điểm rơi đều trục thời gian; `ts` là PRIMARY KEY nên
        // hai lần chụp trong cùng một phút sẽ đè nhau thay vì tạo dòng lệch nhịp.
        ts: Math.floor(Date.now() / 60_000) * 60_000,
        rps: m.rps,
        errorRate: m.errorRate,
        p50: m.latency?.p50 ?? null,
        p95: m.latency?.p95 ?? null,
        p99: m.latency?.p99 ?? null,
        requests: m.requests,
        errors: m.errors,
        accTotal: pool.list().length,
        accAvailable: pool.candidates(now).length,
      });
    } catch { /* mất một điểm không đáng để làm sập job nền */ }
  };
  sampleMetrics();
  setInterval(sampleMetrics, 60_000).unref?.();

  // Dọn lịch sử cũ (theo cấu hình, mặc định 90 ngày): lúc boot + mỗi 24h.
  const prune = () => {
    try {
      pruneQuotaHistory(config.gateway.quota?.historyDays ?? 90);
      pruneMetricsHistory(config.gateway.quota?.historyDays ?? 90);
      // gateway_usage TRƯỚC ĐÂY không bao giờ được dọn (pruneUsage có sẵn mà không
      // nơi nào gọi) — chỉ lớn dần mãi. 0 = giữ vĩnh viễn.
      pruneUsage(config.gateway.usageRetentionDays);
      // Thân phiên nặng hơn usage nhiều (p90 273 KB/phiên) nên mặc định chỉ giữ 7 ngày.
      pruneSessionBody(config.gateway.sessionBodyDays ?? 7);
    } catch { /* bỏ qua */ }
  };
  prune();
  setInterval(prune, 24 * 3600_000).unref?.();

  startAutoDisableLoop();
}

/**
 * Quét cả pool mỗi ngày: TẮT account đã cạn hạn mức, BẬT LẠI khi Google reset.
 *
 * Vì sao cần: đo thật trên production — pool 351 account có 65 cái quota 0% nằm lẫn với
 * 203 cái còn 100%. Chiến lược xoay vẫn chọn phải chúng, mỗi lần tốn ~6 giây rồi 429.
 * Có request thử 20 account liên tiếp, mất hơn 2 phút rồi vẫn hỏng, trong khi 203 account
 * đầy quota nằm không. Tắt account cạn là bỏ chúng khỏi vòng xoay cho tới khi hồi.
 *
 * BẪY LỚN NHẤT: vòng refresh quota thường CHỈ chạy cho account `enabled`. Nếu job này tắt
 * một account thì quota của nó đóng băng mãi mãi ở giá trị cũ → không bao giờ đủ điều kiện
 * bật lại. Nên ở đây phải tự refresh cho CẢ account đang tắt (xem `refreshQuota` bên dưới).
 */
export async function runAutoDisableSweep(): Promise<{
  checked: number; disabled: number; enabled: number; skipped: number;
}> {
  const cfg = config.gateway.autoDisable;
  const off = Math.max(0, cfg.offAtPct);
  // Ngưỡng bật phải CAO hơn ngưỡng tắt. Bằng nhau thì account dao động quanh mốc đó sẽ
  // bật/tắt liên tục mỗi ngày (hiện tượng chattering).
  const on = Math.max(off + 1, cfg.onAtPct);

  let checked = 0, disabled = 0, enabledBack = 0, skipped = 0;

  /**
   * PHA 1 — đo hạn mức cả pool, SONG SONG.
   *
   * Bản cũ đo tuần tự ngay trong vòng xét, mỗi account chờ `waitWhileBusy()` tới 30 giây.
   * Với 703 account thì một lượt quét mất tới ~6 giờ — vòng hẹn 3h sáng có thể chạy tới
   * trưa, và nó GHI `a.enabled` dựa trên quota đo được nhiều giờ trước.
   *
   * force=false: tôn trọng TTL cache. Job chạy 1 lần/ngày nên cache 10 phút không cản gì,
   * mà lại tránh gọi upstream thừa khi vừa có vòng refresh khác chạy qua.
   */
  await quetQuota(quotaDeps(() => pool.list()), { song: 6, nghiMs: 200, choMs: 1_000, toiDaCho: 10 });

  // PHA 2 — xét bật/tắt. Thuần RAM, không gọi mạng, nên chạy tuần tự là đủ nhanh.
  for (const a of pool.list()) {
    // 'dead' là account hỏng vĩnh viễn (401/invalid_grant) — quota không cứu được,
    // và bật lại chỉ tạo lỗi. Chỉ người kiểm thủ công mới gỡ được trạng thái này.
    if (a.health === 'dead') { skipped++; continue; }
    checked++;

    /**
     * Xét MỌI BỂ, không chỉ bể đầu tiên.
     *
     * Antigravity chia 2 bể ĐỘC LẬP (Gemini · Claude+GPT) với hạn mức riêng. Bản trước
     * dùng `geminiPct(a) ?? claudePct(a)` — toán tử `??` chỉ rơi sang Claude khi Gemini
     * là null, nên account cạn Gemini mà còn Claude vẫn bị tắt.
     *
     * Đã xảy ra thật: quét ngày 10/08 tắt cả 351 account vì Gemini 0%, trong đó 233 cái
     * còn quota Claude trung bình 76%. Model `agy/claude-*` chết hẳn — gọi vào nhận
     * "không có account khả dụng" dù pool còn dư dả.
     *
     * Quy tắc đúng: account còn DÙNG ĐƯỢC nếu CÒN ÍT NHẤT MỘT bể có hạn mức. Chỉ tắt khi
     * mọi bể đều cạn. Cooldown theo bể (`bucketCooldown`) đã lo phần "đừng gọi bể đã cạn".
     */
    const buckets = [geminiPct(a), claudePct(a)].filter((x): x is number => x != null);
    if (!buckets.length) { skipped++; continue; } // chưa đo được thì đừng đoán

    const best = Math.max(...buckets);
    const moTa = buckets.length > 1 ? `các bể: ${buckets.join('%, ')}%` : `${best}%`;

    if (a.enabled && best <= off) {
      a.enabled = false;
      disabled++;
      log(a.email, 'warn', `Tự tắt: mọi bể đều cạn (${moTa}, ngưỡng ≤${off}%)`);
    } else if (!a.enabled && best >= on) {
      a.enabled = true;
      enabledBack++;
      log(a.email, 'info', `Tự bật lại: còn hạn mức (${moTa}, ngưỡng ≥${on}%)`);
    }
  }

  savePersist();
  log('system', 'info',
    `Quét hạn mức xong: ${checked} account · tắt ${disabled} · bật lại ${enabledBack} · bỏ qua ${skipped}`);
  return { checked, disabled, enabled: enabledBack, skipped };
}

/** Hẹn giờ chạy `runAutoDisableSweep` mỗi ngày vào `autoDisable.hour`. */
function startAutoDisableLoop(): void {
  const schedule = () => {
    const cfg = config.gateway.autoDisable;
    const now = new Date();
    const next = new Date(now);
    next.setHours(Math.min(23, Math.max(0, cfg.hour)), 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    /**
     * Hẹn theo MỐC GIỜ tuyệt đối, không phải `setInterval(24h)`.
     * setInterval trôi dần theo thời gian xử lý mỗi vòng và nhảy lung tung sau khi máy
     * ngủ/thức; hẹn theo mốc thì luôn chạy đúng giờ đã chọn.
     */
    const t = setTimeout(async () => {
      if (config.gateway.autoDisable.enabled) {
        await runAutoDisableSweep().catch((e) => log('system', 'error', `Quét hạn mức lỗi: ${e?.message ?? e}`));
      }
      schedule(); // tự lên lịch lại → đổi giờ trong cấu hình có hiệu lực từ vòng sau
    }, next.getTime() - now.getTime());
    t.unref?.();
  };
  schedule();
}
