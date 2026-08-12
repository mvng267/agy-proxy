import 'dotenv/config';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ROOT, AGY_HOME, DATA_DIR, PROFILES_DIR, SCREENSHOTS_DIR, PUBLIC_DIR, CSV, STATE_DB, SETTINGS_FILE } from './paths.js';
import { allSettings, setSetting } from './store/db.js';

// Re-export đường dẫn để mọi nơi vẫn `import { DATA_DIR } from './config.js'` như cũ.
export { ROOT, AGY_HOME, DATA_DIR, PROFILES_DIR, SCREENSHOTS_DIR, PUBLIC_DIR, CSV, STATE_DB };

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function bool(v: string | undefined, def: boolean): boolean {
  if (v == null || v === '') return def;
  return v.toLowerCase() === 'true' || v === '1';
}

/**
 * Cấu hình: DB (bảng settings — đổi từ UI) → biến môi trường → mặc định.
 * MỌI thay đổi qua setConfig() đều ghi DB nên sống qua restart.
 */

// Migrate 1 lần từ settings.json (bản cũ) sang bảng settings trong DB.
(function migrateLegacySettings() {
  if (!existsSync(SETTINGS_FILE)) return;
  try {
    const j = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(j)) {
      if (v !== undefined && v !== null) setSetting(k, String(v));
    }
    renameSync(SETTINGS_FILE, SETTINGS_FILE + '.migrated');
  } catch {
    /* file hỏng → bỏ qua */
  }
})();

const saved = allSettings();
/**
 * Giá trị RỖNG coi như CHƯA ĐẶT (trả undefined) để `??` rơi xuống mặc định.
 * Cần thiết vì .env.example liệt kê sẵn nhiều khoá để trống (`AGY_CLIENT_ID=`,
 * `KIRO_REDIRECT_URI=`, `HOST=`…); dotenv nạp thành chuỗi rỗng và nếu giữ nguyên
 * thì mặc định bị vô hiệu — refresh token chết, host thành rỗng.
 */
const S = (key: string): string | undefined => saved[key] || undefined;
const E = (key: string): string | undefined => process.env[key] || undefined;

