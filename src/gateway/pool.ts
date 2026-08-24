import { writeFileSync, readFileSync, renameSync, existsSync, statSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dispatcher } from 'undici';
import { DATA_DIR, config } from '../config.js';
import { store } from '../store/index.js';
import { recordQuota } from '../store/db.js';
import { logger } from '../lib/logger.js';

import { PROVIDERS, providerOfTarget, setRotateHook, type ProviderAccount, type ProviderId, type ProviderSession } from './providers/index.js';
import { proxyDispatcher, type TokenInfo, type QuotaInfo, type QuotaBucket } from './antigravity.js';

/**
 * Pool account ĐA PROVIDER (Antigravity + Kiro) + 4 chiến lược xoay.
 * Logic chọn/đếm/cooldown nằm trong class Pool (thuần, unit-test được, không đụng mạng);
 * phần mạng (token/project) do provider lo, pool chỉ dedupe promise.
 *
 * KHOÁ GHÉP `${provider}:${email}` — bắt buộc vì 147 email Kiro trùng email Antigravity.
 */

/**
 * Kiểu + hàm chấm điểm đã tách sang `poolScore.ts` — chúng THUẦN TUÝ (chỉ nhận account,
 * trả số/boolean), khác hẳn phần còn lại của file này vốn giữ state đang chạy.
 *
 * Re-export để mọi nơi đang `import … from './pool.js'` chạy y nguyên.
 */
export type { Strategy, UpsertInput, PoolAccount, ReportInfo } from './poolScore.js';
// Hằng số chấm điểm — test soi thẳng chúng để khoá lại trọng số.
export { NoAccountError, SCORE_STALE_MS, SCORE_WEIGHTS, RESET_TZ_OFFSET_H, blankAccount } from './poolScore.js';
export {
  poolKey,
  geminiPct,
  claudePct,
  errRate,
  recordOutcome,
  scoreAccount,
  bucketPct,
  isPermanentAuthError,
  isTransientError,
  isModelCapacityError,
  nextMonthResetMs,
} from './poolScore.js';

import {
  poolKey, geminiPct, claudePct, recordOutcome, scoreAccount, bucketPct,
  isPermanentAuthError, isTransientError, isModelCapacityError, nextMonthResetMs, blankAccount,
  NoAccountError, SCORE_STALE_MS, xoaAnToan,
  type Strategy, type UpsertInput, type PoolAccount, type ReportInfo,
} from './poolScore.js';

export class Pool {
  accounts = new Map<string, PoolAccount>(); // khoá = `${provider}:${email}`

  /**
   * Model đang bị upstream từ chối vì HẾT CHỖ → mốc hết nghỉ (epoch ms). Khoá = model đầy đủ.
   *
   * Nằm ở tầng POOL chứ không phải từng account, vì đây là lỗi của model: đổi account không
   * cứu được. Đo trên production — `gemini-2.5-pro` trả 503 "No capacity" 66 lần/2 giờ, pool
   * quét sạch 35 account trong 195 giây rồi vẫn hỏng.
   */
  private modelCooldown = new Map<string, number>();

  /** Số account liên tiếp báo hết chỗ cho một model — đủ ngưỡng mới cho model nghỉ. */
  private modelFails = new Map<string, number>();

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
      /**
       * `dead` trong RAM THẮNG mọi giá trị từ store.
       *
       * Luật "chỉ nâng cấp" ở trên đúng cho `unknown`, nhưng sai khi RAM vừa phát hiện
       * account chết: CSV còn ghi `alive` từ lần kiểm trước, nên `dead` bị xoá sau đúng
       * 2 giây và account chết lại vào pool.
       *
       * Đo thật: `agyproxy4`/`agyproxy16` bị AWS đình chỉ (`403 suspended`), CSV vẫn
       * `health="alive"` → mọi request Kiro đều thử hai cái này trước, hỏng, rồi mới tới
       * account thứ ba. Tốn 540ms mỗi request, vô ích hoàn toàn.
       */
      if (cur.health !== 'dead' && i.health && i.health !== 'unknown') cur.health = i.health;
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

