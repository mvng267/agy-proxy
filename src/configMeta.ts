/**
 * Mô tả TỪNG khoá cấu hình: nhãn, giải thích, nhóm, ràng buộc.
 *
 * Vì sao cần: đo ngày 13/08/2026, chỉ **11/46** khoá chỉnh được từ dashboard. 35 khoá còn
 * lại muốn đổi thì phải SSH vào máy chủ ghi thẳng vào SQLite — kể cả `quotaIntervalMin`,
 * thứ vừa phải đổi để cứu vòng làm mới hạn mức đang tắc.
 *
 * Gốc rễ: `PATCH /api/gateway/config` dịch tay từng trường, nên thêm khoá mới là phải sửa
 * ba nơi (config.ts, admin.ts, Settings.tsx) và người ta chỉ sửa hai. Bảng này để trang
 * Settings TỰ SINH — thêm khoá vào `SETTERS` rồi mô tả ở đây là có UI ngay.
 *
 * Đây cũng là nguồn của `SPECS` (ràng buộc validate), nên nhãn và luật kiểm không thể
 * lệch nhau.
 */

export type FieldType = 'int' | 'bool' | 'string' | 'enum' | 'password' | 'model';

export interface ConfigField {
  label: string;
  /** Giải thích NGẮN. Dài quá thì không ai đọc; bỏ trống nếu nhãn đã đủ rõ. */
  desc?: string;
  group: string;
  type: FieldType;
  min?: number;
  max?: number;
  values?: readonly string[];
  /** Ẩn sau mục "Nâng cao" — thứ hiếm khi cần đụng. */
  advanced?: boolean;
}

export const NHOM = {
  server: 'Máy chủ',
  baoMat: 'Bảo mật',
  gateway: 'Gateway',
  hanMuc: 'Hạn mức',
  duLieu: 'Dữ liệu',
  claude: 'Claude Code',
  kiro: 'Kiro',
  trinhDuyet: 'Trình duyệt',
  thuThap: 'Thu thập account',
} as const;

