import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import {
  usageTotals, usageSeries, usageByModel, usageByAccount, usageRows, usageSamples,
  usageLogs, usageFacets, usageByApiKey, usageByCombo, attributionSince, thanPhien, usageErrors, type UsageFilter,
  quotaSeries, quotaForAccount, quotaHistoryCount,
  comboRuns, comboStepStats, comboRunFacets, type ComboRunFilter,
  metricsSeries, metricsHistoryCount,
} from '../store/db.js';
import { listPublicApiKeys } from './apikeys.js';
import { listCombos } from './engine.js';
import { allModels } from './providers/index.js';

/**
 * Báo cáo: usage, lịch sử combo, lịch sử hạn mức, metrics.
 *
 * Tách khỏi `admin.ts` (1.139 dòng) vì nhóm này tự thành một khối: mọi endpoint ở đây chỉ
 * ĐỌC và tổng hợp, không đụng pool hay gọi upstream. `rangeOf`/`filterOf` cũng chỉ dùng
 * trong phạm vi này.
 */
export function registerReportRoutes(app: FastifyInstance): void {
  // ---------------- Báo cáo sử dụng ----------------
  function rangeOf(req: FastifyRequest): { from: number; to: number; groupBy: 'hour' | 'day' | 'week' } {
    const q = req.query as any;
    const to = q.to ? Number(q.to) : Date.now();
    const days = q.range === '1d' ? 1 : q.range === '30d' ? 30 : q.range === '90d' ? 90 : 7;
    const from = q.from ? Number(q.from) : to - days * 86400_000;

    /**
     * Mức gộp TỰ CHỌN theo độ dài khoảng, trừ khi client chỉ định.
     *
     * Gộp theo ngày cho khoảng 24 giờ thì biểu đồ chỉ có 1–2 cột — vô dụng. Đây đúng
     * là lỗi đã gặp với biểu đồ quota (14.633 điểm dồn vào một ngày) và đã sửa ở đó;
     * usage thì chưa.
     */
    const span = Math.max(0, to - from);
    const auto: 'hour' | 'day' | 'week' =
      span <= 3 * 86400_000 ? 'hour' : span <= 60 * 86400_000 ? 'day' : 'week';
    const groupBy =
      q.groupBy === 'week' || q.groupBy === 'day' || q.groupBy === 'hour' ? q.groupBy : auto;
    return { from, to, groupBy };
  }

  /** Bộ lọc báo cáo lấy từ query — trống nghĩa là không lọc theo tiêu chí đó. */
  const filterOf = (req: FastifyRequest): UsageFilter => {
    const q = (req.query ?? {}) as any;
    const chuoi = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    // `ok`/`stream` là ba trạng thái: có lọc true, có lọc false, hoặc không lọc.
    // Đọc bằng `=== 'true'` thì 'false' và thiếu tham số gộp làm một → sai.
    const bool = (v: unknown) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : undefined);
    return {
      apiKeyId: chuoi(q.apiKeyId),
      combo: chuoi(q.combo),
      email: chuoi(q.email),
      model: chuoi(q.model),
      endpoint: chuoi(q.endpoint),
      provider: chuoi(q.provider),
      status: Number.isFinite(Number(q.status)) && q.status !== '' && q.status !== undefined ? Number(q.status) : undefined,
      ok: bool(q.ok),
      stream: bool(q.stream),
    };
  };

  /**
   * Lịch sử chạy combo — TỪNG BƯỚC.
   *
   * `combo_runs` ghi đủ chi tiết từ lâu nhưng chưa endpoint nào phơi ra: hàm đọc duy nhất
   * `comboStatsRows` chỉ trả hai con số tổng. Production có 19.180 dòng mà không ai xem
   * được bước nào trượt và vì sao — trong khi bước 1 của `translate-question` trượt 100%
   * (6.828 lần, không lần nào thành công) và vẫn tốn thêm ~54 giây p95 cho mỗi request.
   */
  app.get('/api/combos/runs', async (req) => {
    const { from, to } = rangeOf(req);
    const q = (req.query ?? {}) as any;
    const f: ComboRunFilter = {
      combo: q.combo ? String(q.combo) : undefined,
      model: q.model ? String(q.model) : undefined,
      ok: q.ok === '0' || q.ok === '1' ? String(q.ok) : undefined,
      status: q.status ? String(q.status) : undefined,
    };
    const limit = Number(q.limit) > 0 ? Number(q.limit) : 100;
    const offset = Number(q.offset) > 0 ? Number(q.offset) : 0;
    const { rows, total } = comboRuns(from, to, f, limit, offset);
    return {
      rows,
      total,
      limit,
      offset,
      // Gộp theo (combo, bước, model) — trả lời "BƯỚC NÀO hay trượt nhất", thứ mà
      // comboStatsRows không nói được (nó chỉ đếm tổng số lần phải trượt).
      steps: comboStepStats(from, to, f),
      facets: comboRunFacets(from, to, f),
      period: { from, to },
    };
  });

  app.get('/api/gateway/usage', async (req) => {
    const { from, to, groupBy } = rangeOf(req);
    const f = filterOf(req);
    // Nhãn key: usage chỉ lưu id, UI cần tên để hiển thị "Hermes" thay vì "ak_1a2b…".
    const names = new Map(listPublicApiKeys().map((k) => [k.id, k.name]));
    const byApiKey = usageByApiKey(from, to, f).map((r) => ({
      ...r,
      name: r.apiKeyId === 'legacy' ? 'Key mặc định' : r.apiKeyId ? names.get(r.apiKeyId) ?? '(đã xoá)' : '(không key)',
    }));
    return {
      totals: usageTotals(from, to, f),
      series: usageSeries(from, to, groupBy, f),
      byModel: usageByModel(from, to, f),
      byAccount: usageByAccount(from, to, f),
      byApiKey,
      byCombo: usageByCombo(from, to, f),
      /**
       * Mốc bắt đầu ghi attribution. Dữ liệu TRƯỚC mốc này không có api_key_id/combo
       * (cột chỉ có từ schema v3) — UI phải nói rõ, nếu không người dùng tưởng hỏng.
       */
      attributionSince: attributionSince(),
    };
  });

  /**
   * Từng request một — để đối chiếu và truy vết, thứ mà các bảng tổng hợp không làm được
   * ("429 nhiều nhất ở model nào, account nào, lúc mấy giờ").
   *
   * Phân trang phía SERVER: bảng đã có hàng chục nghìn dòng, kéo hết về trình duyệt rồi
   * mới cắt là treo máy. `facets` liệt kê giá trị CÓ THẬT trong khoảng để dựng dropdown,
   * tránh việc người dùng đoán mã lỗi rồi lọc ra bảng rỗng.
   */
  app.get('/api/gateway/usage/logs', async (req) => {
    const { from, to } = rangeOf(req);
    const q = (req.query ?? {}) as any;
    const limit = Number(q.limit) > 0 ? Number(q.limit) : 100;
    const offset = Number(q.offset) > 0 ? Number(q.offset) : 0;
    const f = filterOf(req);
    const { rows, total } = usageLogs(from, to, f, limit, offset);
    const names = new Map(listPublicApiKeys().map((k) => [k.id, k.name]));
    return {
      rows: rows.map((r) => ({
        ...r,
        keyName: r.apiKeyId === 'legacy' ? 'Key mặc định' : r.apiKeyId ? names.get(r.apiKeyId) ?? '(đã xoá)' : '',
      })),
      total,
      limit,
      offset,
      facets: usageFacets(from, to, f),
      attributionSince: attributionSince(),
    };
  });

  /**
   * Gom lỗi theo THÔNG ĐIỆP — trả lời "đang lỗi gì" mà không phải cuộn log thô.
   *
   * Đây là câu hỏi vận hành số một, và trước đây không có đường nào trả lời: `err` chỉ
   * hiện từng dòng rời rạc trong 13.100 dòng log.
   */
  app.get('/api/gateway/usage/errors', async (req) => {
    const { from, to } = rangeOf(req);
    const nhom = usageErrors(from, to, filterOf(req));
    return {
      nhom,
      tong: nhom.reduce((s, x) => s + x.n, 0),
    };
  });

  /**
   * TOÀN BỘ một phiên: nội dung gửi/nhận + mọi bước đã đi qua.
   *
   * Một request client sinh N dòng `gateway_usage` (mỗi bước combo một dòng) nhưng chỉ có
   * MỘT thân. Đo trên production: 12% request phải thử nhiều account, nhiều nhất 7 lần —
   * log phẳng nên chúng hiện thành 7 dòng rời rạc, không thấy quan hệ.
   */
  app.get('/api/gateway/usage/session/:requestId', async (req, reply) => {
    const { requestId } = req.params as { requestId: string };
    if (!requestId) return reply.code(400).send({ error: 'thiếu requestId' });
    const buoc = usageLogs(0, Date.now(), { requestId }, 50, 0);
    if (!buoc.rows.length) return reply.code(404).send({ error: 'không có phiên này' });
    return {
      requestId,
      than: thanPhien(requestId) ?? null,
      buoc: buoc.rows,
      tongMs: buoc.rows.reduce((s, r) => s + (r.ms ?? 0), 0),
    };
  });

  /**
   * So sánh kỳ này với kỳ TRƯỚC ĐÓ cùng độ dài — "tuần này so tuần trước".
   * Một con số tuyệt đối không nói lên điều gì nếu không có mốc để đối chiếu.
   */
  app.get('/api/gateway/usage/compare', async (req) => {
    const { from, to } = rangeOf(req);
    const f = filterOf(req);
    const doDai = to - from;
    const hienTai = usageTotals(from, to, f);
    const truocDo = usageTotals(from - doDai, from, f);
    const delta = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : a > 0 ? 100 : 0);
    return {
      current: hienTai,
      previous: truocDo,
      changePct: {
        requests: delta(hienTai.requests, truocDo.requests),
        tokIn: delta(hienTai.tokIn, truocDo.tokIn),
        tokOut: delta(hienTai.tokOut, truocDo.tokOut),
        accounts: delta(hienTai.accounts, truocDo.accounts),
      },
      period: { from, to, previousFrom: from - doDai, previousTo: from },
    };
  });

  app.get('/api/gateway/usage/export.csv', async (req, reply) => {
    const { from, to } = rangeOf(req);
    const rows = usageRows(from, to, filterOf(req));
    // Cột mới thêm vào CUỐI dòng — chèn giữa sẽ phá script người dùng đang parse theo vị trí.
    const head = 'ts,datetime,email,model,prompt_tokens,completion_tokens,ok,ms,api_key_id,combo,endpoint,status,request_id,stream,err\n';
    const csv = (v: unknown) => {
      const t = v == null ? '' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const body = rows
      .map((r) => [
        r.ts, new Date(r.ts).toISOString(), r.email, r.model, r.promptTokens, r.completionTokens,
        r.ok ? 1 : 0, r.ms, r.apiKeyId, r.combo, r.endpoint, r.status, r.requestId,
        r.stream == null ? '' : r.stream ? 1 : 0, r.err,
      ].map(csv).join(','))
      .join('\n');
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="gateway-usage.csv"');
    return head + body;
  });

  // ---------------- Lịch sử hạn mức ----------------
  app.get('/api/gateway/quota/history', async (req) => {
    const q = req.query as any;
    const to = q.to ? Number(q.to) : Date.now();
    const days = q.range === '90d' ? 90 : q.range === '30d' ? 30 : q.range === '1d' ? 1 : 7;
    const from = q.from ? Number(q.from) : to - days * 86400_000;
    // `provider` lọc cả hai nhánh: một email có CẢ agy lẫn kr, không lọc thì hai đường
    // quota khác hẳn nhau vẽ chung một nét (xem migration v6).
    const prov = q.provider ? String(q.provider) : undefined;
    if (q.email) {
      return { email: q.email, provider: prov ?? null, points: quotaForAccount(String(q.email), from, to, prov) };
    }

    /**
     * Gộp theo NGÀY cho cửa sổ ≥7 ngày là đúng khi đã chạy nhiều ngày, nhưng sai hẳn lúc
     * mới bật: đo trên production có 14.6k điểm mà TẤT CẢ rơi vào một ngày → gộp theo ngày
     * ra ĐÚNG 1 điểm, và một điểm thì không vẽ thành đường. Khung "Xu hướng toàn pool" vì
     * thế luôn trống dù dữ liệu đầy — người dùng thấy "Chưa có dữ liệu" và tưởng job hỏng.
     *
     * Nên tự hạ xuống mức mịn hơn khi kết quả quá thưa. Cùng dữ liệu đó, gộp theo giờ cho
     * 14 điểm — vẽ được ngay.
     */
    const chosen = q.groupBy === 'hour' || q.groupBy === 'day'
      ? (q.groupBy as 'hour' | 'day')
      : days <= 1 ? 'hour' : 'day';
    let series = quotaSeries(from, to, chosen, prov);
    let groupBy: 'hour' | 'day' = chosen;
    if (!q.groupBy && groupBy === 'day' && series.length < 3) {
      const finer = quotaSeries(from, to, 'hour', prov);
      if (finer.length > series.length) { series = finer; groupBy = 'hour'; }
    }
    // `providers` để UI biết cần vẽ mấy đường mà không phải tự dò trong series.
    const providers = [...new Set(series.map((x) => x.provider).filter((x): x is string => !!x))].sort();
    return { series, providers, groupBy, total: quotaHistoryCount() };
  });

  /**
   * Lịch sử metrics — nguồn 3 chart trang /metrics.
   *
   * Trước đây trang đó tự tích luỹ điểm trong RAM trình duyệt nên F5 là trắng và phải
   * chờ ≥2 lần poll mới vẽ được gì. Job nền ghi mỗi 60s xuống `metrics_history`, endpoint
   * này đọc ra.
   *
   * Tự chọn độ mịn theo cửa sổ: ≤6h giữ nguyên từng điểm 1 phút; dài hơn thì gộp để
   * không đẩy hàng chục nghìn điểm xuống trình duyệt (7 ngày = 10k điểm nếu để raw).
   */

  app.get('/api/metrics/history', async (req) => {
    const q = req.query as any;
    const to = q.to ? Number(q.to) : Date.now();
    const hours = Math.max(1, Math.min(24 * 90, Number(q.hours) || 6));
    const from = q.from ? Number(q.from) : to - hours * 3600_000;
    const chosen: 'raw' | 'minute' | 'hour' =
      q.groupBy === 'raw' || q.groupBy === 'minute' || q.groupBy === 'hour'
        ? q.groupBy
        : hours <= 6 ? 'raw' : hours <= 48 ? 'minute' : 'hour';
    let series = metricsSeries(from, to, chosen);
    let groupBy = chosen;
    // Cùng lý do như quota/history: gộp thô quá thì cửa sổ dài ra 1-2 điểm và chart trống.
    if (!q.groupBy && groupBy !== 'raw' && series.length < 3) {
      const finer = metricsSeries(from, to, 'raw');
      if (finer.length > series.length) { series = finer; groupBy = 'raw'; }
    }
    return { series, groupBy, from, to, total: metricsHistoryCount() };
  });
}
