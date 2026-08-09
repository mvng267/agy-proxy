import { z } from 'zod';

/**
 * Danh mục tool MCP — ALLOWLIST, không phải blocklist.
 *
 * Vì sao bắt buộc là allowlist: `agyproxy routes` sinh danh sách endpoint bằng cách QUÉT
 * source, nên mỗi lần backend thêm route mới nó tự động xuất hiện. Nếu ở đây dùng
 * blocklist thì route mới sẽ tự lọt vào tay AI agent — kể cả route nguy hiểm chưa kịp
 * phân loại. Thêm tool phải là hành động CÓ Ý.
 *
 * Ba nhóm endpoint bị chặn có chủ đích, không đưa vào đây:
 *
 *  1. Mất quyền / mất dữ liệu: `security/password` (agent tự khoá chủ ra ngoài),
 *     `DELETE accounts|keys|proxies|combos`, `backup/import` (mode replace ghi đè cả DB),
 *     `backup/export` + `credentials` + `config?reveal=1` (lộ token, key nguyên văn),
 *     `regenerateKey` (mọi client đang dùng chết ngay).
 *
 *  2. Gián đoạn dịch vụ: `system/restart`, `system/update`, `config {enabled:false}`,
 *     `accounts/bulk` (không kèm `emails` là áp cho TOÀN BỘ pool — tắt sạch 700 account).
 *
 *  3. Tốn kém / tự hại: `accounts/check` quét cả pool ~1.2s mỗi account (700 account =
 *     ~14 phút) và chạy dày sẽ bị upstream chặn tốc độ — tự giết pool. `run*` khởi động
 *     Playwright automation thật. `chat` để agent tự tiêu quota trong vòng lặp.
 */

/** @typedef {{ name:string, title:string, description:string, schema:object, write?:boolean, call:(a:any)=>{method:string,path:string,body?:any} }} Tool */

const providerEnum = z.enum(['agy', 'kr']).describe('agy = Antigravity (Gemini), kr = Kiro (Claude)');