export const CONFIG_FIELDS: Record<string, ConfigField> = {
  // ---- Máy chủ ----
  port: { label: 'Cổng', group: NHOM.server, type: 'int', min: 1, max: 65535 },
  host: {
    label: 'Địa chỉ lắng nghe',
    desc: '0.0.0.0 là mở ra mạng ngoài — chỉ dùng khi đã đặt mật khẩu mạnh',
    group: NHOM.server, type: 'string',
  },
  maxBodyMb: { label: 'Giới hạn body (MB)', group: NHOM.server, type: 'int', min: 1, max: 512 },
  logLevel: {
    label: 'Mức log',
    desc: 'debug in mọi thứ, error chỉ in lỗi',
    group: NHOM.server, type: 'enum', values: ['debug', 'info', 'warn', 'error'],
  },
  updateBranch: {
    label: 'Nhánh cập nhật',
    desc: 'production = chỉ bản đã phát hành · main = nhận bản mới nhất (máy test)',
    group: NHOM.server, type: 'string',
  },

  // ---- Bảo mật ----
  dashboardUser: { label: 'Tên đăng nhập', desc: 'Bỏ trống thì chỉ hỏi mật khẩu', group: NHOM.baoMat, type: 'string' },
  dashboardPassword: { label: 'Mật khẩu dashboard', group: NHOM.baoMat, type: 'password' },
  passcodeMode: { label: 'Dùng mã PIN thay mật khẩu', group: NHOM.baoMat, type: 'bool' },
  authDisabled: {
    label: 'Tắt xác thực',
    desc: 'MỞ TOÀN BỘ dashboard cho bất kỳ ai chạm được cổng. Chỉ dùng khi máy hoàn toàn riêng tư',
    group: NHOM.baoMat, type: 'bool',
  },
  loginMaxFail: { label: 'Số lần sai tối đa', group: NHOM.baoMat, type: 'int', min: 1, max: 100 },
  loginLockMin: { label: 'Khoá trong (phút)', group: NHOM.baoMat, type: 'int', min: 1, max: 1_440 },
  sessionSecret: { label: 'Khoá ký phiên', desc: 'Đổi là mọi phiên đăng nhập hiện tại bị đăng xuất', group: NHOM.baoMat, type: 'password', advanced: true },

  // ---- Gateway ----
  gatewayEnabled: { label: 'Bật gateway', group: NHOM.gateway, type: 'bool' },
  gatewayApiKey: { label: 'API key', desc: 'Client phải gửi key này. Để trống là ai cũng gọi được', group: NHOM.gateway, type: 'password' },
  gatewayRotation: {
    label: 'Chiến lược xoay account',
    desc: 'smart chấm điểm theo hạn mức + tỉ lệ lỗi + độ trễ',
    group: NHOM.gateway, type: 'enum',
    values: ['round-robin', 'full-first', 'failover', 'highest-first', 'smart'],
  },
  gatewayProxy: { label: 'Proxy đi ra', desc: 'Áp cho mọi lời gọi upstream', group: NHOM.gateway, type: 'string' },
  gatewayCooldownSec: { label: 'Nghỉ sau 429 (giây)', group: NHOM.gateway, type: 'int', min: 1, max: 86_400 },
  gatewayCooldown5xxSec: { label: 'Nghỉ sau 5xx (giây)', group: NHOM.gateway, type: 'int', min: 1, max: 3_600 },
  gatewayTimeoutSec: {
    label: 'Hết giờ chờ upstream (giây)',
    desc: 'Model sinh nhiều token cần nhiều thời gian — đặt thấp quá là cắt ngang câu trả lời',
    group: NHOM.gateway, type: 'int', min: 10, max: 900,
  },
  tokenRefreshAheadMin: { label: 'Làm mới token trước (phút)', group: NHOM.gateway, type: 'int', min: 1, max: 240, advanced: true },
  gatewayBareModels: { label: 'Tên model không kèm prefix', desc: 'Trả `claude-sonnet-4.5` thay vì `kr/claude-sonnet-4.5`', group: NHOM.gateway, type: 'bool', advanced: true },
  openaiStrictErrors: { label: 'Lỗi đúng chuẩn OpenAI', group: NHOM.gateway, type: 'bool', advanced: true },

  // ---- Hạn mức ----
  quotaAutoRefresh: { label: 'Tự đo hạn mức', group: NHOM.hanMuc, type: 'bool' },
  quotaIntervalMin: {
    label: 'Chu kỳ đo (phút)',
    desc: 'Đặt quá dài thì engine chọn account bằng số cũ — từng để 240 và quota cũ tới 28 giờ',
    group: NHOM.hanMuc, type: 'int', min: 1, max: 1_440,
  },
  quotaCacheTtlMin: { label: 'Cache hạn mức (phút)', group: NHOM.hanMuc, type: 'int', min: 1, max: 1_440 },
  quotaOnCall: { label: 'Đo kèm mỗi lời gọi', group: NHOM.hanMuc, type: 'bool', advanced: true },
  autoDisableEnabled: { label: 'Tự tắt account cạn hạn mức', group: NHOM.hanMuc, type: 'bool' },
  autoDisableHour: { label: 'Giờ quét hằng ngày', group: NHOM.hanMuc, type: 'int', min: 0, max: 23 },
  autoDisableOffPct: { label: 'Tắt khi còn dưới (%)', group: NHOM.hanMuc, type: 'int', min: 0, max: 100 },
  autoDisableOnPct: { label: 'Bật lại khi trên (%)', desc: 'Phải cao hơn ngưỡng tắt, nếu không account bật/tắt liên tục', group: NHOM.hanMuc, type: 'int', min: 0, max: 100 },

  // ---- Dữ liệu ----
  usageRetentionDays: { label: 'Giữ lịch sử dùng (ngày)', desc: '0 = giữ vĩnh viễn', group: NHOM.duLieu, type: 'int', min: 0, max: 3_650 },
  quotaHistoryDays: { label: 'Giữ lịch sử hạn mức (ngày)', group: NHOM.duLieu, type: 'int', min: 1, max: 3_650 },

  // ---- Claude Code ----
  anthropicBigModel: { label: 'Model lớn', desc: 'Model phục vụ Claude Code cho việc nặng', group: NHOM.claude, type: 'model' },
  anthropicSmallModel: { label: 'Model nhỏ', group: NHOM.claude, type: 'model' },

  // ---- Kiro ----
  kiroProbeEnabled: { label: 'Tự dò hạn mức Kiro', desc: 'Kiro không có API hạn mức nên phải gọi thử', group: NHOM.kiro, type: 'bool' },
  kiroProbeHours: { label: 'Chu kỳ dò (giờ)', group: NHOM.kiro, type: 'int', min: 1, max: 720 },
  kiroProbeBatch: { label: 'Số account mỗi lượt dò', desc: 'Mỗi lượt dò tốn hạn mức thật', group: NHOM.kiro, type: 'int', min: 1, max: 100 },
  kiroCreditLimit: { label: 'Hạn mức tháng (credit)', desc: 'Gói FREE là 50; nâng lên Pro thì đổi ở đây', group: NHOM.kiro, type: 'int', min: 1, max: 100_000 },
  kiroRedirectUri: { label: 'Redirect URI', group: NHOM.kiro, type: 'string', advanced: true },

  // ---- Trình duyệt ----
  headless: { label: 'Chạy ẩn', desc: 'Máy chủ không màn hình thì bắt buộc bật', group: NHOM.trinhDuyet, type: 'bool' },
  fingerprint: { label: 'Giả lập vân tay trình duyệt', group: NHOM.trinhDuyet, type: 'bool' },
  browserChannel: { label: 'Kênh trình duyệt', group: NHOM.trinhDuyet, type: 'enum', values: ['chrome', 'chromium', 'msedge'] },
  chromeMajor: { label: 'Phiên bản Chrome giả lập', group: NHOM.trinhDuyet, type: 'int', min: 80, max: 200, advanced: true },
  chromeNoSandbox: { label: 'Tắt sandbox', desc: 'Cần khi chạy trong container', group: NHOM.trinhDuyet, type: 'bool', advanced: true },

  // ---- Thu thập account ----
  pacingMinSec: { label: 'Giãn nhịp tối thiểu (giây)', desc: 'Đăng nhập dồn dập dễ kéo checkpoint hàng loạt', group: NHOM.thuThap, type: 'int', min: 0, max: 86_400 },
  pacingMaxSec: { label: 'Giãn nhịp tối đa (giây)', group: NHOM.thuThap, type: 'int', min: 0, max: 86_400 },
  dailyLoginCap: { label: 'Trần đăng nhập/ngày', group: NHOM.thuThap, type: 'int', min: 0, max: 10_000 },
  humanTimeoutSec: { label: 'Chờ người xử lý (giây)', desc: 'Thời gian đợi khi gặp captcha', group: NHOM.thuThap, type: 'int', min: 0, max: 86_400 },
  tokenHealthHours: { label: 'Chu kỳ kiểm token (giờ)', group: NHOM.thuThap, type: 'int', min: 0, max: 720 },
};