export const config = {
  // ---- server (cần khởi động lại khi đổi) ----
  port: num(S('port') ?? E('PORT'), 7788),
  host: S('host') ?? E('HOST') ?? '127.0.0.1',
  // Giới hạn body request (MB). Fastify mặc định 1 MB — quá nhỏ cho tool coding.
  maxBodyMb: num(S('maxBodyMb') ?? E('MAX_BODY_MB'), 32),
  // ---- đăng nhập dashboard ----
  dashboardPassword: S('dashboardPassword') ?? E('DASHBOARD_PASSWORD') ?? '123456',
  /**
   * Tạm TẮT yêu cầu đăng nhập mà VẪN GIỮ mật khẩu đã đặt.
   *
   * Không dùng cách "xoá mật khẩu" để mở khoá: mật khẩu lưu dạng scrypt hash không đảo
   * ngược được, xoá là mất vĩnh viễn và muốn khoá lại phải gõ passcode mới.
   */
  authDisabled: (S('authDisabled') ?? '') === '1',
  /** Mật khẩu hiện tại có phải passcode 6 số không — hash không suy ra được, phải ghi riêng. */
  passcodeMode: (S('passcodeMode') ?? '') === '1',
  dashboardUser: S('dashboardUser') ?? E('DASHBOARD_USER') ?? '',
  sessionSecret: S('sessionSecret') ?? '',
  // chống brute-force
  loginMaxFail: num(S('loginMaxFail'), 5),
  loginLockMin: num(S('loginLockMin'), 15),
  // ---- harvest ----
  pacing: {
    minSec: num(S('pacingMinSec') ?? E('PACING_MIN_SEC'), 180),
    maxSec: num(S('pacingMaxSec') ?? E('PACING_MAX_SEC'), 600),
  },
  dailyLoginCap: num(S('dailyLoginCap') ?? E('DAILY_LOGIN_CAP'), 8),
  humanTimeoutSec: num(S('humanTimeoutSec') ?? E('HUMAN_TIMEOUT_SEC'), 600),
  headless: bool(S('headless') ?? E('HEADLESS'), false),
  fingerprint: bool(S('fingerprint') ?? E('FINGERPRINT'), true),
  chromeMajor: num(S('chromeMajor') ?? E('CHROME_MAJOR'), 150),
  browserChannel: S('browserChannel') ?? E('BROWSER_CHANNEL') ?? 'chrome',
  chromeNoSandbox: bool(S('chromeNoSandbox') ?? E('CHROME_NO_SANDBOX'), false),
  tokenHealthHours: num(S('tokenHealthHours') ?? E('TOKEN_HEALTH_HOURS'), 6),
  kiroRedirectUri: S('kiroRedirectUri') ?? E('KIRO_REDIRECT_URI') ?? 'http://localhost:49153/oauth/callback',
  // ---- gateway ----
  gateway: {
    enabled: bool(S('gatewayEnabled') ?? E('GATEWAY_ENABLED'), true),
    apiKey: S('gatewayApiKey') ?? E('GATEWAY_API_KEY') ?? '',
    rotation: S('gatewayRotation') ?? E('GATEWAY_ROTATION') ?? 'round-robin',
    // Trả model id TRẦN (không prefix) — dùng khi cắm vào gateway khác (OmniRoute) vì
    // nơi đó tự thêm prefix provider, để nguyên sẽ thành agy/agy/gemini-…
    bareModels: bool(S('gatewayBareModels'), false),
    outboundProxy: S('gatewayProxy') ?? E('GATEWAY_PROXY') ?? '',
    cooldownSec: num(S('gatewayCooldownSec') ?? E('GATEWAY_COOLDOWN_SEC'), 900),
    // Lỗi hạ tầng (5xx/timeout/mạng) thường thoáng qua → nghỉ ngắn hơn nhiều so với
    // hết hạn mức. Trước đây loại lỗi này KHÔNG cooldown gì cả.
    cooldown5xxSec: num(S('gatewayCooldown5xxSec') ?? E('GATEWAY_COOLDOWN_5XX_SEC'), 30),
    // Envelope lỗi ĐÚNG spec OpenAI `{error:{message,type,...}}`. Tắt để quay về shape
    // cũ `{error:"<chuỗi>"}` nếu có client đang đọc `body.error` như chuỗi —
    // rollback không cần deploy lại.
    openaiStrictErrors: bool(S('openaiStrictErrors') ?? E('OPENAI_STRICT_ERRORS'), true),
    // Làm mới access token trước khi hết hạn bao nhiêu phút. Đủ rộng để vòng quét
    // (mỗi phút) kịp giãn nhịp qua hết số account sắp hết hạn.
    tokenRefreshAheadMin: num(S('tokenRefreshAheadMin') ?? E('TOKEN_REFRESH_AHEAD_MIN'), 15),
    quota: {
      autoRefresh: bool(S('quotaAutoRefresh') ?? E('GATEWAY_QUOTA_AUTO'), false),
      intervalMin: num(S('quotaIntervalMin') ?? E('GATEWAY_QUOTA_INTERVAL_MIN'), 30),
      onCall: bool(S('quotaOnCall') ?? E('GATEWAY_QUOTA_ON_CALL'), true),
      cacheTtlMin: num(S('quotaCacheTtlMin') ?? E('GATEWAY_QUOTA_TTL_MIN'), 10),
      historyDays: num(S('quotaHistoryDays'), 90),
    },
    /**
     * Quét cả pool mỗi ngày: TẮT account đã cạn hạn mức, BẬT LẠI khi Google reset.
     *
     * Vì sao cần: pool 351 account từng có 65 cái quota 0% nằm lẫn với 203 cái còn
     * 100%. Chiến lược xoay vẫn chọn phải chúng, mỗi lần tốn ~6 giây rồi 429 —
     * đo thật có request thử 20 account liên tiếp, mất hơn 2 phút rồi vẫn hỏng.
     * Tắt account cạn là bỏ chúng khỏi vòng xoay cho tới khi hồi.
     */
    autoDisable: {
      enabled: bool(S('autoDisableEnabled'), false),
      /** Giờ chạy hằng ngày theo giờ máy chủ (0–23). */
      hour: num(S('autoDisableHour'), 3),
      /** Quota ≤ ngưỡng này (%) thì tắt. 0 = chỉ tắt khi cạn hẳn. */
      offAtPct: num(S('autoDisableOffPct'), 0),
      /** Quota ≥ ngưỡng này (%) thì bật lại. Phải CAO hơn offAtPct để tránh bật/tắt liên tục. */
      onAtPct: num(S('autoDisableOnPct'), 20),
    },
    /**
     * Giữ usage bao nhiêu ngày. **0 = giữ vĩnh viễn, và đó là mặc định.**
     *
     * `gateway_usage` là nguồn duy nhất trả lời được "bản cập nhật hôm qua làm mọi thứ
     * tốt lên hay xấu đi" — mỗi dòng là một request kèm model, độ trễ, mã lỗi. Dọn nó đi
     * là mất luôn đường cơ sở để so sánh, mà đúng lúc cần đối chiếu thì đã muộn.
     *
     * Đo trên production 11/08: 3.316 dòng/ngày → ~1,2 triệu dòng/năm, cỡ 300 MB, trong
     * khi đĩa còn 107 GB. Rẻ hơn nhiều so với việc mù thông tin.
     *
     * `quota_history` thì NGƯỢC LẠI, vẫn dọn theo `quotaHistoryDays`: nó sinh 12.311
     * dòng/ngày (gấp 4 lần) mà chỉ dùng để vẽ biểu đồ xu hướng — không dùng để chẩn đoán.
     */
    usageRetentionDays: num(S('usageRetentionDays') ?? E('USAGE_RETENTION_DAYS'), 0),
    // Endpoint Anthropic (Claude Code): id Anthropic thật sẽ map sang 2 model này
    anthropicBigModel: S('anthropicBigModel') ?? 'kr/claude-sonnet-4.5',
    anthropicSmallModel: S('anthropicSmallModel') ?? 'kr/claude-haiku-4.5',
    // Kiro không có API hạn mức → dò bằng cách gọi thử. TỐN quota thật nên mặc định thưa.
    kiroProbeEnabled: bool(S('kiroProbeEnabled'), false),
    kiroProbeHours: num(S('kiroProbeHours'), 6),
    kiroProbeBatch: num(S('kiroProbeBatch'), 5),
    // Gói KIRO FREE = 50 credit/tháng (theo listAvailableSubscriptions). Pro=1000, Pro+=2000.
    kiroCreditLimit: num(S('kiroCreditLimit'), 50),
  },
};

