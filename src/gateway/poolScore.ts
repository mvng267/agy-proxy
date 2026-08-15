import type { ProviderAccount, ProviderId, ProviderSession } from './providers/index.js';
import type { QuotaInfo, QuotaBucket, TokenInfo } from './antigravity.js';

/**
 * Kiểu và hàm THUẦN TUÝ của pool — tách khỏi `pool.ts` (824 dòng).
 *
 * Mọi thứ ở đây chỉ nhận vào một `PoolAccount` và trả ra số hoặc boolean: không đụng
 * state module, không gọi mạng, không đọc config. Đó là lý do tách được an toàn, khác
 * hẳn phần còn lại của `pool.ts` (singleton `pool`, timer lưu file, con trỏ xoay vòng)
 * — chia đôi trạng thái đang chạy giữa hai file là chuốc lấy bug.
 *
 * Đây cũng là phần được TEST DÀY NHẤT (score.test.ts 31 chỗ dùng, pool.test.ts 19,
 * autodisable 11, dead-403 9), và mỗi hàm dưới đây gắn với một sự cố production thật:
 *
 *   `geminiPct`/`claudePct`  hai bể ĐỘC LẬP — dùng `??` giữa chúng đã tắt oan 233 account
 *   `isPermanentAuthError`   403 kèm trang HTML từng giết 331 account Kiro
 *   `scoreAccount`           chấm điểm sai làm rotation thử 20 account rồi vẫn hỏng
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

export function blankAccount(i: UpsertInput): PoolAccount {
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

  /**
   * 403 kèm TRANG HTML = bị chặn ở tầng mạng (WAF/CDN/rate-limit biên), KHÔNG phải token
   * bị thu hồi. API thật luôn trả JSON; nhận được `<!DOCTYPE html>` nghĩa là request chưa
   * tới được API.
   *
   * Đo thật trên production: 331/351 account Kiro bị đánh `dead`, trong đó 313 cái vẫn
   * có `liveStatus='ok'` — mâu thuẫn hiển nhiên. Gọi thử một cái (`thehien120`) thì nó
   * trả lời trong 1 giây. Chúng chết oan vì một đợt `Kiro refresh 403: <!DOCTYPE HTML…`,
   * và `dead` là trạng thái VĨNH VIỄN — chỉ người kiểm thủ công mới gỡ được.
   *
   * Cái giá của hai loại nhầm lẫn không đối xứng: coi nhầm account chết là còn sống chỉ
   * tốn thêm một lượt thử; coi nhầm account sống là chết thì mất nó khỏi pool mãi mãi.
   */
  if (status === 403 && /<!DOCTYPE|<html|<HTML/i.test(msg)) return false;

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

/**
 * Có nên cho phép nhịp sync này xoá bớt account khỏi pool không?
 *
 * `syncFromStore` xoá mọi account không có trong CSV. Nhưng `readCsvFile` trả mảng RỖNG khi
 * file không tồn tại — không phân biệt "rỗng thật" với "không đọc được". Một lần đọc hụt là
 * 703 account biến khỏi pool trong 2 giây, rồi `flushPersist()` ghi đè `gateway.json` (1,8 MB
 * state: quota, cooldown, projectId, token) bằng pool rỗng. Mất kép, không có đường lùi.
 *
 * Xoá account là việc bình thường nên không chặn hẳn được; chỉ chặn cái gần như chắc chắn là
 * lỗi đọc: mất SẠCH, hoặc mất quá nửa một pool đủ lớn, trong một nhịp.
 */
export const XOA_AN_TOAN_MIN = 10; // pool nhỏ hơn thì không áp ngưỡng %

export function xoaAnToan(dangGiu: number, sapCon: number): { choPhep: boolean; lyDo?: string } {
  // Pool rỗng (lúc boot) thì không có gì để mất.
  if (dangGiu === 0) return { choPhep: true };

  if (sapCon === 0) {
    return { choPhep: false, lyDo: `nguồn account rỗng trong khi pool đang giữ ${dangGiu} — nghi đọc hụt` };
  }
  // Pool nhỏ: xoá 1/2 account là thao tác tay bình thường, ngưỡng % vô nghĩa.
  if (dangGiu < XOA_AN_TOAN_MIN) return { choPhep: true };

  if (sapCon * 2 < dangGiu) {
    return { choPhep: false, lyDo: `nguồn chỉ còn ${sapCon}/${dangGiu} account (mất quá nửa) — nghi đọc hụt` };
  }
  return { choPhep: true };
}