/** @type {Tool[]} */
export const TOOLS = [
  // ── Đọc: gọi tự do ───────────────────────────────────────────────────────
  {
    name: 'agyproxy_overview',
    title: 'Tổng quan agyproxy',
    description:
      'Bức tranh tổng: số account, pool bật/cooldown/chết, quota trung bình, lưu lượng 7 ngày. ' +
      'Gọi đầu tiên khi cần biết hệ thống đang thế nào.',
    schema: {},
    call: () => ({ method: 'GET', path: '/api/overview' }),
  },
  {
    name: 'agyproxy_metrics',
    title: 'Số liệu tức thời',
    description:
      'Cửa sổ trượt 5 phút: rps, tỉ lệ lỗi, độ trễ p50/p95/p99, số request đang bay, ' +
      'trạng thái circuit breaker từng provider. Dùng để chẩn đoán "đang chậm/lỗi không".',
    schema: {},
    call: () => ({ method: 'GET', path: '/api/metrics' }),
  },
  {
    name: 'agyproxy_metrics_history',
    title: 'Lịch sử số liệu',
    description: 'Chuỗi thời gian rps / tỉ lệ lỗi / độ trễ / số account khả dụng. Dùng để thấy xu hướng.',
    schema: { hours: z.number().int().min(1).max(2160).default(6).describe('Số giờ nhìn lại, mặc định 6') },
    call: (a) => ({ method: 'GET', path: `/api/metrics/history?hours=${a.hours ?? 6}` }),
  },
  {
    name: 'agyproxy_accounts',
    title: 'Danh sách account trong pool',
    description:
      'Từng account: bật/tắt, sức khoẻ, cooldown còn lại, % quota, số request, lỗi gần nhất. ' +
      'Dùng để tìm account nào đang hỏng hoặc sắp hết hạn mức.',
    schema: { provider: providerEnum.optional() },
    call: (a) => ({ method: 'GET', path: `/api/gateway/accounts${a.provider ? `?provider=${a.provider}` : ''}` }),
  },
  {
    name: 'agyproxy_quota_summary',
    title: 'Tổng hợp hạn mức',
    description: 'Quota trung bình/thấp nhất toàn pool, phân bố theo tier. Nhanh hơn duyệt từng account.',
    schema: {},
    call: () => ({ method: 'GET', path: '/api/gateway/quota-summary' }),
  },
  {
    name: 'agyproxy_models',
    title: 'Model khả dụng',
    description:
      'Danh sách model gọi được, kèm id đã có prefix provider (dùng thẳng khi gọi API). ' +
      'Đây là danh sách TĨNH — không tốn quota, không mất thời gian.',
    schema: {},
    call: () => ({ method: 'GET', path: '/api/gateway/models' }),
  },
  {
    name: 'agyproxy_combos',
    title: 'Combo đã cấu hình',
    description: 'Các combo (chuỗi model dự phòng) và thứ tự ưu tiên trong từng combo.',
    schema: {},
    call: () => ({ method: 'GET', path: '/api/combos' }),
  },
  {
    name: 'agyproxy_usage',
    title: 'Lịch sử sử dụng',
    description: 'Request và token theo thời gian, tách theo model / account / API key.',
    schema: {
      range: z.enum(['1d', '7d', '30d']).default('7d'),
      groupBy: z.enum(['hour', 'day', 'week']).default('day'),
    },
    call: (a) => ({ method: 'GET', path: `/api/gateway/usage?range=${a.range ?? '7d'}&groupBy=${a.groupBy ?? 'day'}` }),
  },
  {
    name: 'agyproxy_config',
    title: 'Cấu hình gateway',
    description:
      'Chiến lược xoay account, cooldown, chính sách quota. API key trả về dạng CHE — ' +
      'MCP không bao giờ lộ key nguyên văn.',
    schema: {},
    call: () => ({ method: 'GET', path: '/api/gateway/config' }),
  },
  {
    name: 'agyproxy_runs',
    title: 'Lịch sử chạy flow',
    description: 'Các lần chạy login/warmup gần nhất và kết quả — dùng để chẩn đoán account hỏng.',
    schema: {},
    call: () => ({ method: 'GET', path: '/api/runs' }),
  },

  // ── Ghi an toàn: đảo ngược được, không phá dữ liệu ───────────────────────
  {
    name: 'agyproxy_wake',
    title: 'Gỡ cooldown account',
    description:
      'Gỡ trạng thái nghỉ cho account đang cooldown, để chúng nhận request trở lại. ' +
      'Dùng sau khi sự cố upstream đã hết. KHÔNG đụng tới bật/tắt hay sức khoẻ account. ' +
      'Bỏ trống `emails` là gỡ cho tất cả.',
    schema: {
      emails: z.array(z.string()).optional().describe('Bỏ trống = tất cả account đang cooldown'),
      provider: providerEnum.optional(),
    },
    write: true,
    call: (a) => ({
      method: 'POST',
      path: '/api/gateway/accounts/wake',
      body: { ...(a.emails?.length ? { emails: a.emails } : {}), ...(a.provider ? { provider: a.provider } : {}) },
    }),
  },
  {
    name: 'agyproxy_quota_refresh',
    title: 'Nạp lại hạn mức',
    description:
      'Gọi upstream lấy hạn mức mới nhất. Chạy nền, giãn nhịp để không cạnh tranh với ' +
      'request thật. Bỏ trống `emails` là nạp cho cả pool (mất vài phút với pool lớn).',
    schema: { emails: z.array(z.string()).optional() },
    write: true,
    call: (a) => ({
      method: 'POST',
      path: '/api/gateway/quota/refresh',
      body: a.emails?.length ? { emails: a.emails } : {},
    }),
  },
  {
    name: 'agyproxy_checklive',
    title: 'Kiểm tra MỘT account',
    description:
      'Gọi thử một account để biết còn sống / hết quota / đã chết. Chỉ một account mỗi lần — ' +
      'quét cả pool bị chặn có chủ đích vì mất hàng chục phút và có thể bị upstream chặn tốc độ.',
    schema: { email: z.string().describe('Email account cần kiểm tra') },
    write: true,
    call: (a) => ({ method: 'POST', path: `/api/gateway/accounts/${encodeURIComponent(a.email)}/checklive` }),
  },
  {
    name: 'agyproxy_set_rotation',
    title: 'Đổi chiến lược xoay account',
    description:
      'round-robin: lần lượt · full-first: dùng cạn account đầu · failover: chỉ chuyển khi lỗi · ' +
      'highest-first: ưu tiên account nhiều quota nhất · smart: cân theo quota và độ trễ.',
    schema: {
      rotation: z.enum(['round-robin', 'full-first', 'failover', 'highest-first', 'smart']),
    },
    write: true,
    call: (a) => ({ method: 'PATCH', path: '/api/gateway/config', body: { rotation: a.rotation } }),
  },
];

export const READ_ONLY = TOOLS.filter((t) => !t.write);
export const WRITE_TOOLS = TOOLS.filter((t) => t.write);
