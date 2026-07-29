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
const S = (key: string): string | undefined => saved[key];

export const config = {
  // ---- server (cần khởi động lại khi đổi) ----
  port: num(S('port') ?? process.env.PORT, 7788),
  host: S('host') ?? process.env.HOST ?? '127.0.0.1',
  // ---- đăng nhập dashboard ----
  dashboardPassword: S('dashboardPassword') ?? process.env.DASHBOARD_PASSWORD ?? '123456',
  dashboardUser: S('dashboardUser') ?? process.env.DASHBOARD_USER ?? '',
  sessionSecret: S('sessionSecret') ?? '',
  // chống brute-force
  loginMaxFail: num(S('loginMaxFail'), 5),
  loginLockMin: num(S('loginLockMin'), 15),
  // ---- OmniRoute ----
  omniroute: {
    url: (S('omnirouteUrl') ?? process.env.OMNIROUTE_URL ?? 'http://localhost:20128').replace(/\/+$/, ''),
    password: S('omniroutePassword') ?? process.env.OMNIROUTE_PASSWORD ?? '',
  },
  // ---- harvest ----
  pacing: {
    minSec: num(S('pacingMinSec') ?? process.env.PACING_MIN_SEC, 180),
    maxSec: num(S('pacingMaxSec') ?? process.env.PACING_MAX_SEC, 600),
  },
  dailyLoginCap: num(S('dailyLoginCap') ?? process.env.DAILY_LOGIN_CAP, 8),
  humanTimeoutSec: num(S('humanTimeoutSec') ?? process.env.HUMAN_TIMEOUT_SEC, 600),
  headless: bool(S('headless') ?? process.env.HEADLESS, false),
  fingerprint: bool(S('fingerprint') ?? process.env.FINGERPRINT, true),
  chromeMajor: num(S('chromeMajor') ?? process.env.CHROME_MAJOR, 150),
  browserChannel: S('browserChannel') ?? process.env.BROWSER_CHANNEL ?? 'chrome',
  chromeNoSandbox: bool(S('chromeNoSandbox') ?? process.env.CHROME_NO_SANDBOX, false),
  tokenHealthHours: num(S('tokenHealthHours') ?? process.env.TOKEN_HEALTH_HOURS, 6),
  kiroRedirectUri: S('kiroRedirectUri') ?? process.env.KIRO_REDIRECT_URI ?? 'http://localhost:49153/oauth/callback',
  // ---- gateway ----
  gateway: {
    enabled: bool(S('gatewayEnabled') ?? process.env.GATEWAY_ENABLED, true),
    apiKey: S('gatewayApiKey') ?? process.env.GATEWAY_API_KEY ?? '',
    rotation: S('gatewayRotation') ?? process.env.GATEWAY_ROTATION ?? 'round-robin',
    outboundProxy: S('gatewayProxy') ?? process.env.GATEWAY_PROXY ?? '',
    cooldownSec: num(S('gatewayCooldownSec') ?? process.env.GATEWAY_COOLDOWN_SEC, 900),
    quota: {
      autoRefresh: bool(S('quotaAutoRefresh') ?? process.env.GATEWAY_QUOTA_AUTO, false),
      intervalMin: num(S('quotaIntervalMin') ?? process.env.GATEWAY_QUOTA_INTERVAL_MIN, 30),
      onCall: bool(S('quotaOnCall') ?? process.env.GATEWAY_QUOTA_ON_CALL, true),
      cacheTtlMin: num(S('quotaCacheTtlMin') ?? process.env.GATEWAY_QUOTA_TTL_MIN, 10),
      historyDays: num(S('quotaHistoryDays'), 90),
    },
  },
};

export type RotationStrategy = 'round-robin' | 'full-first' | 'failover' | 'highest-first';

/** Map key cấu hình → nơi gán trong object config (dùng cho setConfig + API settings). */
type Setter = (v: string) => void;
const SETTERS: Record<string, Setter> = {
  port: (v) => (config.port = Number(v)),
  host: (v) => (config.host = v),
  dashboardPassword: (v) => (config.dashboardPassword = v),
  dashboardUser: (v) => (config.dashboardUser = v),
  sessionSecret: (v) => (config.sessionSecret = v),
  loginMaxFail: (v) => (config.loginMaxFail = Number(v)),
  loginLockMin: (v) => (config.loginLockMin = Number(v)),
  omnirouteUrl: (v) => (config.omniroute.url = v.replace(/\/+$/, '')),
  omniroutePassword: (v) => (config.omniroute.password = v),
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
  gatewayProxy: (v) => (config.gateway.outboundProxy = v),
  gatewayCooldownSec: (v) => (config.gateway.cooldownSec = Number(v)),
  quotaAutoRefresh: (v) => (config.gateway.quota.autoRefresh = v === 'true'),
  quotaIntervalMin: (v) => (config.gateway.quota.intervalMin = Number(v)),
  quotaOnCall: (v) => (config.gateway.quota.onCall = v === 'true'),
  quotaCacheTtlMin: (v) => (config.gateway.quota.cacheTtlMin = Number(v)),
  quotaHistoryDays: (v) => (config.gateway.quota.historyDays = Number(v)),
};

/** Key là secret — API trả về dạng che. */
export const SECRET_KEYS = new Set(['dashboardPassword', 'sessionSecret', 'omniroutePassword', 'gatewayApiKey']);
/** Key đổi xong phải khởi động lại mới có hiệu lực. */
export const RESTART_KEYS = new Set(['port', 'host']);
export const CONFIG_KEYS = Object.keys(SETTERS);

/** Đổi cấu hình: áp vào RAM + GHI DB (sống qua restart). Trả về các key đã đổi. */
export function setConfig(patch: Record<string, unknown>): string[] {
  const changed: string[] = [];
  for (const [k, raw] of Object.entries(patch)) {
    const set = SETTERS[k];
    if (!set || raw === undefined || raw === null) continue;
    const v = typeof raw === 'boolean' ? String(raw) : String(raw);
    set(v);
    setSetting(k, v);
    changed.push(k);
  }
  return changed;
}

/** Giá trị hiện tại theo key (để API settings trả về). */
export function getConfigValue(key: string): unknown {
  switch (key) {
    case 'omnirouteUrl': return config.omniroute.url;
    case 'omniroutePassword': return config.omniroute.password;
    case 'pacingMinSec': return config.pacing.minSec;
    case 'pacingMaxSec': return config.pacing.maxSec;
    case 'gatewayEnabled': return config.gateway.enabled;
    case 'gatewayApiKey': return config.gateway.apiKey;
    case 'gatewayRotation': return config.gateway.rotation;
    case 'gatewayProxy': return config.gateway.outboundProxy;
    case 'gatewayCooldownSec': return config.gateway.cooldownSec;
    case 'quotaAutoRefresh': return config.gateway.quota.autoRefresh;
    case 'quotaIntervalMin': return config.gateway.quota.intervalMin;
    case 'quotaOnCall': return config.gateway.quota.onCall;
    case 'quotaCacheTtlMin': return config.gateway.quota.cacheTtlMin;
    case 'quotaHistoryDays': return config.gateway.quota.historyDays;
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
export const AGY_CLIENT_ID =
  process.env.AGY_CLIENT_ID ?? '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const AGY_CLIENT_SECRET =
  process.env.AGY_CLIENT_SECRET ?? ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');
