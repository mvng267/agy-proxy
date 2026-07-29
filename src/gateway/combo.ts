import { PROVIDERS, PROVIDER_IDS, parseModelId, type ParsedModel, type ProviderId } from './providers/index.js';

/**
 * Combo: gọi 1 id duy nhất, gateway tự trượt sang model kế khi hết hạn mức/lỗi.
 * Phần chọn đường (planCombo/scoreCandidates/shouldFallback) là HÀM THUẦN → test được
 * mà không cần mạng. Phần chạy thật nằm ở routes.ts (runComboRequest).
 *
 * Giới hạn có chủ đích (giống OmniRoute): khi stream đã gửi byte đầu tiên mà lỗi thì
 * KHÔNG phát lại được — chỉ fallback khi lỗi xảy ra TRƯỚC chunk đầu.
 */

export type ComboStrategy = 'priority' | 'round-robin' | 'weighted' | 'highest-quota';

export interface ComboTarget {
  model: string; // id CÓ prefix, vd 'agy/gemini-3-pro-low'
  weight?: number;
}

export interface Combo {
  id: string;
  name: string;
  strategy: ComboStrategy;
  targets: ComboTarget[];
  enabled: boolean;
  maxSteps?: number;
}

/** Ảnh chụp tình trạng pool cho 1 provider — dữ liệu THẬT ta có. */
export interface ProviderSnapshot {
  provider: ProviderId;
  available: number; // account dùng được ngay
  total: number;
  quotaAvg: number | null; // %, null nếu provider không có API quota (Kiro)
  p95Ms: number | null; // độ trễ p95 24h
  successRate: number | null; // 0..1 trong 24h
  inflight: number;
}
export type PoolSnapshot = Record<string, ProviderSnapshot>;

export interface AutoWeights {
  health: number;
  quota: number;
  latency: number;
  success: number;
  load: number;
}

/**
 * Biến thể `auto`. CHỈ dùng yếu tố ta thật sự đo được — không có cost/taskFit
 * vì mọi account đều free và ta không có bảng giá; bịa ra sẽ cho ảo giác chính xác.
 */
export const AUTO_VARIANTS: Record<string, AutoWeights> = {
  default: { health: 0.30, quota: 0.25, latency: 0.20, success: 0.15, load: 0.10 },
  fast: { health: 0.20, quota: 0.15, latency: 0.45, success: 0.10, load: 0.10 },
  quota: { health: 0.20, quota: 0.45, latency: 0.10, success: 0.15, load: 0.10 },
  stable: { health: 0.20, quota: 0.15, latency: 0.15, success: 0.40, load: 0.10 },
};
export const AUTO_VARIANT_IDS = ['auto', 'auto/fast', 'auto/quota', 'auto/stable'];

export interface Scored {
  model: string; // id có prefix
  provider: ProviderId;
  score: number;
  detail: Record<string, number>;
}

