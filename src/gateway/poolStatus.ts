import type { FastifyInstance } from 'fastify';
import { providerStats, usageSamples } from '../store/db.js';
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from './providers/index.js';
import { pool, syncFromStore, refreshQuota, geminiPct, claudePct, type PoolAccount } from './pool.js';
import { log, accOf } from './engine.js';
import { gatewayMetrics } from './metrics.js';
import { runAutoDisableSweep } from './background.js';
import { providerBreaker } from './breaker.js';

/**
 * Hạn mức và trạng thái pool NGAY LÚC NÀY.
 *
 * Khác `reports.ts` ở nguồn dữ liệu, không phải ở chủ đề: ở đây đọc `pool` trong RAM và
 * gọi upstream để làm mới quota; bên kia đọc lịch sử đã ghi xuống SQLite. Gộp hai thứ vì
 * cùng chữ "quota" là cách chắc chắn để rồi có người sửa nhầm chỗ.
 */

/**
 * Quét làm mới quota là việc NẶNG (chạm mọi account) nên chỉ cho một lượt chạy.
 * Cờ ở module-scope, không phải trong hàm đăng ký — hàm chỉ chạy một lần lúc boot,
 * nhưng để trong đó thì ý "chỉ một lượt" đọc như thể phụ thuộc vào lời gọi đăng ký.
 */
let sweepRunning = false;