/**
 * Xác định danh sách account cho thao tác hàng loạt.
 *
 * `POST /api/gateway/accounts/bulk` trước đây ngầm hiểu "không truyền emails = cả pool".
 * Body rỗng `{}` khiến `enabled` là `undefined`, `!!undefined` = `false` → TẮT toàn bộ 703
 * account, không xác nhận, không ghi ai làm.
 *
 * Frontend có dùng dạng "cả pool" một cách cố ý, nên không bỏ được tính năng — chỉ bắt nói
 * rõ ý định bằng cờ `all`.
 */
export function mucTieuBulk(
  emails: string[] | undefined,
  all: boolean,
  caPool: string[],
): { keys: string[]; loi?: string } {
  if (emails?.length) return { keys: emails };
  if (all) return { keys: caPool };
  return { keys: [], loi: 'thiếu `emails`; muốn áp cho cả pool thì gửi `all: true`' };
}

/**
 * Độ tươi của dữ liệu quota trong pool.
 *
 * Vì sao cần đo: sự cố 12/08/2026 ẩn được 28 giờ vì dashboard hiện SỐ quota nhưng không hiện
 * nó được đo KHI NÀO. Vòng refresh chết im lặng, engine tiếp tục chọn account bằng số cũ, và
 * không có tín hiệu nào cho tới khi soi tay vào `gateway.json`.
 *
 * Dùng TRUNG VỊ chứ không phải trung bình: một account vừa refresh tay sẽ kéo trung bình
 * xuống và che mất việc 700 cái còn lại đều cũ.
 */
export function tuoiQuota(
  list: Array<{ quota?: { fetchedAt?: number } }>,
  now = Date.now(),
): { moiNhatMin: number | null; cuNhatMin: number | null; trungViMin: number | null; coQuota: number; tong: number } {
  const tuoi: number[] = [];
  for (const a of list) {
    const t = a.quota?.fetchedAt;
    // Chưa đo lần nào ≠ đo rất lâu rồi. Account mới thêm không được kéo "cũ nhất" lên trời.
    if (typeof t === 'number' && t > 0) tuoi.push(Math.max(0, Math.round((now - t) / 60_000)));
  }
  if (!tuoi.length) {
    return { moiNhatMin: null, cuNhatMin: null, trungViMin: null, coQuota: 0, tong: list.length };
  }
  tuoi.sort((x, y) => x - y);
  return {
    moiNhatMin: tuoi[0]!,
    cuNhatMin: tuoi[tuoi.length - 1]!,
    trungViMin: tuoi[Math.floor(tuoi.length / 2)]!,
    coQuota: tuoi.length,
    tong: list.length,
  };
}

/**
 * Vòng quét này có đang giết account HÀNG LOẠT không?
 *
 * `dead` là vĩnh viễn và không tự hồi, nên đánh nhầm hàng loạt là mất pool. Đo trên
 * production 15/08/2026: 457/703 account bị đánh chết, trong đó **272 cái có
 * `liveStatus='ok'`** — gọi model thật thành công — và 6/6 mẫu thử refresh đều sống.
 * Chúng chết theo cụm: 153 cái trong 6 phút, 62 cái trong 2 phút.
 *
 * 153 token không tự dưng cùng hỏng trong 6 phút. Đó là rate-limit hoặc upstream chập —
 * lỗi của MÔI TRƯỜNG, không phải của token. Vượt trần thì dừng đánh chết và cho cooldown.
 *
 * Ngưỡng 10%: đủ rộng để token hỏng lẻ tẻ (chuyện thật) đi qua, đủ chặt để một sự cố quét
 * cả pool bị chặn ngay từ đầu.
 */
export const NGUONG_CHET_HANG_LOAT = 0.1;
/** Pool nhỏ hơn mức này thì tỉ lệ phần trăm vô nghĩa — 2/3 account chết là bình thường. */
export const CHET_HANG_LOAT_MIN = 20;

export function chetHangLoat(v: { daChet: number; tong: number }): boolean {
  const { daChet, tong } = v;
  if (tong < CHET_HANG_LOAT_MIN) return false;
  return daChet > Math.floor(NGUONG_CHET_HANG_LOAT * tong);
}
