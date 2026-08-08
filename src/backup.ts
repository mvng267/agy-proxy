import { store } from './store/index.js';
import { config } from './config.js';
import { pool, syncFromStore, savePersist } from './gateway/pool.js';
import { allSettings, setSetting, listComboRows, upsertComboRow, BACKUP_TABLES, dumpTable, loadTable, type BackupTable } from './store/db.js';
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
  /**
   * v3: các bảng còn lại, để chuyển TOÀN BỘ hệ thống giữa server chứ không chỉ account.
   * Quan trọng nhất là `api_keys` — key lưu dạng hash nên mất là phải phát lại cho
   * từng người dùng. Xem BACKUP_TABLES để biết bảng nào vì sao.
   */
  tables?: Partial<Record<BackupTable, Record<string, unknown>[]>>;
}

/** Tối đa số dòng lịch sử mỗi bảng — file backup không nên phình vô hạn. */
export const HISTORY_LIMIT = 50_000;

export interface BuildOpts {
  /**
   * Kèm bảng lịch sử (usage/quota/runs). Mặc định KHÔNG — quota_history một mình
   * chiếm 17MB/23.9MB (71% file) mà chỉ để vẽ biểu đồ xu hướng. Chuyển server thì
   * thứ bắt buộc phải đi theo là account + credential + api_keys, không phải lịch sử.
   */
  history?: boolean;
}

export function buildBackup(opts: BuildOpts = {}): BackupData {
  const accounts = store.listAccounts();
  const proxies = store.listProxies();
  const credentials = store.listCredentials();
  // sessionSecret KHÔNG vào backup: nó chỉ ký cookie phiên dashboard của MÁY NÀY và
  // được tự sinh lại lúc boot nếu thiếu — mang theo chỉ giúp kẻ cầm file backup giả
  // được cookie đăng nhập. Các secret còn lại (mật khẩu OmniRoute, API key, hash mật
  // khẩu dashboard) vẫn giữ để khôi phục máy mới là chạy được ngay.
  const { sessionSecret: _omit, ...settings } = allSettings();
  // Bảng 'core' LUÔN đi theo (api_keys: hash không tái tạo được, mất là phải phát lại
  // key cho từng người). Bảng 'history' chỉ khi được yêu cầu, và có trần riêng.
  const tables: Partial<Record<BackupTable, Record<string, unknown>[]>> = {};
  for (const [t, kind] of Object.entries(BACKUP_TABLES) as Array<[BackupTable, string]>) {
    if (kind === 'history' && !opts.history) continue;
    const rows = dumpTable(t, kind === 'history' ? HISTORY_LIMIT : undefined);
    if (rows.length) tables[t] = rows;
  }

  return {
    version: 3,
    tables,
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
): { restored: { accounts: number; proxies: number; credentials: number; gateway: number; tables?: Record<string, number> } } {
  if (!data || typeof data !== 'object' || ![1, 2, 3].includes(data.version)) {
    throw new Error('File backup không hợp lệ (cần version 1, 2 hoặc 3)');
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

  // 5c) các bảng còn lại (v3): api_keys + lịch sử.
  //
  // `merge` dùng INSERT OR IGNORE nên gộp dữ liệu hai server không vỡ vì trùng id;
  // `replace` xoá sạch bảng trước — đúng khi CHUYỂN HẲN sang máy mới.
  const tableCounts: Record<string, number> = {};
  if (data.tables && typeof data.tables === 'object') {
    for (const [t, rows] of Object.entries<any>(data.tables)) {
      if (!Array.isArray(rows)) continue;
      try {
        tableCounts[t] = loadTable(t as BackupTable, rows, mode === 'replace');
      } catch (e) {
        // Một bảng hỏng KHÔNG được chặn phần còn lại — account vẫn phải khôi phục được.
        tableCounts[t] = 0;
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
      ...(Object.keys(tableCounts).length ? { tables: tableCounts } : {}),
    },
  };
}
