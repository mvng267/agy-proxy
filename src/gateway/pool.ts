import { writeFileSync, readFileSync, renameSync, existsSync, statSync, chmodSync } from 'node:fs';
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

export type Strategy = 'round-robin' | 'full-first' | 'failover' | 'highest-first' | 'smart';

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
  lastUsed: number; // epoch ms, 0 = chưa dùng. CHỈ cập nhật khi request THÀNH CÔNG (LRU).
  lastAttempt?: number; // epoch ms mọi lần gọi kể cả lỗi — để debug, không ảnh hưởng LRU
  /**
   * Lần KIỂM account gần nhất (testAccount / checkLiveAccount) — khác hẳn `lastUsed`
   * (lúc phục vụ request thật). Không có mốc này thì UI hiện "alive" mà không ai biết
   * đó là kết quả của 1 phút trước hay 3 ngày trước; trạng thái cũ tin được ít hơn nhiều.
   */
  lastCheckAt?: number;
  consecutiveFails?: number; // số lỗi liên tiếp → cooldown tăng dần (backoff)
  /**
   * Bitmask 20 kết quả gần nhất (1 = lỗi) + số mẫu đã có. CHỈ RAM, không persist:
   * sau restart mọi account bắt đầu lại từ "chưa biết", an toàn hơn là tin vào lịch sử
   * cũ của một upstream có thể đã hồi phục.
   */
  recentFails?: number;
  recentCount?: number;
  /** Độ trễ trung bình trượt (EWMA, ms). Chỉ RAM. */
  latencyEwmaMs?: number;
  // RAM
  lastError: string;
  cooldownUntil: number; // epoch ms — cooldown TOÀN CỤC (mọi bể)
  /**
   * Cooldown RIÊNG từng bể quota. Antigravity chia 2 bể độc lập (đo thật: cùng account
   * Gemini 100% mà Claude 0%), nên 429 ở bể Claude KHÔNG được khoá luôn bể Gemini.
   * Trước đây chỉ có cooldownUntil toàn cục → account còn nguyên quota Gemini vẫn bị
   * loại khỏi pool, làm pool co lại một nửa một cách âm thầm.
   */
  bucketCooldown?: Partial<Record<QuotaBucket, number>>;
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
  const groups = a.quota?.groups;
  const g = groups?.find((x) => isGeminiGroup(x.name));
  if (g) return g.pct;
  // Provider KHÔNG chia bể (Kiro chỉ có nhóm 'Credits') → dùng nhóm duy nhất đó.
  // Nhưng nếu có ≥2 nhóm mà không nhóm nào là Gemini (vd fetch quota lỗi một phần),
  // trả null thay vì lấy bừa groups[0] — số của bể Claude gắn nhãn "gemini" sẽ làm
  // highest-first xếp hạng sai. "Không biết" an toàn hơn số sai.
  if (groups?.length === 1) return groups[0]!.pct;
  return null;
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
/** Tỉ lệ lỗi trong cửa sổ 20 kết quả gần nhất. null = chưa đủ mẫu để kết luận. */
export function errRate(a: PoolAccount): number | null {
  const n = a.recentCount ?? 0;
  if (n < 3) return null; // 1-2 mẫu không nói lên điều gì, đừng phạt oan
  let bits = a.recentFails ?? 0;
  let fails = 0;
  for (let i = 0; i < n; i++) { fails += bits & 1; bits >>>= 1; }
  return fails / n;
}

/** Ghi 1 kết quả vào cửa sổ trượt 20 + cập nhật EWMA độ trễ. */
export function recordOutcome(a: PoolAccount, ok: boolean, latencyMs?: number): void {
  const WINDOW = 20;
  a.recentFails = (((a.recentFails ?? 0) << 1) | (ok ? 0 : 1)) & ((1 << WINDOW) - 1);
  a.recentCount = Math.min((a.recentCount ?? 0) + 1, WINDOW);
  if (typeof latencyMs === 'number' && latencyMs > 0) {
    const prev = a.latencyEwmaMs;
    a.latencyEwmaMs = prev == null ? latencyMs : prev * 0.7 + latencyMs * 0.3;
  }
}

