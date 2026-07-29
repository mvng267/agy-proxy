import { writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dispatcher } from 'undici';
import { DATA_DIR, config } from '../config.js';
import { store } from '../store/index.js';
import {
  refreshAccessToken,
  discoverProject,
  proxyDispatcher,
  fetchQuota,
  type TokenInfo,
  type QuotaInfo,
} from './antigravity.js';

/**
 * Pool account Antigravity + 4 chiến lược xoay. Logic chọn/đếm/cooldown tách vào
 * class Pool (pure, unit-test được, không đụng mạng). Phần lấy token/project
 * (mạng) nằm ở hàm ensureReady dùng singleton.
 */

export type Strategy = 'round-robin' | 'full-first' | 'failover' | 'highest-first';

export interface PoolAccount {
  email: string;
  refreshToken: string;
  proxyLabel: string;
  health: string;
  // persisted
  enabled: boolean;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  lastUsed: number; // epoch ms, 0 = chưa dùng
  // RAM
  lastError: string;
  cooldownUntil: number; // epoch ms
  inflight: number; // số request đang chạy trên account này (concurrency-aware rotation)
  quota?: QuotaInfo; // hạn mức Antigravity (cache)
  liveStatus?: 'ok' | 'quota' | 'error'; // kết quả check live gần nhất
  token?: TokenInfo;
  projectId?: string;
  ready?: Promise<{ accessToken: string; projectId: string }>; // dedupe refresh khi nhiều call đồng thời
}

/** % hạn mức Gemini còn lại (dùng cho highest-first). null nếu chưa fetch. */
export function geminiPct(a: PoolAccount): number | null {
  const g = a.quota?.groups?.find((x) => /gemini/i.test(x.name));
  return g ? g.pct : null;
}

export interface ReportInfo {
  ok: boolean;
  promptTokens?: number;
  completionTokens?: number;
  status?: number; // HTTP status khi lỗi
  err?: string;
}

export class NoAccountError extends Error {
  code = 503;
  constructor(msg = 'Không có account Antigravity khả dụng (tắt hết / cooldown / dead)') {
    super(msg);
  }
}

function blankAccount(email: string, refreshToken: string, proxyLabel: string, health: string): PoolAccount {
  return {
    email,
    refreshToken,
    proxyLabel,
    health,
    enabled: true,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    lastUsed: 0,
    lastError: '',
    cooldownUntil: 0,
    inflight: 0,
    quota: undefined,
  };
}

export class Pool {
  accounts = new Map<string, PoolAccount>();
  private rrCursor = 0;

  /** Thêm/cập nhật account (giữ nguyên state cũ nếu đã tồn tại). */
  upsert(email: string, refreshToken: string, proxyLabel: string, health: string): PoolAccount {
    const cur = this.accounts.get(email);
    if (cur) {
      cur.refreshToken = refreshToken;
      cur.proxyLabel = proxyLabel;
      cur.health = health;
      return cur;
    }
    const a = blankAccount(email, refreshToken, proxyLabel, health);
    this.accounts.set(email, a);
    return a;
  }

  remove(email: string): void {
    this.accounts.delete(email);
  }

  list(): PoolAccount[] {
    return [...this.accounts.values()];
  }

  /** Account đủ điều kiện phục vụ tại thời điểm now. */
  candidates(now = Date.now()): PoolAccount[] {
    return this.list().filter(
      (a) => a.enabled && a.health !== 'dead' && (a.cooldownUntil || 0) <= now,
    );
  }

  /**
   * Chọn account theo strategy + đánh dấu bận (inflight++). Ném NoAccountError nếu hết.
   * CONCURRENCY-AWARE: ưu tiên account đang RẢNH (inflight nhỏ nhất) → khi gọi liên tục,
   * mọi strategy đều tự xoay sang account khác thay vì dồn 1 account. Khi tải thấp thì
   * full-first/failover vẫn "dính" account đầu như thiết kế.
   */
  pick(strategy: Strategy, now = Date.now()): PoolAccount {
    const all = this.candidates(now);
    if (!all.length) throw new NoAccountError();
    // chỉ xét nhóm account đang rảnh nhất (inflight tối thiểu)
    const minInflight = Math.min(...all.map((a) => a.inflight));
    const c = all.filter((a) => a.inflight === minInflight);
    let chosen: PoolAccount;
    switch (strategy) {
      case 'round-robin': {
        chosen = c[this.rrCursor % c.length]!;
        this.rrCursor = (this.rrCursor + 1) % Math.max(1, c.length);
        break;
      }
      case 'highest-first': {
        chosen = [...c].sort((x, y) => {
          const cx = geminiPct(x) ?? -1;
          const cy = geminiPct(y) ?? -1;
          if (cy !== cx) return cy - cx;
          return (x.lastUsed || 0) - (y.lastUsed || 0);
        })[0]!;
        break;
      }
      case 'full-first':
      case 'failover':
      default:
        chosen = c[0]!;
    }
    chosen.inflight++;
    return chosen;
  }

  /** Giải phóng account sau khi request xong (inflight--). */
  release(email: string): void {
    const a = this.accounts.get(email);
    if (a && a.inflight > 0) a.inflight--;
  }

  /** Cập nhật counters + cooldown sau 1 request. */
  report(email: string, info: ReportInfo, now = Date.now()): void {
    const a = this.accounts.get(email);
    if (!a) return;
    a.requests++;
    a.tokensIn += info.promptTokens ?? 0;
    a.tokensOut += info.completionTokens ?? 0;
    a.lastUsed = now;
    if (info.ok) {
      a.lastError = '';
    } else {
      a.lastError = info.err ?? `HTTP ${info.status ?? '?'}`;
      const quota = info.status === 429 || /quota|exhaust|resource_exhausted/i.test(info.err ?? '');
      if (quota) a.cooldownUntil = now + config.gateway.cooldownSec * 1000;
    }
  }