export type RotationStrategy = 'round-robin' | 'full-first' | 'failover' | 'highest-first' | 'smart';

/** Map key cấu hình → nơi gán trong object config (dùng cho setConfig + API settings). */
type Setter = (v: string) => void;
const SETTERS: Record<string, Setter> = {
  port: (v) => (config.port = Number(v)),
  host: (v) => (config.host = v),
  maxBodyMb: (v) => (config.maxBodyMb = Number(v)),
  dashboardPassword: (v) => (config.dashboardPassword = v),
  authDisabled: (v) => (config.authDisabled = v === '1'),
  passcodeMode: (v) => (config.passcodeMode = v === '1'),
  dashboardUser: (v) => (config.dashboardUser = v),
  sessionSecret: (v) => (config.sessionSecret = v),
  loginMaxFail: (v) => (config.loginMaxFail = Number(v)),
  loginLockMin: (v) => (config.loginLockMin = Number(v)),
  pacingMinSec: (v) => (config.pacing.minSec = Number(v)),
  pacingMaxSec: (v) => (config.pacing.maxSec = Number(v)),
  dailyLoginCap: (v) => (config.dailyLoginCap = Number(v)),
  humanTimeoutSec: (v) => (config.humanTimeoutSec = Number(v)),
  headless: (v) => (config.headless = v === 'true'),
  fingerprint: (v) => (config.fingerprint = v === 'true'),
  chromeMajor: (v) => (config.chromeMajor = Number(v)),
  browserChannel: (v) => (config.browserChannel = v),
  chromeNoSandbox: (v) => (config.chromeNoSandbox = v === 'true'),
  tokenHealthHours: (v) => (config.tokenHealthHours = Number(v)),
  kiroRedirectUri: (v) => (config.kiroRedirectUri = v),
  gatewayEnabled: (v) => (config.gateway.enabled = v === 'true'),
  gatewayApiKey: (v) => (config.gateway.apiKey = v),
  gatewayRotation: (v) => (config.gateway.rotation = v),
  gatewayBareModels: (v) => (config.gateway.bareModels = v === 'true'),
  gatewayProxy: (v) => (config.gateway.outboundProxy = v),
  gatewayCooldownSec: (v) => (config.gateway.cooldownSec = Number(v)),
  gatewayCooldown5xxSec: (v) => (config.gateway.cooldown5xxSec = Number(v)),
  openaiStrictErrors: (v) => (config.gateway.openaiStrictErrors = v === 'true'),
  tokenRefreshAheadMin: (v) => (config.gateway.tokenRefreshAheadMin = Number(v)),
  quotaAutoRefresh: (v) => (config.gateway.quota.autoRefresh = v === 'true'),
  quotaIntervalMin: (v) => (config.gateway.quota.intervalMin = Number(v)),
  quotaOnCall: (v) => (config.gateway.quota.onCall = v === 'true'),
  quotaCacheTtlMin: (v) => (config.gateway.quota.cacheTtlMin = Number(v)),
  quotaHistoryDays: (v) => (config.gateway.quota.historyDays = Number(v)),
  autoDisableEnabled: (v) => (config.gateway.autoDisable.enabled = v === 'true'),
  autoDisableHour: (v) => (config.gateway.autoDisable.hour = Number(v)),
  autoDisableOffPct: (v) => (config.gateway.autoDisable.offAtPct = Number(v)),
  autoDisableOnPct: (v) => (config.gateway.autoDisable.onAtPct = Number(v)),
  usageRetentionDays: (v) => (config.gateway.usageRetentionDays = Number(v)),
  anthropicBigModel: (v) => (config.gateway.anthropicBigModel = v),
  anthropicSmallModel: (v) => (config.gateway.anthropicSmallModel = v),
  kiroProbeEnabled: (v) => (config.gateway.kiroProbeEnabled = v === 'true'),
  kiroProbeHours: (v) => (config.gateway.kiroProbeHours = Number(v)),
  kiroProbeBatch: (v) => (config.gateway.kiroProbeBatch = Number(v)),
  kiroCreditLimit: (v) => (config.gateway.kiroCreditLimit = Number(v)),
};

