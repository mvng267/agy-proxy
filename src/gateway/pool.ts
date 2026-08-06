import { writeFileSync, readFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dispatcher } from 'undici';
import { DATA_DIR, config } from '../config.js';
import { store } from '../store/index.js';
import { recordQuota } from '../store/db.js';
import { PROVIDERS, providerOfTarget, type ProviderAccount, type ProviderId, type ProviderSession } from './providers/index.js';
import { proxyDispatcher, type TokenInfo, type QuotaInfo, type QuotaBucket } from './antigravity.js';

/**
 * Pool account ĐA PROVIDER (Antigravity + Kiro) + 4 chiến lược xoay.
 * Logic chọn/đếm/cooldown nằm trong class Pool (thuần, unit-test được, không đụng mạng);
 * phần mạng (token/project) do provider lo, pool chỉ dedupe promise.
 *
 * KHOÁ GHÉP `${provider}:${email}` — bắt buộc vì 147 email Kiro trùng email Antigravity.
 */

export type Strategy = 'round-robin' | 'full-first' | 'failover' | 'highest-first';

export function poolKey(provider: ProviderId, email: string): string {
  return `${provider}:${email}`;
}

export interface UpsertInput {
  provider: ProviderId;
  email: string;
  refreshToken: string;
  credential: string;
  proxyLabel: string;
  health: string;
  profileArn?: string;
  region?: string;
}

export interface PoolAccount extends ProviderAccount {
  proxyLabel: string;
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
  /** Account hết hạn mức THÁNG — skip đến epoch ms này (đầu tháng kế). 0 = bình thường. */
  monthlyExhaustedUntil: number;
  token?: TokenInfo;
  projectId?: string;
  ready?: Promise<ProviderSession>; // dedupe refresh khi nhiều call đồng thời
}

/** Nhóm quota nào là bể Gemini (upstream đặt tên "Gemini Models"). */
const isGeminiGroup = (name: string) => /gemini/i.test(name);

/** % hạn mức Gemini còn lại (dùng cho highest-first). null nếu chưa fetch. */
export function geminiPct(a: PoolAccount): number | null {
  const g = a.quota?.groups?.find((x) => isGeminiGroup(x.name));
  if (g) return g.pct;
  // Provider khác (Kiro dùng nhóm 'Credits') → lấy nhóm đầu để highest-first vẫn xoay đúng
  const first = a.quota?.groups?.[0];
  return first ? first.pct : null;
}

/**
 * % hạn mức bể Claude+GPT còn lại ("Claude and GPT models"). null nếu chưa fetch
 * hoặc provider không chia bể.
 */
export function claudePct(a: PoolAccount): number | null {
  const g = a.quota?.groups?.find((x) => !isGeminiGroup(x.name));
  return g ? g.pct : null;
}

/**
 * % còn lại của ĐÚNG bể mà model sắp gọi thuộc về.
 *
 * Cần thiết vì 2 bể độc lập: xếp hạng account bằng % Gemini khi đang gọi model Claude
 * sẽ chọn nhầm account đã cạn Claude (Gemini 100% mà Claude 0% vẫn được ưu tiên).
 * Không biết bể (Kiro, hoặc chưa nạp quota) → rơi về geminiPct như cũ.
 */
export function bucketPct(a: PoolAccount, bucket?: QuotaBucket): number | null {
  if (bucket === 'claude') return claudePct(a) ?? geminiPct(a);
  return geminiPct(a);
}

export interface ReportInfo {
  ok: boolean;
  promptTokens?: number;
  completionTokens?: number;
  status?: number; // HTTP status khi lỗi
  err?: string;
  /** Google bảo chờ bao lâu (RetryInfo.retryDelay / Retry-After). Có thì cooldown đúng bằng đó. */
  retryAfterMs?: number;
}

export class NoAccountError extends Error {
  code = 503;
  constructor(msg = 'Không có account khả dụng (tắt hết / cooldown / dead)') {
    super(msg);
  }
}

function blankAccount(i: UpsertInput): PoolAccount {
  return {
    provider: i.provider,
    email: i.email,
    key: poolKey(i.provider, i.email),
    refreshToken: i.refreshToken,
    credential: i.credential,
    profileArn: i.profileArn,
    region: i.region,
    proxyLabel: i.proxyLabel,
    health: i.health,
    enabled: true,
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    lastUsed: 0,
    lastError: '',
    cooldownUntil: 0,
    inflight: 0,
    monthlyExhaustedUntil: 0,
    quota: undefined,
  };
}

