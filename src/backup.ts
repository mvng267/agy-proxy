import { store } from './store/index.js';
import { config } from './config.js';
import { pool, syncFromStore, savePersist } from './gateway/pool.js';
import { allSettings, setSetting, listComboRows, upsertComboRow } from './store/db.js';
import type { Account, Credential, Proxy } from './store/models.js';

/**
 * Backup/restore TOÀN BỘ hệ thống bằng 1 file JSON (kèm token).
 * Gồm: accounts + proxies + credentials + gateway pool state + config runtime.
 * KHÔNG gồm: state.db (history tái tạo được), profiles/ (binary lớn).
 */

export interface BackupData {
  version: number;
  exportedAt: string;
  counts: { accounts: number; proxies: number; credentials: number };
  accounts: Account[];
  proxies: Proxy[];
  credentials: Credential[];
  gateway: Record<string, any>;
  config: any;
  /** v2: toàn bộ bảng settings (gồm secret) — khôi phục là chạy ngay. */
  settings?: Record<string, string>;
  /** v2: combo do người dùng tạo (chuỗi model có fallback). */
  combos?: Array<{ id: string; name: string; strategy: string; targets: unknown; enabled: boolean }>;
}

export function buildBackup(): BackupData {
  const accounts = store.listAccounts();
  const proxies = store.listProxies();
  const credentials = store.listCredentials();
  // sessionSecret KHÔNG vào backup: nó chỉ ký cookie phiên dashboard của MÁY NÀY và
  // được tự sinh lại lúc boot nếu thiếu — mang theo chỉ giúp kẻ cầm file backup giả
  // được cookie đăng nhập. Các secret còn lại (mật khẩu OmniRoute, API key, hash mật
  // khẩu dashboard) vẫn giữ để khôi phục máy mới là chạy được ngay.
  const { sessionSecret: _omit, ...settings } = allSettings();
  return {
    version: 2,
    settings,
    combos: listComboRows().map((c) => ({ id: c.id, name: c.name, strategy: c.strategy, targets: JSON.parse(c.targets_json), enabled: c.enabled !== 0 })),
    exportedAt: new Date().toISOString(),
    counts: { accounts: accounts.length, proxies: proxies.length, credentials: credentials.length },
    accounts,
    proxies,
    credentials,
    gateway: pool.toPersist(),
    config: {
      pacing: { ...config.pacing },
      dailyLoginCap: config.dailyLoginCap,
      headless: config.headless,
      fingerprint: config.fingerprint,
      gateway: {
        rotation: config.gateway.rotation,
        apiKey: config.gateway.apiKey,
        outboundProxy: config.gateway.outboundProxy,
        cooldownSec: config.gateway.cooldownSec,
        quota: { ...config.gateway.quota },
      },
    },
  };
}

export function restoreBackup(
  data: any,
  opts: { mode?: 'merge' | 'replace' } = {},
): { restored: { accounts: number; proxies: number; credentials: number; gateway: number } } {
  if (!data || typeof data !== 'object' || (data.version !== 1 && data.version !== 2)) {
    throw new Error('File backup không hợp lệ (cần version 1 hoặc 2)');
  }
  const mode = opts.mode === 'replace' ? 'replace' : 'merge';

  // 1) proxies
  if (Array.isArray(data.proxies)) {
    if (mode === 'replace') store.replaceProxies(data.proxies);
    else for (const p of data.proxies) if (p?.label) store.upsertProxy(p);
  }
  // 2) accounts
  if (Array.isArray(data.accounts)) {
    if (mode === 'replace') store.replaceAccounts(data.accounts);
    else for (const a of data.accounts) if (a?.email) store.upsertAccount(a);
  }
  // 3) credentials
  if (Array.isArray(data.credentials)) {
    if (mode === 'replace') store.replaceCredentials(data.credentials);
    else for (const c of data.credentials) if (c?.email && c?.target) store.upsertCredential(c);
  }
  // 4) gateway pool: dựng pool từ credentials rồi áp state từ backup (ghi đè)
  syncFromStore();
  if (data.gateway && typeof data.gateway === 'object') {
    for (const [email, s] of Object.entries<any>(data.gateway)) {
      const a = pool.accounts.get(email);
      if (!a) continue;
      if (typeof s.enabled === 'boolean') a.enabled = s.enabled;
      a.requests = s.requests ?? a.requests;
      a.tokensIn = s.tokensIn ?? a.tokensIn;
      a.tokensOut = s.tokensOut ?? a.tokensOut;
      a.lastUsed = s.lastUsed ?? a.lastUsed;
      if (s.quota) a.quota = s.quota;
      if (s.projectId) a.projectId = s.projectId;
    }
    savePersist();
  }
  // 5) settings (v2): ghi thẳng vào DB → cấu hình sống qua restart
  if (data.settings && typeof data.settings === 'object') {
    for (const [k, v] of Object.entries<any>(data.settings)) {
      // Backup cũ (trước khi export loại sessionSecret) vẫn có thể mang key này —
      // không nhận: secret phiên là của riêng từng máy.
      if (k === 'sessionSecret') continue;
      if (v !== undefined && v !== null) setSetting(k, String(v));
    }
  }

  // 5b) combo
  if (Array.isArray(data.combos)) {
    for (const c of data.combos) {
      try {
        upsertComboRow({ id: c.id, name: c.name, strategy: c.strategy, targets: c.targets, enabled: c.enabled });
      } catch {
        /* combo hỏng → bỏ qua, không chặn phần còn lại */
      }
    }
  }

  // 6) config runtime (backup v1 cũ) — vẫn áp để tương thích ngược
  const c = data.config;
  if (c && typeof c === 'object') {
    if (c.pacing) {
      if (typeof c.pacing.minSec === 'number') config.pacing.minSec = c.pacing.minSec;
      if (typeof c.pacing.maxSec === 'number') config.pacing.maxSec = c.pacing.maxSec;
    }
    if (typeof c.dailyLoginCap === 'number') config.dailyLoginCap = c.dailyLoginCap;
    if (typeof c.headless === 'boolean') config.headless = c.headless;
    if (typeof c.fingerprint === 'boolean') config.fingerprint = c.fingerprint;
    if (c.gateway) {
      const g = c.gateway;
      if (g.rotation) config.gateway.rotation = g.rotation;
      if (typeof g.apiKey === 'string') config.gateway.apiKey = g.apiKey;
      if (typeof g.outboundProxy === 'string') config.gateway.outboundProxy = g.outboundProxy;
      if (typeof g.cooldownSec === 'number') config.gateway.cooldownSec = g.cooldownSec;
      if (g.quota && typeof g.quota === 'object') Object.assign(config.gateway.quota, g.quota);
    }
  }

  return {
    restored: {
      accounts: Array.isArray(data.accounts) ? data.accounts.length : 0,
      proxies: Array.isArray(data.proxies) ? data.proxies.length : 0,
      credentials: Array.isArray(data.credentials) ? data.credentials.length : 0,
      gateway: data.gateway ? Object.keys(data.gateway).length : 0,
    },
  };
}