/**
 * Chấm điểm account cho chiến lược `smart` — càng cao càng nên chọn.
 *
 * 4 thành phần chuẩn hoá 0..1, trọng số theo kế hoạch đã chốt:
 *   quota 0.45 · errRate 0.25 · latency 0.15 · load 0.15
 *
 * Quota nặng nhất vì đó là yêu cầu gốc: "nên chọn model có nhiều quota nhất trong
 * danh sách tài khoản". `bucketPct` đọc ĐÚNG bể của model sắp gọi — dùng % Gemini để
 * chọn account cho model Claude sẽ ưu tiên nhầm account đã cạn Claude.
 *
 * Thiếu dữ liệu thì trả về TRUNG TÍNH (0.5) chứ không phải 0: account chưa có số đo
 * không đáng bị xếp sau account đã biết là kém — nếu không thì account mới không bao
 * giờ được gọi, và vì thế không bao giờ có số đo. (Đúng lỗi 160/402 account chưa từng
 * được dùng đã gặp ở chiến lược cursor cũ.)
 */
/** Số liệu chấm điểm cũ hơn mốc này thì bỏ — upstream có thể đã đổi trạng thái hẳn. */
export const SCORE_STALE_MS = 30 * 60_000;

export const SCORE_WEIGHTS = { quota: 0.45, errRate: 0.25, latency: 0.15, load: 0.15 } as const;

export function scoreAccount(a: PoolAccount, bucket?: QuotaBucket, maxInflight = 1): number {
  const pct = bucketPct(a, bucket);
  const qs = pct == null ? 0.5 : Math.max(0, Math.min(1, pct / 100));

  const er = errRate(a);
  const es = er == null ? 0.5 : 1 - er;

  // 3s là mốc "chậm rõ rệt" cho 1 lượt gọi; trên mốc đó điểm chạm 0.
  const lat = a.latencyEwmaMs;
  const ls = lat == null ? 0.5 : Math.max(0, 1 - lat / 3000);

  const load = maxInflight > 0 ? 1 - a.inflight / (maxInflight + 1) : 1;

  const w = SCORE_WEIGHTS;
  return qs * w.quota + es * w.errRate + ls * w.latency + Math.max(0, load) * w.load;
}

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
  /** Bể quota của model vừa gọi — 429 chỉ khoá đúng bể đó, không khoá cả account. */
  bucket?: QuotaBucket;
  /** Thời gian gọi (ms) — nuôi EWMA độ trễ cho chiến lược `smart`. Thiếu thì bỏ qua. */
  latencyMs?: number;
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

/**
 * Lỗi xác thực VĨNH VIỄN — token bị thu hồi/hết hiệu lực, thử lại vô ích.
 *
 * Phải rất thận trọng ở đây: đánh `dead` là loại account khỏi pool cho tới khi người
 * dùng test lại thủ công. Đã có lần 180/201 account bị dead oan mà test lại thì 5/5
 * sống (xem testAccount trong gateway/routes.ts) — nên CHỈ nhận những mã Google nói rõ
 * là token không dùng được nữa, không gộp 5xx hay lỗi mạng vào đây.
 */
export function isPermanentAuthError(msg: string, status?: number): boolean {
  if (/invalid_grant|invalid_client|unauthorized_client|revoked|token has been expired/i.test(msg)) return true;
  return status === 401 || status === 403;
}

/** Lỗi hạ tầng thoáng qua: 5xx, timeout, đứt mạng. Cooldown ngắn rồi thử lại. */
export function isTransientError(msg: string, status?: number): boolean {
  if (typeof status === 'number' && status >= 500) return true;
  return /timeout|aborted|ECONN|EPIPE|ETIMEDOUT|socket|fetch failed|network/i.test(msg);
}

/**
 * Mốc reset hạn mức tháng: 00:00 ngày 1 tháng sau theo giờ Việt Nam (UTC+7), + 1h buffer.
 *
 * Trước đây dùng `new Date(y, m+1, 1)` — đó là giờ MÁY CHỦ, nên chạy trong Docker (TZ=UTC)
 * lệch 7 tiếng so với ý định ghi trong comment. Nay tính tường minh bằng UTC.
 */
export const RESET_TZ_OFFSET_H = 7;
export function nextMonthResetMs(now: number): number {
  const d = new Date(now + RESET_TZ_OFFSET_H * 3600_000); // sang giờ VN
  const firstOfNextMonthVN = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return firstOfNextMonthVN - RESET_TZ_OFFSET_H * 3600_000 + 3600_000; // về UTC + buffer
}

export class Pool {
  accounts = new Map<string, PoolAccount>(); // khoá = `${provider}:${email}`