export class Pool {
  accounts = new Map<string, PoolAccount>(); // khoá = `${provider}:${email}`
  /** @deprecated — giữ lại để không break import cũ; pick() không dùng nữa. */
  private rrCursor = new Map<ProviderId, number>(); // legacy — replaced by lastUsed-based rotation

  /** Thêm/cập nhật account (giữ nguyên state cũ nếu đã tồn tại). */
  upsert(i: UpsertInput): PoolAccount {
    const key = poolKey(i.provider, i.email);
    const cur = this.accounts.get(key);
    if (cur) {
      cur.refreshToken = i.refreshToken;
      cur.credential = i.credential;
      cur.proxyLabel = i.proxyLabel;
      cur.health = i.health;
      if (i.profileArn) cur.profileArn = i.profileArn;
      if (i.region) cur.region = i.region;
      return cur;
    }
    const a = blankAccount(i);
    this.accounts.set(key, a);
    return a;
  }

  /** Lấy theo email + provider (mặc định agy để tương thích code cũ). */
  get(email: string, provider: ProviderId = 'agy'): PoolAccount | undefined {
    return this.accounts.get(poolKey(provider, email));
  }
  getByKey(key: string): PoolAccount | undefined {
    return this.accounts.get(key);
  }

  remove(key: string): void {
    this.accounts.delete(key);
  }

  list(provider?: ProviderId): PoolAccount[] {
    const all = [...this.accounts.values()];
    return provider ? all.filter((a) => a.provider === provider) : all;
  }

  /** Account đủ điều kiện phục vụ tại thời điểm now (lọc theo provider nếu có). */
  candidates(now = Date.now(), provider?: ProviderId): PoolAccount[] {
    return this.list(provider).filter(
      (a) => a.enabled && a.health !== 'dead'
        && (a.cooldownUntil || 0) <= now
        && (a.monthlyExhaustedUntil || 0) <= now,
    );
  }