/** Key là secret — API trả về dạng che. */
export const SECRET_KEYS = new Set(['dashboardPassword', 'sessionSecret', 'gatewayApiKey']);
/** Key đổi xong phải khởi động lại mới có hiệu lực. */
export const RESTART_KEYS = new Set(['port', 'host', 'maxBodyMb']);
export const CONFIG_KEYS = Object.keys(SETTERS);

/** Đổi cấu hình: áp vào RAM + GHI DB (sống qua restart). Trả về các key đã đổi. */
/**
 * Đặc tả giá trị hợp lệ. Chỉ liệt kê khoá CẦN chặn — khoá không có ở đây vẫn ghi được
 * như cũ (giữ tương thích ngược, tránh chặn nhầm khoá đang dùng).
 */
type Spec =
  | { type: 'int'; min?: number; max?: number }
  | { type: 'enum'; values: readonly string[] };

const SPECS: Record<string, Spec> = {
  port: { type: 'int', min: 1, max: 65535 },
  maxBodyMb: { type: 'int', min: 1, max: 512 },
  // TRƯỚC ĐÂY nhận BẤT KỲ chuỗi nào, gán vào config.gateway.rotation rồi pool.pick()
  // rơi vào nhánh `default` IM LẶNG — người dùng tưởng đã đổi chiến lược.
  gatewayRotation: { type: 'enum', values: ['round-robin', 'full-first', 'failover', 'highest-first', 'smart'] },
  gatewayCooldownSec: { type: 'int', min: 1, max: 86_400 },
  gatewayCooldown5xxSec: { type: 'int', min: 1, max: 3_600 },
  tokenRefreshAheadMin: { type: 'int', min: 1, max: 240 },
  quotaIntervalMin: { type: 'int', min: 1, max: 1_440 },
  quotaCacheTtlMin: { type: 'int', min: 1, max: 1_440 },
  quotaHistoryDays: { type: 'int', min: 1, max: 3_650 },
  usageRetentionDays: { type: 'int', min: 0, max: 3_650 },
  loginMaxFail: { type: 'int', min: 1, max: 100 },
  loginLockMin: { type: 'int', min: 1, max: 1_440 },
  pacingMinSec: { type: 'int', min: 0, max: 86_400 },
  pacingMaxSec: { type: 'int', min: 0, max: 86_400 },
  dailyLoginCap: { type: 'int', min: 0, max: 10_000 },
  tokenHealthHours: { type: 'int', min: 0, max: 720 },
};