export function registerPoolStatusRoutes(app: FastifyInstance): void {
  /**
   * Chạy NGAY vòng quét tắt/bật theo hạn mức, không đợi tới giờ hẹn.
   *
   * Cần cho hai việc: thử ngay sau khi bật tính năng (không ai muốn chờ tới 3h sáng mới
   * biết nó có chạy đúng không), và dọn pool thủ công khi thấy nhiều account cạn.
   */
  app.post('/api/gateway/quota/sweep', async (_req, reply) => {
    if (sweepRunning) {
      // Vòng quét đụng toàn bộ pool và tự gọi upstream — chạy chồng là nhân đôi tải
      // và hai vòng ghi đè `enabled` của nhau.
      return reply.code(409).send({ ok: false, error: 'Vòng quét đang chạy' });
    }
    sweepRunning = true;
    try {
      syncFromStore();
      const r = await runAutoDisableSweep();
      return { ok: true, ...r };
    } finally {
      sweepRunning = false;
    }
  });

  app.post('/api/gateway/quota/refresh', async (req) => {
    const { emails } = (req.body as { emails?: string[] }) ?? {};
    const q = (req.query ?? {}) as any;
    const only = q.provider && PROVIDERS[q.provider as ProviderId] ? (q.provider as ProviderId) : undefined;
    syncFromStore();
    const targets = (emails && emails.length
      ? emails.map((e) => (e.includes(':') ? pool.getByKey(e) : pool.get(e, only ?? 'agy'))).filter(Boolean)
      : pool.list(only).filter((a) => a.enabled)) as PoolAccount[];
    // chạy nền tuần tự, giãn nhịp nhẹ
    (async () => {
      let done = 0;
      for (const a of targets) {
        try {
          await refreshQuota(a, true);
          done++;
          log(a.email, 'info', `quota ${geminiPct(a) ?? '?'}% (refresh ${done}/${targets.length})`);
        } catch (e: any) {
          log(a.email, 'warn', `quota lỗi: ${String(e?.message ?? e).slice(0, 80)}`);
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    })().catch(() => {});
    return { queued: targets.length };
  });

  app.post('/api/gateway/quota/:email', async (req, reply) => {
    const { email } = req.params as { email: string };
    syncFromStore();
    const a = accOf(req, email);
    if (!a) return reply.code(404).send({ error: 'không có account' });
    try {
      const q = await refreshQuota(a, true);
      return { ok: true, email, quota: q };
    } catch (e: any) {
      return reply.code(502).send({ ok: false, error: e?.message ?? String(e) });
    }
  });

  /**
   * Health/metrics tức thời cho monitoring poll dày (dashboard KPI, alerting):
   * cửa sổ trượt 5 phút trong RAM (không quét DB) + trạng thái pool hiện tại.
   * Khác /api/gateway/stats (xu hướng dài hạn, đọc DB) — xem ghi chú ở metrics.ts.
   */
  app.get('/api/metrics', async () => {
    const now = Date.now();
    const accounts = Object.fromEntries(
      PROVIDER_IDS.map((pid) => {
        const all = pool.list(pid);
        return [pid, {
          total: all.length,
          available: pool.candidates(now, pid).length,
          inflight: all.reduce((s, a) => s + a.inflight, 0),
        }];
      }),
    );
    return {
      now,
      uptimeSec: Math.round(process.uptime()),
      window: gatewayMetrics.snapshot(now),
      accounts,
      breaker: providerBreaker.snapshot(now),
      rssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    };
  });

  /**
   * Số liệu hiệu năng để vẽ biểu đồ: tỉ lệ thành công + p95 độ trễ mỗi provider,
   * cộng mẫu `ms`/`ok` thô cho histogram. providerStats() vốn đã tính sẵn cho việc
   * chấm điểm định tuyến nhưng CHƯA từng có endpoint nào expose ra UI.
   */
  app.get('/api/gateway/stats', async (req) => {
    const q = (req.query ?? {}) as any;
    const days = Math.min(90, Math.max(1, Number(q.days) || 7));
    const since = Date.now() - days * 86400_000;
    // LIMIT trong SQL — kéo cả 90 ngày vào JS rồi mới slice là quét thừa trên bảng lớn.
    const samples = usageSamples(since, 3000);
    return {
      days,
      providers: providerStats(since).map((p) => ({
        ...p,
        label: PROVIDERS[p.provider as ProviderId]?.label ?? p.provider,
      })),
      samples,
    };
  });

  /**
   * Tổng hợp hạn mức — TÁCH THEO PROVIDER, vì hai bên có mô hình khác hẳn nhau:
   *
   *   agy (Antigravity)  2 bể độc lập theo tuần: "Gemini Models" và "Claude and GPT
   *                      models", mỗi bể % riêng + resetTime riêng, kèm % từng model.
   *   kr  (Kiro)         1 quỹ credit theo THÁNG: 50 credit gói FREE, mỗi model tiêu
   *                      credit khác nhau (haiku 0.4 · sonnet 1.3). Không có bể nào.
   *
   * Bản trước gộp cả 702 account vào một phép trung bình `geminiAvg` — nhưng
   * `geminiPct()` với Kiro trả về chính quỹ credit (cố ý, để rotation xếp hạng được).
   * Hệ quả: con số "Gemini TB 85%" trộn 351 account Antigravity với 351 account Kiro
   * vốn không có Gemini. Số đúng về mặt số học, vô nghĩa về mặt ý nghĩa.
   *
   * Giữ nguyên các trường cũ ở cấp gốc cho client đang dùng; thêm `byProvider`.
   */
  app.get('/api/gateway/quota-summary', async () => {
    const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : null);
    const withQuota = pool.list().filter((a) => a.quota);

    const byProvider: Record<string, unknown> = {};
    for (const pid of PROVIDER_IDS) {
      const list = pool.list(pid).filter((a) => a.quota);
      if (!pool.list(pid).length) continue;

      const tiers: Record<string, number> = {};
      for (const a of list) if (a.quota?.tier) tiers[a.quota.tier] = (tiers[a.quota.tier] || 0) + 1;

      // Có chia bể hay không quyết định cách hiển thị — UI đọc cờ này thay vì tự đoán
      // theo tên provider (thêm provider mới sẽ không phải sửa UI).
      const buckets = PROVIDERS[pid].models.some((m) => m.bucket);
      const base = {
        provider: pid,
        label: PROVIDERS[pid].label,
        fetched: list.length,
        total: pool.list(pid).length,
        tiers,
        /** `buckets` = nhiều bể độc lập · `credits` = một quỹ chung. */
        kind: buckets ? ('buckets' as const) : ('credits' as const),
      };

      if (buckets) {
        const gem = list.map((a) => geminiPct(a)).filter((x): x is number => x != null);
        const cla = list.map((a) => claudePct(a)).filter((x): x is number => x != null);
        byProvider[pid] = {
          ...base,
          groups: [
            { key: 'gemini', label: 'Gemini', avg: avg(gem), min: gem.length ? Math.min(...gem) : null, n: gem.length },
            { key: 'claude', label: 'Claude/GPT', avg: avg(cla), min: cla.length ? Math.min(...cla) : null, n: cla.length },
          ],
        };
      } else {
        // Một quỹ duy nhất: lấy thẳng nhóm đầu, không đi qua geminiPct để tên nhóm
        // giữ đúng nguyên bản upstream ('Credits') thay vì bị gắn nhãn 'Gemini'.
        const pcts = list.map((a) => a.quota?.groups?.[0]?.pct).filter((x): x is number => x != null);
        const name = list.find((a) => a.quota?.groups?.[0]?.name)?.quota?.groups?.[0]?.name ?? 'Credits';
        byProvider[pid] = {
          ...base,
          groups: [{ key: 'credits', label: name, avg: avg(pcts), min: pcts.length ? Math.min(...pcts) : null, n: pcts.length }],
        };
      }
    }

    // ── Tương thích ngược: client cũ (CLI, MCP, skill) vẫn đọc các trường này ──
    const gemAll = withQuota.map((a) => geminiPct(a) ?? 0);
    const tpAll = withQuota.map((a) => a.quota?.groups?.find((g) => !/gemini/i.test(g.name))?.pct ?? 0);
    const tierCount: Record<string, number> = {};
    for (const a of withQuota) if (a.quota?.tier) tierCount[a.quota.tier] = (tierCount[a.quota.tier] || 0) + 1;

    return {
      fetched: withQuota.length,
      total: pool.list().length,
      geminiAvg: avg(gemAll),
      geminiMin: gemAll.length ? Math.min(...gemAll) : null,
      thirdPartyAvg: avg(tpAll),
      tiers: tierCount,
      byProvider,
    };
  });
}
