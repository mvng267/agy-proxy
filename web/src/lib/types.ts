/**
 * Kiểu dữ liệu API dùng chung.
 * Trước đây `PoolAccount` được khai báo 2 lần (Pool.tsx, Quota.tsx) và `Model` 3 lần,
 * nên chúng đã lệch nhau — mỗi trang chỉ khai báo phần nó dùng.
 */

export interface QuotaGroup {
  name: string;
  pct: number;
  resetTime?: string;
  desc?: string;
}

export interface QuotaInfo {
  tier?: string | null;
  groups?: QuotaGroup[];
  models?: Array<{ id: string; pct: number }>;
  fetchedAt?: number;
}

export interface PoolAccount {
  key: string;
  email: string;
  provider: string;
  providerLabel?: string;
  enabled: boolean;
  health?: string;
  liveStatus?: string;

  requests: number;
  tokensIn: number;
  tokensOut: number;
  lastUsed?: number;

  cooldown: boolean;
  cooldownUntil?: number;
  monthlyExhaustedUntil?: number;
  lastError?: string;

  /** Số request ĐANG chạy trên account (thêm ở G4 — nguồn cho cột "đang bận"). */
  inflight?: number;
  lastAttempt?: number;
  consecutiveFails?: number;

  geminiPct?: number | null;
  claudePct?: number | null;
  quota?: QuotaInfo | null;
  /** Thời điểm cập nhật quota gần nhất + đã quá TTL chưa (G4). */
  quotaFetchedAt?: number;
  quotaStale?: boolean;
  /** Cooldown RIÊNG từng bể quota — account cạn Claude vẫn phục vụ được Gemini (G4). */
  bucketCooldown?: Partial<Record<'gemini' | 'claude', number>> | null;

  creditsUsed?: number;
  creditsLimit?: number;
  proxyLabel?: string;
}

export interface Model {
  id: string;
  bare?: string;
  label: string;
  provider: string;
  /** Nhãn hiển thị của provider ('Antigravity', 'Kiro'…) — dùng gom nhóm trong dropdown. */
  providerLabel?: string;
  /** 'combo' = nhiều bước; 'model' = model đơn. Backend gộp combo vào /api/gateway/models. */
  kind?: 'model' | 'combo' | 'auto';
  /** Các bước của combo — chỉ có khi kind='combo'. */
  steps?: string[];
  image?: boolean;
  bucket?: 'gemini' | 'claude';
  status?: 'ok' | 'quota' | 'error' | 'unknown';
  ms?: number;
}

export interface ComboTarget {
  model: string;
  weight?: number;
}

export interface Combo {
  id: string;
  name: string;
  strategy: string;
  targets: ComboTarget[];
  enabled: boolean;
  calls?: number;
  fallbacks?: number;
}

/** API key — server KHÔNG BAO GIỜ trả `key` thô ở đây (chỉ một lần lúc tạo). */
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: number;
  lastUsed?: number | null;
  note?: string | null;
}

export interface UsageTotals {
  requests: number;
  tokIn: number;
  tokOut: number;
  accounts: number;
}

/**
 * Một hàng tổng hợp usage. `errors`/`avgMs` có ở mọi bảng; `p50`/`p95` chỉ có ở
 * byModel và byAccount (tính riêng, tốn thêm một truy vấn nên không rải khắp nơi).
 */
export interface UsageAgg {
  requests: number;
  tokIn: number;
  tokOut: number;
  errors: number;
  /** Độ trễ trung bình của request THÀNH CÔNG — request lỗi trả rất nhanh, gộp vào sẽ méo. */
  avgMs: number;
  p50?: number;
  p95?: number;
}

export interface UsageResponse {
  totals: UsageTotals;
  series: Array<UsageAgg & { bucket: string }>;
  byModel: Array<UsageAgg & { model: string }>;
  byAccount: Array<UsageAgg & { email: string }>;
  byApiKey?: Array<UsageAgg & { apiKeyId: string; name?: string }>;
  byCombo?: Array<UsageAgg & { combo: string }>;
}