  /**
   * Chọn account theo strategy + đánh dấu bận (inflight++). Ném NoAccountError nếu hết.
   * CONCURRENCY-AWARE: ưu tiên account đang RẢNH (inflight nhỏ nhất) → khi gọi liên tục,
   * mọi strategy đều tự xoay sang account khác thay vì dồn 1 account. Khi tải thấp thì
   * full-first/failover vẫn "dính" account đầu như thiết kế.
   */
  pick(strategy: Strategy, now = Date.now(), provider?: ProviderId, bucket?: QuotaBucket): PoolAccount {
    const all = this.candidates(now, provider);
    if (!all.length) {
      throw new NoAccountError(
        provider
          ? `Không có account ${PROVIDERS[provider]?.label ?? provider} khả dụng (tắt hết / cooldown / hết hạn mức)`
          : undefined,
      );
    }
    // chỉ xét nhóm account đang rảnh nhất (inflight tối thiểu)
    const minInflight = Math.min(...all.map((a) => a.inflight));
    const c = all.filter((a) => a.inflight === minInflight);
    let chosen: PoolAccount;
    switch (strategy) {
      case 'round-robin': {
        // LRU: chọn account lâu nhất chưa được dùng — đảm bảo TOÀN BỘ pool
        // đều được xoay đều, kể cả khi candidates thay đổi liên tục do cooldown.
        // (Trước đây dùng index cursor: khi array co/giãn thì cursor nhảy, bỏ qua
        //  account — đo thực tế có 160/402 account chưa được dùng lần nào.)
        chosen = c.reduce((oldest, a) => (a.lastUsed || 0) < (oldest.lastUsed || 0) ? a : oldest, c[0]!);
        break;
      }
      case 'highest-first': {
        chosen = [...c].sort((x, y) => {
          // Xếp theo % của ĐÚNG bể model sắp gọi — dùng % Gemini để chọn account
          // cho model Claude sẽ ưu tiên nhầm account đã cạn Claude.
          const cx = bucketPct(x, bucket) ?? -1;
          const cy = bucketPct(y, bucket) ?? -1;
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

  /** Giải phóng account sau khi request xong (inflight--). Nhận account hoặc khoá. */
  release(a: PoolAccount | string): void {
    const acc = typeof a === 'string' ? this.accounts.get(a) : a;
    if (acc && acc.inflight > 0) acc.inflight--;
  }

  /**
   * Cập nhật counters + cooldown sau 1 request.
   * Nhận OBJECT account (email không còn định danh duy nhất khi có 2 provider).
   */
  report(a: PoolAccount | string, info: ReportInfo, now = Date.now()): void {
    const acc = typeof a === 'string' ? this.accounts.get(a) : a;
    if (!acc) return;
    acc.requests++;
    acc.tokensIn += info.promptTokens ?? 0;
    acc.tokensOut += info.completionTokens ?? 0;
    acc.lastUsed = now;
    if (info.ok) {
      acc.lastError = '';
    } else {
      acc.lastError = info.err ?? `HTTP ${info.status ?? '?'}`;
      // 402 = Kiro hết hạn mức THÁNG; 429 = rate limit / quota Antigravity
      const monthly = info.status === 402 || /MONTHLY_REQUEST_COUNT/i.test(info.err ?? '');
      const quota = monthly || info.status === 429 || /quota|exhaust|resource_exhausted/i.test(info.err ?? '');
      if (quota) {
        if (monthly) {
          // Hết hạn mức THÁNG → sleep đến đầu tháng kế (thay vì 12h rồi lặp lại vô ích).
          // Tính ngày 1 tháng sau, 00:00 UTC+7 (Việt Nam).
          const d = new Date(now);
          const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
          // Thêm 1h buffer phòng server reset chậm
          acc.monthlyExhaustedUntil = nextMonth.getTime() + 3600_000;
          acc.cooldownUntil = acc.monthlyExhaustedUntil;
          acc.liveStatus = 'quota';
        } else {
          let ms = config.gateway.cooldownSec * 1000;
          const ra = info.retryAfterMs;
          if (ra != null && ra > 0) {
            const LONG = 3600_000; // >1h ⇒ hết hạn mức, không phải rate-limit
            ms = ra > LONG ? LONG : Math.min(Math.max(ra, 5_000), ms);
          }
          acc.cooldownUntil = now + ms;
          acc.liveStatus = 'quota';
        }
      }
    }
  }

  /** State cần persist (enabled + counters + quota cache). Khoá = `${provider}:${email}`. */
  toPersist(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const a of this.accounts.values()) {
      out[a.key] = {
        enabled: a.enabled,
        requests: a.requests,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
        lastUsed: a.lastUsed,
        quota: a.quota,
        projectId: a.projectId, // stable per-account → bỏ discoverProject chậm sau restart
        // Giữ cooldown + kết quả dò qua restart: account Kiro cạn hạn mức THÁNG nghỉ 12h,
        // nếu quên thì mỗi lần khởi động lại sẽ thử lại và đốt thêm 1 request thật.
        cooldownUntil: a.cooldownUntil || 0,
        monthlyExhaustedUntil: a.monthlyExhaustedUntil || 0,
        liveStatus: a.liveStatus,
      };
    }
    return out;
  }

  applyPersist(data: Record<string, Partial<PoolAccount>>): void {
    for (const [rawKey, s] of Object.entries(data || {})) {
      // khoá cũ (chỉ email, không có ':') = account Antigravity → migrate êm
      const key = rawKey.includes(':') ? rawKey : poolKey('agy', rawKey);
      const a = this.accounts.get(key);
      if (!a) continue;
      if (typeof s.enabled === 'boolean') a.enabled = s.enabled;
      a.requests = s.requests ?? a.requests;
      a.tokensIn = s.tokensIn ?? a.tokensIn;
      a.tokensOut = s.tokensOut ?? a.tokensOut;
      a.lastUsed = s.lastUsed ?? a.lastUsed;
      if (s.quota && !a.quota) a.quota = s.quota; // giữ quota qua restart (TTL tự lo refresh)
      if (s.projectId && !a.projectId) a.projectId = s.projectId; // bỏ discoverProject sau restart
      // chỉ khôi phục cooldown còn hiệu lực (đã qua thì bỏ)
      if (s.cooldownUntil && s.cooldownUntil > Date.now()) a.cooldownUntil = s.cooldownUntil;
      if (s.monthlyExhaustedUntil && s.monthlyExhaustedUntil > Date.now()) a.monthlyExhaustedUntil = s.monthlyExhaustedUntil;
      if (s.liveStatus && !a.liveStatus) a.liveStatus = s.liveStatus;
    }
  }
}

// ---------- singleton + tích hợp store/mạng ----------
export const pool = new Pool();
const PERSIST = resolve(DATA_DIR, 'gateway.json');
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const SYNC_MIN_MS = 2000; // syncFromStore chạy mỗi request → chặn quét lại quá dày
let lastSyncAt = 0;

/**
 * Nạp account MỌI provider từ store (giữ state), rồi áp persist.
 * Tối ưu: bỏ qua nếu vừa sync < 2s; chỉ parseCredential khi giá trị thô đổi
 * (147 credential Kiro là JSON — parse mỗi request sẽ rất tốn).
 */
export function syncFromStore(force = false): void {
  if (!force && Date.now() - lastSyncAt < SYNC_MIN_MS) return;
  const seen = new Set<string>();
  for (const c of store.listCredentials()) {
    const p = providerOfTarget(c.target);
    if (!p || !p.accepts(c.value)) continue;
    const existing = pool.get(c.email, p.id);
    const parsed =
      existing && existing.credential === c.value
        ? { refreshToken: existing.refreshToken, profileArn: existing.profileArn, region: existing.region }
        : p.parseCredential(c.value);
    if (!parsed) continue;
    const acc = store.getAccount(c.email);
    const a = pool.upsert({
      provider: p.id,
      email: c.email,
      credential: c.value,
      refreshToken: parsed.refreshToken,
      profileArn: parsed.profileArn,
      region: parsed.region,
      proxyLabel: acc?.proxy ?? '',
      health: c.health || 'unknown',
    });
    seen.add(a.key);
  }
  for (const a of pool.list()) if (!seen.has(a.key)) pool.remove(a.key);
  lastSyncAt = Date.now();
  loadPersist();
}

let persistMtime = -1;
function loadPersist(): void {
  if (!existsSync(PERSIST)) return;
  try {
    // Gate theo mtime: file này ~700KB, trước đây bị đọc lại MỖI request.
    const m = statSync(PERSIST).mtimeMs;
    if (m === persistMtime) return;
    persistMtime = m;
    const data = JSON.parse(readFileSync(PERSIST, 'utf8')) as Record<string, Partial<PoolAccount>>;
    pool.applyPersist(data);
  } catch {
    /* file hỏng → bỏ qua */
  }
}

/** Ghi persist ngay (đồng bộ). Dùng khi thoát tiến trình. */
export function flushPersist(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const tmp = PERSIST + '.tmp';
    writeFileSync(tmp, JSON.stringify(pool.toPersist(), null, 2));
    renameSync(tmp, PERSIST);
    persistMtime = statSync(PERSIST).mtimeMs;
  } catch {
    /* không chặn request vì lỗi ghi */
  }
}

let saveTimer: NodeJS.Timeout | null = null;
let persistDirty = false;

/** Đánh dấu cần ghi persist (dirty flag). Gộp nhiều lần ghi trong ~2s thành 1. */
export function savePersist(): void {
  persistDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (persistDirty) {
      persistDirty = false;
      flushPersist();
    }
  }, 2000);
  saveTimer.unref?.();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    flushPersist();
    process.exit(0);
  });
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
export async function ensureReady(account: PoolAccount, dispatcher?: Dispatcher): Promise<ProviderSession> {
  const p = PROVIDERS[account.provider];
  if (p.sessionFresh(account, Date.now())) return p.sessionOf(account);
  if (!account.ready) {
    account.ready = p
      .ensureReady(account, dispatcher)
      .then((s) => {
        account.health = 'alive';
        return s;
      })
      .finally(() => {
        account.ready = undefined;
      });
  }
  return account.ready;
}

