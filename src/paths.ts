import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Đường dẫn dữ liệu — tách riêng để store/db.ts và config.ts cùng dùng
 * mà không tạo vòng lặp import (config cần DB để lưu settings).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');

/**
 * Nơi lưu dữ liệu:
 *  1) AGY_HOME (env) — chỉ định thẳng.
 *  2) <ROOT>/data nếu ĐÃ tồn tại — giữ cài đặt local/dev cũ (không mất dữ liệu).
 *  3) ~/.agyproxy — mặc định khi cài global bằng CLI.
 */
export const AGY_HOME = process.env.AGY_HOME
  ? resolve(process.env.AGY_HOME)
  : existsSync(resolve(ROOT, 'data'))
    ? ROOT
    : resolve(homedir(), '.agyproxy');

export const DATA_DIR = resolve(AGY_HOME, 'data');
export const PROFILES_DIR = resolve(AGY_HOME, 'profiles');
export const SCREENSHOTS_DIR = resolve(AGY_HOME, 'screenshots');
export const PUBLIC_DIR = resolve(ROOT, 'web/dist'); // React dashboard (build từ web/)

for (const d of [DATA_DIR, PROFILES_DIR, SCREENSHOTS_DIR]) {
  mkdirSync(d, { recursive: true });
}

export const CSV = {
  accounts: resolve(DATA_DIR, 'accounts.csv'),
  proxies: resolve(DATA_DIR, 'proxies.csv'),
  credentials: resolve(DATA_DIR, 'credentials.csv'),
};

export const STATE_DB = resolve(DATA_DIR, 'state.db');
export const SETTINGS_FILE = resolve(DATA_DIR, 'settings.json'); // legacy, chỉ để migrate