function norm(v: number | null, fallback = 0.5): number {
  if (v == null || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

/**
 * THUẦN: chấm điểm mọi model khả dụng để dựng chuỗi `auto`.
 * Điểm cao đứng trước. Provider không còn account nào → điểm 0 (vẫn liệt kê cuối).
 */
export function scoreCandidates(snap: PoolSnapshot, weights: AutoWeights): Scored[] {
  const out: Scored[] = [];
  // p95 lớn nhất để chuẩn hoá độ trễ về 0..1
  const maxP95 = Math.max(1, ...PROVIDER_IDS.map((p) => snap[p]?.p95Ms ?? 0));
  for (const pid of PROVIDER_IDS) {
    const s = snap[pid];
    if (!s) continue;
    const health = s.total > 0 ? s.available / s.total : 0;
    // Kiro không có API quota → dùng 'available' làm proxy (đã phản ánh cooldown vì hết hạn mức)
    const quota = s.quotaAvg == null ? health : norm(s.quotaAvg / 100);
    const latency = s.p95Ms == null ? 0.5 : 1 - norm(s.p95Ms / maxP95);
    const success = norm(s.successRate, 0.8);
    const load = s.available > 0 ? 1 - norm(s.inflight / Math.max(1, s.available)) : 0;
    const score =
      weights.health * health +
      weights.quota * quota +
      weights.latency * latency +
      weights.success * success +
      weights.load * load;
    for (const m of PROVIDERS[pid].models) {
      out.push({
        model: `${pid}/${m.id}`,
        provider: pid,
        score: s.available > 0 ? score : 0,
        detail: { health, quota, latency, success, load },
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Chuỗi thử cho `auto`: mỗi provider lấy model mặc định, xếp theo điểm. */
export function planAuto(variant: string, snap: PoolSnapshot): ComboTarget[] {
  const w = AUTO_VARIANTS[variant] || AUTO_VARIANTS.default!;
  const scored = scoreCandidates(snap, w);
  const seen = new Set<ProviderId>();
  const out: ComboTarget[] = [];
  for (const s of scored) {
    if (seen.has(s.provider)) continue;
    // model mặc định của provider đứng trước
    const def = `${s.provider}/${PROVIDERS[s.provider].defaultModel}`;
    out.push({ model: def });
    seen.add(s.provider);
  }
  return out;
}

let rrCursor = 0;
/** THUẦN (trừ con trỏ round-robin): xếp thứ tự thử cho 1 request. */
export function planCombo(c: Combo, snap: PoolSnapshot, now = Date.now()): ComboTarget[] {
  const targets = (c.targets || []).filter((t) => t && t.model);
  if (!targets.length) return [];
  switch (c.strategy) {
    case 'round-robin': {
      const i = rrCursor++ % targets.length;
      return [...targets.slice(i), ...targets.slice(0, i)];
    }
    case 'weighted': {
      // sắp xếp ngẫu nhiên có trọng số: weight cao → khả năng đứng đầu cao
      const pool = targets.map((t) => ({ t, k: Math.random() / Math.max(0.001, t.weight ?? 1) }));
      return pool.sort((a, b) => a.k - b.k).map((x) => x.t);
    }
    case 'highest-quota': {
      const q = (m: string) => {
        try {
          const p = parseModelId(m);
          const s = p.provider ? snap[p.provider] : undefined;
          if (!s) return -1;
          return s.quotaAvg == null ? (s.total ? (s.available / s.total) * 100 : -1) : s.quotaAvg;
        } catch {
          return -1;
        }
      };
      return [...targets].sort((a, b) => q(b.model) - q(a.model));
    }
    case 'priority':
    default:
      return targets;
  }
}

/** Có nên trượt sang model kế không? 4xx do người dùng thì KHÔNG (tránh tốn quota vô ích). */
export function shouldFallback(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string; name?: string } | undefined;
  if (!e) return false;
  const status = e.status ?? e.code;
  const msg = String(e.message ?? '');
  // 400 vì VƯỢT NGỮ CẢNH của model → không phải lỗi người dùng, mà là model này quá nhỏ.
  // Trượt sang model kế (vd Kiro ~100k → Antigravity 1M) thay vì trả lỗi.
  if (isContextTooLong(e)) return true;
  if (status === 400 || status === 401 || status === 403) return false;
  if (status === 402 || status === 429) return true; // hết hạn mức
  if (typeof status === 'number' && status >= 500) return true;
  return /timeout|aborted|ECONN|fetch failed|socket|quota|exhaust|MONTHLY_REQUEST_COUNT|khả dụng/i.test(msg);
}

/** Lỗi "đầu vào quá dài" của các provider (Kiro/Bedrock/Gemini) — dùng để trượt combo. */
export function isContextTooLong(err: unknown): boolean {
  const e = err as { message?: string } | undefined;
  return /CONTENT_LENGTH_EXCEEDS_THRESHOLD|Input is too long|length limit exceeded|context length|too many tokens|exceeds the maximum/i.test(
    String(e?.message ?? ''),
  );
}

/** Chặn combo trỏ vòng vào chính nó / vào combo khác. */
export function validateTargets(targets: ComboTarget[]): { ok: true } | { ok: false; error: string } {
  if (!targets?.length) return { ok: false, error: 'Combo phải có ít nhất 1 model' };
  for (const t of targets) {
    let p: ParsedModel;
    try {
      p = parseModelId(t.model);
    } catch (e: any) {
      return { ok: false, error: `Model "${t.model}" không hợp lệ: ${e.message}` };
    }
    if (p.kind !== 'provider') {
      return { ok: false, error: `Combo chỉ được trỏ tới model thật (agy/… hoặc kr/…), không được trỏ tới "${t.model}"` };
    }
    const known = PROVIDERS[p.provider!].models.some((m) => m.id === p.model);
    if (!known) return { ok: false, error: `Model "${t.model}" không có trong provider ${p.provider}` };
  }
  return { ok: true };
}