/** Nạp hạn mức cho account (cache TTL). force=true bỏ qua cache. Provider không có quota → undefined. */
export async function refreshQuota(account: PoolAccount, force = false): Promise<QuotaInfo | undefined> {
  const p = PROVIDERS[account.provider];
  if (!p.quota) return undefined; // Kiro: không có API hạn mức
  const ttl = (config.gateway.quota?.cacheTtlMin ?? 10) * 60 * 1000;
  if (!force && account.quota && Date.now() - account.quota.fetchedAt < ttl) return account.quota;
  const dispatcher = dispatcherFor(account);
  const session = await ensureReady(account, dispatcher);
  account.quota = await p.quota(account, session, dispatcher);
  // Ghi LỊCH SỬ hạn mức (chỉ khi fetch thật + có dữ liệu) để vẽ xu hướng theo thời gian.
  if (account.quota?.groups?.length) {
    try {
      const third = account.quota.groups.find((g) => !/gemini/i.test(g.name));
      recordQuota({
        ts: account.quota.fetchedAt || Date.now(),
        email: account.email,
        tier: account.quota.tier,
        geminiPct: geminiPct(account),
        thirdPct: third ? third.pct : null,
        models: account.quota.models,
      });
    } catch {
      /* không để lỗi ghi lịch sử chặn luồng chính */
    }
  }
  savePersist();
  return account.quota;
}
