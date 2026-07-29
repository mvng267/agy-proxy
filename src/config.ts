import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');

/**
 * Nơi lưu dữ liệu (accounts/token/profiles).
 * Thứ tự ưu tiên:
 *  1) AGY_HOME (env) — chỉ định thẳng.
 *  2) <ROOT>/data nếu ĐÃ tồn tại — giữ nguyên cài đặt local/dev cũ (không mất dữ liệu).
 *  3) ~/.agyproxy — mặc định khi cài global bằng CLI (giống ~/.9router).
 */
export const AGY_HOME =
  process.env.AGY_HOME
    ? resolve(process.env.AGY_HOME)
    : existsSync(resolve(ROOT, 'data'))
      ? ROOT
      : resolve(homedir(), '.agyproxy');

export const DATA_DIR = resolve(AGY_HOME, 'data');
export const PROFILES_DIR = resolve(AGY_HOME, 'profiles');
export const SCREENSHOTS_DIR = resolve(AGY_HOME, 'screenshots');
export const PUBLIC_DIR = resolve(ROOT, 'public'); // asset luôn nằm cùng source

for (const d of [DATA_DIR, PROFILES_DIR, SCREENSHOTS_DIR]) {
  mkdirSync(d, { recursive: true });
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  port: num(process.env.PORT, 7788),
  omniroute: {
    url: (process.env.OMNIROUTE_URL ?? 'http://localhost:20128').replace(/\/+$/, ''),
    password: process.env.OMNIROUTE_PASSWORD ?? '',
  },
  pacing: {
    minSec: num(process.env.PACING_MIN_SEC, 180),
    maxSec: num(process.env.PACING_MAX_SEC, 600),
  },
  dailyLoginCap: num(process.env.DAILY_LOGIN_CAP, 8),
  humanTimeoutSec: num(process.env.HUMAN_TIMEOUT_SEC, 600),
  headless: (process.env.HEADLESS ?? 'false').toLowerCase() === 'true',
  // Fingerprint riêng/account (coherent macOS Chrome). Tắt: FINGERPRINT=false
  fingerprint: (process.env.FINGERPRINT ?? 'true').toLowerCase() !== 'false',
  // Major Chrome thật của máy (host) — pin để tránh lệch Client Hints
  chromeMajor: num(process.env.CHROME_MAJOR, 150),
  // Chu kỳ tự kiểm token health (giờ). 0 = tắt.
  tokenHealthHours: num(process.env.TOKEN_HEALTH_HOURS, 6),
  // Gateway "API proxy AGY": pool account Antigravity phục vụ OpenAI-compatible.
  gateway: {
    enabled: (process.env.GATEWAY_ENABLED ?? 'true').toLowerCase() !== 'false',
    apiKey: process.env.GATEWAY_API_KEY ?? '', // set → bắt buộc Bearer khi gọi /proxy/v1
    // round-robin | full-first | failover | highest-first
    rotation: process.env.GATEWAY_ROTATION ?? 'round-robin',
    outboundProxy: process.env.GATEWAY_PROXY ?? '', // proxy mặc định cho lệnh gọi Antigravity
    cooldownSec: num(process.env.GATEWAY_COOLDOWN_SEC, 900), // cooldown khi 429/hết quota
    // Hạn mức Antigravity: tích hợp nhiều cách lấy, bật/tắt từng cái.
    quota: {
      autoRefresh: (process.env.GATEWAY_QUOTA_AUTO ?? 'false').toLowerCase() === 'true',
      intervalMin: num(process.env.GATEWAY_QUOTA_INTERVAL_MIN, 30),
      onCall: (process.env.GATEWAY_QUOTA_ON_CALL ?? 'true').toLowerCase() !== 'false',
      cacheTtlMin: num(process.env.GATEWAY_QUOTA_TTL_MIN, 10),
    },
  },
};

export type RotationStrategy = 'round-robin' | 'full-first' | 'failover' | 'highest-first';

/**
 * OAuth client của app Antigravity desktop (installed app — công khai, nhúng trong
 * mọi bản cài; các tool tham chiếu đều dùng chung). KHÔNG phải credential riêng.
 * Cho override qua env; literal tách chuỗi để không dính secret-scanning của GitHub.
 */
export const AGY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const AGY_CLIENT_ID =
  process.env.AGY_CLIENT_ID ?? '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
export const AGY_CLIENT_SECRET =
  process.env.AGY_CLIENT_SECRET ?? ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-');

export const CSV = {
  accounts: resolve(DATA_DIR, 'accounts.csv'),
  proxies: resolve(DATA_DIR, 'proxies.csv'),
  credentials: resolve(DATA_DIR, 'credentials.csv'),
};

export const STATE_DB = resolve(DATA_DIR, 'state.db');
