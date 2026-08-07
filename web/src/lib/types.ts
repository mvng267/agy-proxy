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

export interface UsageResponse {
  totals: UsageTotals;
  series: Array<{ bucket: string; requests: number; tokIn: number; tokOut: number }>;
  byModel: Array<{ model: string; requests: number; tokIn: number; tokOut: number }>;
  byAccount: Array<{ email: string; requests: number; tokIn: number; tokOut: number }>;
  byApiKey?: Array<{ apiKeyId: string; requests: number; tokIn: number; tokOut: number }>;
  byCombo?: Array<{ combo: string; requests: number; tokIn: number; tokOut: number }>;
}