  /** State cần persist (enabled + counters + quota cache). */
  toPersist(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const a of this.accounts.values()) {
      out[a.email] = {
        enabled: a.enabled,
        requests: a.requests,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        lastUsed: a.lastUsed,
        quota: a.quota,
        projectId: a.projectId, // stable per-account → bỏ discoverProject chậm sau restart
      };
    }
    return out;
  }

  applyPersist(data: Record<string, Partial<PoolAccount>>): void {
    for (const [email, s] of Object.entries(data || {})) {
      const a = this.accounts.get(email);
      if (!a) continue;
      if (typeof s.enabled === 'boolean') a.enabled = s.enabled;
      a.requests = s.requests ?? a.requests;
      a.tokensIn = s.tokensIn ?? a.tokensIn;
      a.tokensOut = s.tokensOut ?? a.tokensOut;
      a.lastUsed = s.lastUsed ?? a.lastUsed;
      if (s.quota && !a.quota) a.quota = s.quota; // giữ quota qua restart (TTL tự lo refresh)
      if (s.projectId && !a.projectId) a.projectId = s.projectId; // bỏ discoverProject sau restart
    }
  }
}

// ---------- singleton + tích hợp store/mạng ----------
export const pool = new Pool();
const PERSIST = resolve(DATA_DIR, 'gateway.json');
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Nạp account agy từ store (giữ state), rồi áp persist. Gọi lúc boot + khi cần refresh danh sách. */
export function syncFromStore(): void {
  const creds = store.listCredentials().filter((c) => c.target === 'agy' && c.value.startsWith('1//'));
  const seen = new Set<string>();
  for (const c of creds) {
    const acc = store.getAccount(c.email);
    pool.upsert(c.email, c.value, acc?.proxy ?? '', c.health || 'unknown');
    seen.add(c.email);
  }
  for (const a of pool.list()) if (!seen.has(a.email)) pool.remove(a.email);
  loadPersist();
}

let persistLoaded = false;
function loadPersist(): void {
  if (persistLoaded) {
    // đã có state trong RAM; chỉ áp cho account mới
  }
  if (!existsSync(PERSIST)) {
    persistLoaded = true;
    return;
  }
  try {
    const data = JSON.parse(readFileSync(PERSIST, 'utf8')) as Record<string, Partial<PoolAccount>>;
    pool.applyPersist(data);
  } catch {
    /* file hỏng → bỏ qua */
  }
  persistLoaded = true;
}

export function savePersist(): void {
  try {
    const tmp = PERSIST + '.tmp';
    writeFileSync(tmp, JSON.stringify(pool.toPersist(), null, 2));
    renameSync(tmp, PERSIST);
  } catch {
    /* không chặn request vì lỗi ghi */
  }
}

/** Proxy URL từ label account (proxies.csv) → http://user:pass@host:port. */
export function proxyUrlForLabel(label: string): string | undefined {
  if (!label) return undefined;
  const p = store.getProxy(label);
  if (!p) return undefined;
  const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
  return `http://${auth}${p.host}:${p.port}`;
}

/** Chọn dispatcher proxy cho account: override → account.proxy → global config → direct. */
export function dispatcherFor(account: PoolAccount, overrideProxyUrl?: string): Dispatcher | undefined {
  const url = overrideProxyUrl || proxyUrlForLabel(account.proxyLabel) || config.gateway.outboundProxy || '';
  return proxyDispatcher(url || undefined);
}

/**
 * Đảm bảo có access_token còn hạn + projectId. Gọi mạng khi cần.
 * DEDUPE: nhiều request đồng thời trúng cùng account (chưa có token/project) sẽ
 * dùng CHUNG 1 lần refresh — tránh gọi trùng gây rate limit khi burst.
 */
export async function ensureReady(
  account: PoolAccount,
  dispatcher?: Dispatcher,
): Promise<{ accessToken: string; projectId: string }> {
  const now = Date.now();
  const fresh = account.token && account.token.expiresAt - REFRESH_SKEW_MS > now && account.projectId;
  if (fresh) return { accessToken: account.token!.accessToken, projectId: account.projectId! };
  if (!account.ready) {
    account.ready = (async () => {
      if (!account.token || account.token.expiresAt - REFRESH_SKEW_MS <= Date.now()) {
        account.token = await refreshAccessToken(account.refreshToken, dispatcher);
        account.health = 'alive';
      }
      if (!account.projectId) {
        account.projectId = await discoverProject(account.token.accessToken, dispatcher);
      }
      return { accessToken: account.token.accessToken, projectId: account.projectId };
    })().finally(() => { account.ready = undefined; });
  }
  return account.ready;
}

/** Nạp hạn mức cho account (cache TTL). force=true bỏ qua cache. */
export async function refreshQuota(account: PoolAccount, force = false): Promise<QuotaInfo | undefined> {
  const ttl = (config.gateway.quota?.cacheTtlMin ?? 10) * 60 * 1000;
  if (!force && account.quota && Date.now() - account.quota.fetchedAt < ttl) return account.quota;
  const dispatcher = dispatcherFor(account);
  const { accessToken, projectId } = await ensureReady(account, dispatcher);
  account.quota = await fetchQuota(accessToken, projectId, dispatcher);
  savePersist();
  return account.quota;
}