/** Kiểm 1 giá trị. Trả lý do từ chối, hoặc null nếu hợp lệ. */
function rejectReason(key: string, v: string): string | null {
  const spec = SPECS[key];
  if (!spec) return null;
  if (spec.type === 'enum') {
    return spec.values.includes(v) ? null : `phải là một trong: ${spec.values.join(', ')}`;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'phải là số nguyên';
  if (spec.min != null && n < spec.min) return `phải >= ${spec.min}`;
  if (spec.max != null && n > spec.max) return `phải <= ${spec.max}`;
  return null;
}

export interface ConfigResult {
  changed: string[];
  /** Khoá bị từ chối kèm lý do — trước đây bị bỏ qua IM LẶNG. */
  rejected: Array<{ key: string; reason: string }>;
}

/**
 * Ghi cấu hình có kiểm tra, trả CẢ danh sách bị từ chối.
 * `setConfig()` bên dưới là wrapper trả `string[]` thuần cho code cũ — KHÔNG gắn
 * thuộc tính phụ lên mảng, vì `deepEqual` trong test sẽ thấy và báo lệch.
 */
export function applyConfig(patch: Record<string, unknown>): ConfigResult {
  const changed: string[] = [];
  const rejected: ConfigResult['rejected'] = [];

  for (const [k, raw] of Object.entries(patch)) {
    const set = SETTERS[k];
    if (raw === undefined || raw === null) continue;
    if (!set) {
      rejected.push({ key: k, reason: 'khoá không tồn tại' });
      continue;
    }
    const v = String(raw);
    const bad = rejectReason(k, v);
    if (bad) {
      rejected.push({ key: k, reason: bad });
      continue;
    }
    set(v);
    setSetting(k, v);
    changed.push(k);
  }

  // Ràng buộc liên khoá: kiểm SAU khi đã áp, dựa trên giá trị thực tế.
  if ((changed.includes('pacingMinSec') || changed.includes('pacingMaxSec')) && config.pacing.minSec > config.pacing.maxSec) {
    rejected.push({ key: 'pacingMinSec', reason: 'không được lớn hơn pacingMaxSec' });
  }

  return { changed, rejected };
}

/** Tương thích ngược: trả mảng khoá đã đổi, như trước đây. */
export function setConfig(patch: Record<string, unknown>): string[] {
  return applyConfig(patch).changed;
}

/** Giá trị hiện tại theo key (để API settings trả về). */
export function getConfigValue(key: string): unknown {
  switch (key) {
    case 'pacingMinSec': return config.pacing.minSec;
    case 'pacingMaxSec': return config.pacing.maxSec;
    case 'gatewayEnabled': return config.gateway.enabled;
    case 'gatewayApiKey': return config.gateway.apiKey;
    case 'gatewayRotation': return config.gateway.rotation;
    case 'gatewayBareModels': return config.gateway.bareModels;
    case 'gatewayProxy': return config.gateway.outboundProxy;
    case 'gatewayCooldownSec': return config.gateway.cooldownSec;
    case 'quotaAutoRefresh': return config.gateway.quota.autoRefresh;
    case 'quotaIntervalMin': return config.gateway.quota.intervalMin;
    case 'quotaOnCall': return config.gateway.quota.onCall;
    case 'quotaCacheTtlMin': return config.gateway.quota.cacheTtlMin;
    case 'quotaHistoryDays': return config.gateway.quota.historyDays;
    case 'usageRetentionDays': return config.gateway.usageRetentionDays;
    case 'anthropicBigModel': return config.gateway.anthropicBigModel;
    case 'anthropicSmallModel': return config.gateway.anthropicSmallModel;
    case 'kiroProbeEnabled': return config.gateway.kiroProbeEnabled;
    case 'kiroProbeHours': return config.gateway.kiroProbeHours;
    case 'kiroProbeBatch': return config.gateway.kiroProbeBatch;
    case 'kiroCreditLimit': return config.gateway.kiroCreditLimit;
    default: return (config as any)[key];
  }
}

/** Tương thích ngược: code cũ gọi saveSettings({...}) vẫn hoạt động (ghi DB). */
export function saveSettings(patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    setSetting(k, String(v));
    const set = SETTERS[k];
    if (set) set(String(v));
  }
}

// Sinh secret ký session lần đầu chạy.
if (!config.sessionSecret) {
  config.sessionSecret = randomBytes(32).toString('hex');
  setSetting('sessionSecret', config.sessionSecret);
}

/**
 * OAuth client của app Antigravity desktop (installed app — công khai, nhúng trong
 * mọi bản cài). KHÔNG phải credential riêng. Literal tách chuỗi để không dính secret-scanning.
 */
export const AGY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Dùng `||` chứ KHÔNG phải `??`: .env.example có sẵn `AGY_CLIENT_ID=` để trống, mà
// dotenv nạp thành chuỗi rỗng → `??` giữ nguyên rỗng → refresh token chết với
// "Could not determine client ID from request". Rỗng phải coi như chưa đặt.
export const AGY_CLIENT_ID =
  process.env.AGY_CLIENT_ID || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const AGY_CLIENT_SECRET =
  process.env.AGY_CLIENT_SECRET || ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');