  /**
   * Model có đang nghỉ không. Trả mốc hết nghỉ (ms còn lại) hoặc 0.
   *
   * Gọi TRƯỚC khi chọn account: model đang nghỉ thì trả lỗi ngay thay vì quét cả pool —
   * đó là khác biệt giữa 195 giây và tức thì.
   */
  modelResting(model: string, now = Date.now()): number {
    const den = this.modelCooldown.get(model) ?? 0;
    if (den <= now) {
      if (den) this.modelCooldown.delete(model);
      return 0;
    }
    return den - now;
  }

  /**
   * Ghi nhận một account báo hết chỗ cho model. Đủ NGƯỠNG account liên tiếp thì cho model nghỉ.
   *
   * Ngưỡng 3 chứ không phải 1: một account lẻ có thể hỏng vì lý do riêng (proxy, token), chỉ
   * khi nhiều account liên tiếp cùng báo mới chắc là upstream hết chỗ thật.
   */
  reportModelCapacity(model: string, now = Date.now()): void {
    const NGUONG = 3;
    const NGHI_MS = 5 * 60_000;
    const n = (this.modelFails.get(model) ?? 0) + 1;
    if (n >= NGUONG) {
      this.modelCooldown.set(model, now + NGHI_MS);
      this.modelFails.delete(model);
    } else {
      this.modelFails.set(model, n);
    }
  }

  /** Model chạy được → xoá bộ đếm, tránh tích luỹ lỗi rải rác qua nhiều giờ thành cooldown oan. */
  clearModelFails(model: string): void {
    this.modelFails.delete(model);
  }

  /**
   * Xoá mọi cooldown model. Dùng khi cần trạng thái sạch — test dùng chung pool singleton,
   * và người vận hành đôi khi muốn thử lại ngay thay vì đợi hết 5 phút.
   */
  clearAllModelCooldown(): void {
    this.modelCooldown.clear();
    this.modelFails.clear();
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

/**
 * Nous XOAY VÒNG refresh token: mỗi lần refresh trả token mới và vô hiệu token cũ. Không
 * ghi xuống CSV thì restart là mất, và Portal trả `invalid_grant: Refresh token reuse
 * detected` — account chết vĩnh viễn, phải đăng ký lại từ đầu.
 *
 * Cắm ở đây vì `providers/` không được import store (quy tắc chống vòng lặp module).
 */
setRotateHook((a) => {
  try {
    store.upsertCredential({
      email: a.email,
      target: PROVIDERS[a.provider].credentialTarget,
      value: a.credential,
      expires_at: '',
      omniroute_connection_id: '',
      updated_at: '',
    });
  } catch (e) {
    // Ghi hỏng thì token mới vẫn còn trong RAM — nhưng `upsert()` sẽ ghi đè nó bằng bản
    // CSV cũ sau 2 giây, và bản cũ đã bị upstream vô hiệu. Đây là đường dẫn tới "account
    // chết vĩnh viễn", phải kêu lên chứ không nuốt.
    logger.error(`[${a.email}] LƯU token xoay vòng THẤT BẠI: ${e instanceof Error ? e.message : String(e)}`);
  }
});
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
  /**
   * CHỐT AN TOÀN trước khi xoá.
   *
   * `readCsvFile` trả mảng rỗng khi file không tồn tại — không phân biệt "rỗng thật" với
   * "không đọc được". Không có chốt này thì một lần đọc hụt xoá sạch 703 account trong 2
   * giây, rồi `flushPersist()` ghi đè `gateway.json` (1,8 MB state) bằng pool rỗng.
   */
  const dangGiu = pool.list().length;
  const kt = xoaAnToan(dangGiu, seen.size);
  if (kt.choPhep) {
    for (const a of pool.list()) if (!seen.has(a.key)) pool.remove(a.key);
  } else {
    // Giữ nguyên pool cũ và kêu lên. Nhịp sync sau đọc lại được thì tự khớp.
    logger.error(`[pool] TỪ CHỐI đồng bộ: ${kt.lyDo}. Giữ nguyên ${dangGiu} account.`);
  }
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
        provider: account.provider,
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