  /** Thêm/cập nhật account (giữ nguyên state cũ nếu đã tồn tại). */
  upsert(i: UpsertInput): PoolAccount {
    const key = poolKey(i.provider, i.email);
    const cur = this.accounts.get(key);
    if (cur) {
      cur.refreshToken = i.refreshToken;
      cur.credential = i.credential;
      cur.proxyLabel = i.proxyLabel;
      /**
       * KHÔNG ghi đè `health` bằng `'unknown'`.
       *
       * `syncFromStore()` chạy mỗi 2 giây và truyền `c.health || 'unknown'` từ
       * credentials.csv. Bản trước gán vô điều kiện, nên kết quả kiểm account vừa ghi
       * vào RAM (`health='alive'`, `liveStatus='ok'`) bị xoá ngay ở lần sync kế tiếp —
       * người dùng bấm "Kiểm tra", thấy xanh vài giây rồi về `unknown`. Trái hẳn với
       * lời hứa "giữ nguyên state cũ" ngay trên đầu hàm này.
       *
       * Store chỉ được phép NÂNG CẤP hiểu biết, không được hạ: 'unknown' nghĩa là
       * "chưa biết", mà RAM đang biết rõ hơn thì giữ lấy cái biết rõ.
       */
      if (i.health && i.health !== 'unknown') cur.health = i.health;
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
  candidates(now = Date.now(), provider?: ProviderId, bucket?: QuotaBucket): PoolAccount[] {
    return this.list(provider).filter(
      (a) => a.enabled && a.health !== 'dead'
        && (a.cooldownUntil || 0) <= now
        && (a.monthlyExhaustedUntil || 0) <= now
        // Cooldown riêng bể: account cạn Claude vẫn phục vụ được model Gemini.
        && (!bucket || (a.bucketCooldown?.[bucket] || 0) <= now),
    );
  }

  /**
   * Chọn account theo strategy + đánh dấu bận (inflight++). Ném NoAccountError nếu hết.
   * CONCURRENCY-AWARE: ưu tiên account đang RẢNH (inflight nhỏ nhất) → khi gọi liên tục,
   * mọi strategy đều tự xoay sang account khác thay vì dồn 1 account. Khi tải thấp thì
   * full-first/failover vẫn "dính" account đầu như thiết kế.
   */
  pick(strategy: Strategy, now = Date.now(), provider?: ProviderId, bucket?: QuotaBucket): PoolAccount {
    const all = this.candidates(now, provider, bucket);
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
      case 'full-first': {
        // ĐÚNG NGHĨA "dùng cạn từng account": chọn account quota THẤP NHẤT mà còn dùng
        // được, để dồn hết một account rồi mới sang cái kế. Trước đây nhánh này dùng
        // chung `c[0]!` với failover — tức lấy phần tử đầu Map, không đọc quota gì cả.
        chosen = [...c].sort((x, y) => {
          const cx = bucketPct(x, bucket);
          const cy = bucketPct(y, bucket);
          // Account chưa biết quota xếp SAU: đừng dồn tải vào cái mình không đo được.
          if (cx == null && cy == null) return (x.lastUsed || 0) - (y.lastUsed || 0);
          if (cx == null) return 1;
          if (cy == null) return -1;
          if (cx !== cy) return cx - cy;
          return (x.lastUsed || 0) - (y.lastUsed || 0);
        })[0]!;
        break;
      }
      case 'smart': {
        // Chấm điểm tổng hợp: quota đúng bể + tỉ lệ lỗi + độ trễ + tải hiện tại.
        const maxIn = Math.max(1, ...all.map((a) => a.inflight));
        chosen = [...c].sort((x, y) => {
          const d = scoreAccount(y, bucket, maxIn) - scoreAccount(x, bucket, maxIn);
          // Hoà điểm → LRU, để account cùng hạng vẫn được xoay đều.
          return d !== 0 ? d : (x.lastUsed || 0) - (y.lastUsed || 0);
        })[0]!;
        break;
      }
      case 'failover':
      default:
        // Bám một account tới khi nó hỏng: thứ tự Map ổn định nên cùng một account
        // được chọn lại liên tục, chỉ đổi khi nó rơi khỏi candidates().
        chosen = c[0]!;
    }
    chosen.inflight++;
    return chosen;
  }

  /**
   * Tra account từ object hoặc KHOÁ GHÉP `provider:email`.
   *
   * Cảnh báo khi truyền chuỗi không tra được: trước đây `release`/`report` im lặng
   * `return` khi Map.get() trượt, nên bug "truyền email trần" sống sót rất lâu —
   * /api/gateway/chat rò 1 inflight VĨNH VIỄN mỗi lượt, và vì pick() ưu tiên
   * minInflight nên account đó dần bị pool né tránh.
   */
  private resolve(a: PoolAccount | string, who: string): PoolAccount | undefined {
    if (typeof a !== 'string') return a;
    const acc = this.accounts.get(a);
    if (!acc) {
      console.warn(
        `[pool] ${who}: không tìm thấy "${a}"` +
          (a.includes(':') ? '' : ' — thiếu prefix provider, khoá phải là `provider:email`'),
      );
    }
    return acc;
  }

  /** Giải phóng account sau khi request xong (inflight--). Nhận account hoặc khoá ghép. */
  release(a: PoolAccount | string): void {
    const acc = this.resolve(a, 'release');
    if (acc && acc.inflight > 0) acc.inflight--;
  }

  /**
   * Cập nhật counters + cooldown sau 1 request.
   * Nhận OBJECT account (email không còn định danh duy nhất khi có 2 provider).
   */
  report(a: PoolAccount | string, info: ReportInfo, now = Date.now()): void {
    const acc = this.resolve(a, 'report');
    if (!acc) return;
    acc.requests++;
    acc.tokensIn += info.promptTokens ?? 0;
    acc.tokensOut += info.completionTokens ?? 0;
    // `lastAttempt` ghi MỌI lần gọi (kể cả lỗi) để debug; `lastUsed` chỉ ghi khi THÀNH CÔNG
    // vì round-robin là LRU theo lastUsed — nếu lỗi cũng cập nhật thì account hỏng liên tục
    // vẫn được đối xử y hệt account tốt và cứ thế quay lại đầu hàng đợi.
    acc.lastAttempt = now;
    recordOutcome(acc, !!info.ok, info.latencyMs);
    if (info.ok) {
      acc.lastUsed = now;
      acc.lastError = '';
      acc.consecutiveFails = 0;
      return;
    }

    acc.lastError = info.err ?? `HTTP ${info.status ?? '?'}`;
    acc.consecutiveFails = (acc.consecutiveFails ?? 0) + 1;

    // Token bị thu hồi / hết hiệu lực → account vô dụng cho tới khi người dùng cấp lại.
    // Trước đây 401/403 không được nhận biết nên account cứ nằm mãi trong candidates().
    if (isPermanentAuthError(info.err ?? '', info.status)) {
      acc.health = 'dead';
      return;
    }

    // 402 = Kiro hết hạn mức THÁNG; 429 = rate limit / quota Antigravity
    const monthly = info.status === 402 || /MONTHLY_REQUEST_COUNT/i.test(info.err ?? '');
    const quota = monthly || info.status === 429 || /quota|exhaust|resource_exhausted/i.test(info.err ?? '');

    if (monthly) {
      // Hết hạn mức THÁNG → sleep đến đầu tháng kế (thay vì 12h rồi lặp lại vô ích).
      acc.monthlyExhaustedUntil = nextMonthResetMs(now);
      acc.cooldownUntil = acc.monthlyExhaustedUntil;
      acc.liveStatus = 'quota';
      return;
    }

    if (quota) {
      let ms = config.gateway.cooldownSec * 1000;
      const ra = info.retryAfterMs;
      if (ra != null && ra > 0) {
        const LONG = 3600_000; // >1h ⇒ hết hạn mức, không phải rate-limit
        ms = ra > LONG ? LONG : Math.min(Math.max(ra, 5_000), ms);
      }
      acc.liveStatus = 'quota';
      if (info.bucket) {
        // Biết bể → chỉ khoá đúng bể đó. Account còn quota bể kia vẫn phục vụ được.
        acc.bucketCooldown = { ...acc.bucketCooldown, [info.bucket]: now + ms };
      } else {
        // Không biết bể (Kiro không chia bể, hoặc model lạ) → khoá toàn cục như cũ.
        acc.cooldownUntil = now + ms;
      }
      return;
    }

    // Lỗi hạ tầng (5xx, timeout, mạng): TRƯỚC ĐÂY không cooldown gì cả, nên account đang
    // hỏng được pick lại ngay ở request kế — `skipKeys` chỉ chặn trong phạm vi 1 request.
    // Cooldown ngắn hơn nhiều so với quota vì lỗi loại này thường thoáng qua.
    if (isTransientError(info.err ?? '', info.status)) {
      const base = config.gateway.cooldown5xxSec * 1000;
      acc.cooldownUntil = now + Math.min(base * 2 ** Math.min(acc.consecutiveFails - 1, 4), 300_000);
      acc.liveStatus = 'error';
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
        lastAttempt: a.lastAttempt || 0,
        // Kết quả kiểm phải sống qua restart: bản trước chỉ giữ `liveStatus` mà không
        // giữ thời điểm, nên sau khởi động lại UI hiện "alive" không rõ từ bao giờ.
        lastCheckAt: a.lastCheckAt || 0,
        health: a.health,
        consecutiveFails: a.consecutiveFails || 0,
        bucketCooldown: a.bucketCooldown,
        // Access token: KHÔNG persist thì mỗi lần restart mất sạch token của 700 account,
        // và tải dồn sau đó gây hàng trăm lần refresh cùng lúc — đúng kiểu 429 hàng loạt.
        token: a.token,
        // Số liệu chấm điểm cho chiến lược `smart`. Trước đây CHỈ nằm trong RAM nên mỗi
        // lần restart pool mất sạch "account nào hay lỗi, account nào chậm" — phải học
        // lại từ đầu bằng chính traffic thật của người dùng. Persist kèm mốc thời gian
        // để applyPersist tự bỏ khi đã quá cũ (xem SCORE_STALE_MS).
        recentFails: a.recentFails || 0,
        recentCount: a.recentCount || 0,
        latencyEwmaMs: a.latencyEwmaMs,
        scoreAt: a.lastAttempt || 0,
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
      a.lastAttempt = s.lastAttempt ?? a.lastAttempt;
      a.consecutiveFails = s.consecutiveFails ?? a.consecutiveFails;
      // Token chỉ khôi phục khi CÒN HẠN (trừ skew) — token hết hạn thì để ensureReady lo.
      if (s.token?.accessToken && s.token.expiresAt - REFRESH_SKEW_MS > Date.now() && !a.token) {
        a.token = s.token;
      }
      // chỉ khôi phục cooldown bể còn hiệu lực
      if (s.bucketCooldown) {
        const live: Record<string, number> = {};
        for (const [k, v] of Object.entries(s.bucketCooldown as Record<string, number>)) {
          if (v > Date.now()) live[k] = v;
        }
        if (Object.keys(live).length) a.bucketCooldown = live as any;
      }
      // Số liệu chấm điểm chỉ dùng lại khi CÒN MỚI. Lịch sử lỗi của 6 tiếng trước không
      // nói gì về upstream lúc này (có thể đã hồi phục), nhưng vứt hết cũng phí — restart
      // vài phút thì dữ liệu vẫn đúng. 30 phút là mốc dung hoà.
      const scoreAge = Date.now() - ((s as any).scoreAt ?? 0);
      if ((s as any).scoreAt && scoreAge < SCORE_STALE_MS) {
        a.recentFails = s.recentFails ?? a.recentFails;
        a.recentCount = s.recentCount ?? a.recentCount;
        a.latencyEwmaMs = s.latencyEwmaMs ?? a.latencyEwmaMs;
      }
      if (s.quota && !a.quota) a.quota = s.quota; // giữ quota qua restart (TTL tự lo refresh)
      if (s.projectId && !a.projectId) a.projectId = s.projectId; // bỏ discoverProject sau restart
      /**
       * Kết quả KIỂM account phải sống qua restart, kèm thời điểm.
       *
       * Bản trước persist `liveStatus` nhưng KHÔNG khôi phục lại, và không lưu mốc thời
       * gian nào — nên sau mỗi lần khởi động, công sức kiểm cả pool (~1.2 giây/account,
       * 700 account ≈ 14 phút) mất sạch, UI về "unknown" hết.
       *
       * `health` chỉ nhận khi persist biết rõ hơn RAM: 'unknown' nghĩa là "chưa biết",
       * ghi đè bằng nó là hạ cấp hiểu biết.
       */
      a.lastCheckAt = (s as any).lastCheckAt || a.lastCheckAt;
      if (s.liveStatus && !a.liveStatus) a.liveStatus = s.liveStatus;
      if ((s as any).health && (s as any).health !== 'unknown' && a.health === 'unknown') {
        a.health = (s as any).health;
      }
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
    // 0600: file chứa access token của toàn bộ pool — user khác trên máy không được đọc.
    // chmod cả tmp vì `mode` chỉ áp dụng khi tạo mới (tmp sót từ lần crash giữ mode cũ).
    writeFileSync(tmp, JSON.stringify(pool.toPersist(), null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* fs không hỗ trợ chmod → bỏ qua */ }
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

// ---------------------------------------------------------------------------
// Concurrency limiter cho stream requests — giảm 429 khi nhiều request song song
// ---------------------------------------------------------------------------

export class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number = 6) {}

  /** Chờ slot trống rồi chiếm. Trả về hàm release() phải gọi khi xong. */
  acquire(): Promise<() => void> {
    const release = () => {
      this.running--;
      const next = this.queue.shift();
      if (next) {
        this.running++;
        next();
      }
    };
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve(release);
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(release));
    });
  }
}

export const streamLimiter = new ConcurrencyLimiter(
  Number(process.env.AGY_STREAM_CONCURRENCY) || 6,
);
