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

/**
 * Tỉ lệ thành công theo TỪNG MODEL (`agy/gemini-3-pro-high` → 0..1).
 *
 * Truyền vào thay vì import store — file này không được import store/pool (chống vòng lặp
 * module). Thiếu thì mọi model coi như bình thường, hành vi y hệt bản cũ.
 */
export type ModelHealth = Map<string, { n: number; okRate: number }>;

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
/**
 * Model tier: ảnh hưởng latency score — model nhẹ (flash) nhanh hơn model nặng (pro-high).
 * Dùng trong scoreCandidates để phân biệt per-model thay vì per-provider.
 */
function modelTier(id: string): number {
  if (/flash|lite|mini/i.test(id)) return 1.0;  // nhẹ → bonus latency
  if (/pro-low|haiku/i.test(id)) return 0.8;
  if (/pro(?!-)|\bsonnet/i.test(id)) return 0.5;
  if (/pro-high|opus|ultra/i.test(id)) return 0.3;  // nặng → penalty latency
  return 0.5;
}

export function scoreCandidates(snap: PoolSnapshot, weights: AutoWeights, mh?: ModelHealth): Scored[] {
  const out: Scored[] = [];
  // p95 lớn nhất để chuẩn hoá độ trễ về 0..1
  const maxP95 = Math.max(1, ...PROVIDER_IDS.map((p) => snap[p]?.p95Ms ?? 0));
  for (const pid of PROVIDER_IDS) {
    const s = snap[pid];
    if (!s) continue;
    const health = s.total > 0 ? s.available / s.total : 0;
    // Kiro không có API quota → dùng 'available' làm proxy (đã phản ánh cooldown vì hết hạn mức)
    const quota = s.quotaAvg == null ? health : norm(s.quotaAvg / 100);
    const baseLatency = s.p95Ms == null ? 0.5 : 1 - norm(s.p95Ms / maxP95);
    const success = norm(s.successRate, 0.8);
    const load = s.available > 0 ? 1 - norm(s.inflight / Math.max(1, s.available)) : 0;
    for (const m of PROVIDERS[pid].models) {
      // Per-model latency: model nhẹ (flash) bonus, nặng (opus) penalty
      const tier = modelTier(m.id);
      const latency = norm(baseLatency * 0.6 + tier * 0.4);
      /**
       * Ưu tiên tỉ lệ thành công của CHÍNH MODEL này, không phải của cả provider.
       *
       * Đo trên production 12/08/2026: provider `agy` khoẻ, nhưng trong đó
       * `gemini-3-pro-high` lỗi 97% và `gemini-3.6-flash-high` lỗi 93%, còn
       * `gemini-3.5-flash-low` chỉ 1%. Chấm theo provider thì cả ba cùng điểm, và `auto`
       * xếp model 97%-lỗi lên bước 4 — mỗi lần trúng là một vòng chờ vô ích.
       */
      const mstat = mh?.get(`${pid}/${m.id}`);
      const successM = mstat ? mstat.okRate : success;
      const score =
        weights.health * health +
        weights.quota * quota +
        weights.latency * latency +
        weights.success * successM +
        weights.load * load;
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

/** Chuỗi thử cho `auto`: top models xếp theo điểm, đa dạng provider + model tier. */
export function planAuto(variant: string, snap: PoolSnapshot, mh?: ModelHealth): ComboTarget[] {
  const w = AUTO_VARIANTS[variant] || AUTO_VARIANTS.default!;
  const scored = scoreCandidates(snap, w, mh);
  // Lấy tối đa 2 model mỗi provider (đa dạng tier: 1 nhanh + 1 mạnh)
  const count = new Map<ProviderId, number>();
  const out: ComboTarget[] = [];
  for (const s of scored) {
    // Provider chưa cấu hình account nào (vd or/ mới thêm) → bỏ hẳn khỏi chuỗi thử.
    // Khác available=0 (cạn tạm thời, vẫn xếp cuối làm dự phòng khi cooldown hết).
    if ((snap[s.provider]?.total ?? 0) === 0) continue;
    const n = count.get(s.provider) ?? 0;
    if (n >= 2) continue;
    out.push({ model: s.model });
    count.set(s.provider, n + 1);
  }
  return out;
}

let rrCursor = 0;
/** Reset/set cursor — cho phép restore từ persistent store khi boot. */
export function setRrCursor(v: number): void { rrCursor = v; }
export function getRrCursor(): number { return rrCursor; }
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
  // 400 vì MODEL NÀY không tương thích → model kế có thể chạy được, phải trượt.
  if (isModelIncompatible(e)) return true;
  if (status === 400 || status === 401 || status === 403) return false;
  if (status === 402 || status === 429) return true; // hết hạn mức
  if (typeof status === 'number' && status >= 500) return true;
  return /timeout|aborted|ECONN|fetch failed|socket|quota|exhaust|MONTHLY_REQUEST_COUNT|khả dụng/i.test(msg);
}

/**
 * Hết hạn mức của MODEL (không phải của account).
 *
 * Phân biệt này quan trọng vì hai loại 429 cần xử lý ngược nhau:
 *   - quota ACCOUNT cạn  → đổi account, model giữ nguyên (đường thường)
 *   - quota MODEL  cạn   → đổi MODEL, đổi account vô ích vì mọi account đụng cùng trần
 *
 * Đo thật trên agy/gemini-2.5-pro: Google trả
 *   "You have exhausted your capacity on this model. Your quota will reset after 4h59m54s."
 * Gateway cũ hiểu nhầm là quota account nên thử 32 account nối tiếp — mất 197 GIÂY rồi
 * vẫn 429, trong khi câu trả lời đã có từ account đầu tiên.
 */
export function isModelQuotaError(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string } | undefined;
  if (!e) return false;
  const status = e.status ?? e.code;
  if (status !== 429) return false;
  // "capacity on this model" là dấu hiệu riêng của trần THEO MODEL; quota account thì
  // Google nói "quota exceeded"/"RESOURCE_EXHAUSTED" chung chung, không nhắc "this model".
  return /capacity on this model|quota.{0,40}\bthis model\b|per-model quota/i.test(String(e.message ?? ''));
}

/** Lỗi "đầu vào quá dài" của các provider (Kiro/Bedrock/Gemini) — dùng để trượt combo. */
/**
 * 400 vì MODEL NÀY không nhận được request, chứ không phải người dùng gửi sai.
 *
 * Khác biệt quan trọng: 400 do người dùng (prompt hỏng, tham số sai) thì đổi model cũng
 * hỏng y hệt — trượt chỉ tốn quota. Nhưng 400 do năng lực model thì model kế chạy được.
 *
 * Ca đã gặp thật 11/08/2026: `gemini-3.1-flash-image` không có function calling, gặp lịch
 * sử hội thoại chứa tool_use thì trả "Function call is missing a thought_signature".
 * `combo/combo-samlv` có 7 bước, trong đó `kr/claude-sonnet-4.5` thừa sức xử lý — nhưng
 * quy tắc "400 thì không trượt" chặn lại, nên client hỏng hẳn sau 4 lần thử cùng một model.
 */
export function isModelIncompatible(err: unknown): boolean {
  const e = err as { message?: string } | undefined;
  return /thought_signature|function calling is not|does not support (function|tool)|tools are not supported/i.test(
    String(e?.message ?? ''),
  );
}

export function isContextTooLong(err: unknown): boolean {
  const e = err as { message?: string } | undefined;
  // Mỗi upstream một cách diễn đạt:
  //   Kiro/Bedrock : CONTENT_LENGTH_EXCEEDS_THRESHOLD · "Input is too long" · "length limit exceeded"
  //   Anthropic    : "Prompt is too long"  (model Claude qua Antigravity dùng chuỗi này)
  //   Gemini/OpenAI: "context length" · "too many tokens" · "exceeds the maximum"
  return /CONTENT_LENGTH_EXCEEDS_THRESHOLD|(input|prompt|request)\s+is too long|too long for|length limit exceeded|context[_\s-]?length|maximum context|too many tokens|exceeds the maximum/i.test(
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
