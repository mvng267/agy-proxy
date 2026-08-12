import type { Dispatcher } from 'undici';
import type {
  GenArgs, GenResult, LiveResult, Provider, ProviderAccount, ProviderSession, QuotaInfo, StreamEvent,
} from './types.js';
import { luuTokenXoay } from './types.js';
import { checkTokenOpenAI, generateOpenAI, probeModel, streamOpenAI } from './openaiWire.js';

/**
 * Nous Research Portal — upstream OpenAI-compatible, nhưng xác thực bằng OAuth.
 *
 * Vì sao KHÔNG dùng provider `or` sẵn có: `openrouter.ts` khai `sessionFresh()` luôn trả
 * true vì nó giả định API key sống mãi. Nous phát JWT **hết hạn sau 1 giờ** (đo thật: token
 * trong ~/.hermes/auth.json còn 18 phút lúc kiểm), có refresh_token để tự gia hạn. Dùng `or`
 * thì phải dán token thủ công mỗi giờ — không dùng được cho production.
 *
 * Phần wire (dựng body, parse SSE, gom tool_calls) dùng chung ở `openaiWire.ts`.
 */

const INFERENCE_URL = 'https://inference-api.nousresearch.com/v1';
const PORTAL_URL = 'https://portal.nousresearch.com';
/** Cùng client_id mà hermes-cli dùng — Portal cấp device-code cho id này. */
export const NOUS_CLIENT_ID = 'hermes-cli';
export const NOUS_SCOPE = 'inference:invoke tool:invoke';

/** Làm mới trước hạn 5 phút: request đang bay không được chết giữa chừng vì token vừa hết. */
const REFRESH_SKEW_MS = 5 * 60_000;

export interface NousCredential {
  refreshToken: string;
}

/** Bóc credential thô. null = không phải credential Nous. */
export function parseNousCredential(value: string): NousCredential | null {
  const s = String(value ?? '').trim();
  if (!s.startsWith('{')) return null;
  try {
    const j = JSON.parse(s);
    // `nous: true` để phân biệt với credential OpenRouter dạng JSON — cả hai đều là JSON
    // nên nếu không có dấu hiệu riêng thì `accepts()` của hai provider sẽ tranh nhau.
    if (j?.provider !== 'nous' && j?.nous !== true) return null;
    if (typeof j?.refreshToken === 'string' && j.refreshToken) return { refreshToken: j.refreshToken };
  } catch { /* không phải JSON → không phải của provider này */ }
  return null;
}

/**
 * Hạn dùng của JWT, đọc từ claim `exp`.
 *
 * Response refresh có `expires_in` nhưng KHÔNG phải lúc nào cũng có — đọc thẳng từ token là
 * nguồn chắc chắn nhất. Hỏng thì trả 0 để buộc refresh ngay, thà gọi thừa còn hơn dùng token
 * chết rồi cả pool báo 401.
 */
export function jwtExpiresAt(token: string): number {
  try {
    const p = token.split('.')[1];
    if (!p) return 0;
    const json = Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = JSON.parse(json)?.exp;
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Đổi refresh_token lấy access_token mới. */
export async function refreshNousToken(
  refreshToken: string, d?: Dispatcher,
): Promise<{ accessToken: string; expiresAt: number; refreshToken?: string }> {
  const res = await fetch(`${PORTAL_URL}/api/oauth/token`, {
    method: 'POST',
    // Refresh token đi ở HEADER riêng, không nằm trong body như OAuth chuẩn.
    headers: {
      'x-nous-refresh-token': refreshToken,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: NOUS_CLIENT_ID }),
    signal: AbortSignal.timeout(30_000),
    ...(d ? ({ dispatcher: d } as any) : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`nous refresh ${res.status}: ${text.slice(0, 160)}`), { status: res.status });
  }
  const j = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error('nous refresh: thiếu access_token');
  const fromJwt = jwtExpiresAt(j.access_token);
  return {
    accessToken: j.access_token,
    expiresAt: fromJwt || Date.now() + (j.expires_in ?? 3600) * 1000,
    // Nous XOAY VÒNG refresh token: mỗi lần refresh trả về token MỚI và vô hiệu token cũ.
    // Không lưu lại thì lần sau Portal trả `invalid_grant: Refresh token reuse detected`
    // và account chết hẳn — đã gặp thật khi nạp token copy từ hermes.
    refreshToken: j.refresh_token,
  };
}

/**
 * Hạn mức từ header `x-ratelimit-*` của CHÍNH response gọi model.
 *
 * Nous không có API để hỏi hạn mức — đã dò `/credits`, `/usage`, `/me`, `/key`,
 * `/subscription`, `/limits` trên cả inference-api lẫn portal, đều 404 hoặc trả trang HTML.
 * Bù lại nó gắn số vào mọi response, nên đọc ở đây còn TƯƠI HƠN gọi API riêng và không tốn
 * thêm request nào.
 *
 * Bốn bể độc lập — khác hẳn agy (2 bể/tuần) và kr (1 quỹ/tháng). Đây là hạn mức theo NHỊP:
 * cạn rồi tự đầy sau 60 giây, nên account Nous không bao giờ "chết" như agy/kr.
 *
 * Đo thật 11/08/2026 trên tencent/hy3:free:
 *   requests 50/phút · 2100/giờ    tokens 500k/phút · 6M/giờ
 */
const BUCKETS: Array<{ key: string; name: string }> = [
  { key: 'requests', name: 'Request/phút' },
  { key: 'requests-1h', name: 'Request/giờ' },
  { key: 'tokens', name: 'Token/phút' },
  { key: 'tokens-1h', name: 'Token/giờ' },
];

export function quotaFromHeaders(h: Headers | Record<string, string>): QuotaInfo | undefined {
  const get = (k: string): string | null =>
    typeof (h as Headers).get === 'function'
      ? (h as Headers).get(k)
      : ((h as Record<string, string>)[k] ?? null);

  const groups: QuotaInfo['groups'] = [];
  for (const b of BUCKETS) {
    const limit = Number(get(`x-ratelimit-limit-${b.key}`));
    const remain = Number(get(`x-ratelimit-remaining-${b.key}`));
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remain)) continue;
    const resetSec = Number(get(`x-ratelimit-reset-${b.key}`));
    groups.push({
      name: b.name,
      pct: Math.max(0, Math.min(100, Math.round((remain / limit) * 100))),
      resetTime: Number.isFinite(resetSec) ? new Date(Date.now() + resetSec * 1000).toISOString() : '',
      desc: `${remain}/${limit}`,
    });
  }
  // Không có header nào → CHƯA BIẾT, không bịa 0%. Model trả phí và vài upstream không gắn
  // header này; báo 0% sẽ khiến vòng auto-disable tắt oan account đang khoẻ.
  return groups.length ? { tier: 'NOUS FREE', groups, models: [], fetchedAt: Date.now() } : undefined;
}

/**
 * 404 "requires available credits" là LỖI TÀI KHOẢN (chưa nạp tiền), không phải "model
 * không tồn tại". Nhầm hai thứ này là đánh dấu account chết oan — đúng kiểu lỗi đã giết
 * 331 account Kiro trước đây. Đổi sang 402 để pool hiểu là hết hạn mức và cho cooldown.
 */
function fixCreditError(e: any): never {
  if (e?.status === 404 && /requires available credits|balance is too low/i.test(String(e?.message ?? ''))) {
    throw Object.assign(new Error(String(e.message)), { status: 402 });
  }
  throw e;
}

/** Ảnh chụp hạn mức mới nhất, theo account — điền vào bởi mỗi lần gọi thật. */
const quotaCache = new Map<string, QuotaInfo>();

const WIRE = { label: 'nous', defaultBaseUrl: INFERENCE_URL };

/** Bọc opts để mỗi response đều được bóc hạn mức về đúng account. */
function wireFor(s: ProviderSession) {
  return {
    ...WIRE,
    onResponse: (res: Response) => {
      const q = quotaFromHeaders(res.headers);
      if (q && s.accountKey) quotaCache.set(s.accountKey, q);
    },
  };
}

export const nousProvider: Provider = {
  id: 'no',
  label: 'Nous Research',
  credentialTarget: 'nous',
  /**
   * CHỈ model `:free`. Bản trả phí (tencent/hy3, deepseek/*…) trả 404 "requires available
   * credits" khi tài khoản chưa nạp tiền — chào chúng ra trong danh sách là mời người dùng
   * gọi vào lỗi. `parseModelId` cho qua mọi id sau prefix nên vẫn gọi tay được nếu muốn.
   */
  models: [
    { id: 'tencent/hy3:free', label: 'Hunyuan 3 (free)', image: false, maxInput: 262_144 },
  ],
  defaultModel: 'tencent/hy3:free',
  supportsTools: true,

  accepts(value) {
    return parseNousCredential(value) !== null;
  },

  parseCredential(value) {
    const c = parseNousCredential(value);
    return c ? { refreshToken: c.refreshToken } : null;
  },

  sessionFresh(a, now) {
    return !!(a.token && a.token.expiresAt - REFRESH_SKEW_MS > now);
  },

  sessionOf(a): ProviderSession {
    return { accessToken: a.token?.accessToken ?? '', baseUrl: INFERENCE_URL, accountKey: a.key };
  },

  async ensureReady(a: ProviderAccount, d?: Dispatcher): Promise<ProviderSession> {
    const now = Date.now();
    if (!a.token || a.token.expiresAt - REFRESH_SKEW_MS <= now) {
      const r = await refreshNousToken(a.refreshToken, d);
      a.token = { accessToken: r.accessToken, expiresAt: r.expiresAt };
      // LƯU token xoay vòng ngay, cả trong RAM lẫn xuống đĩa. Chỉ giữ trong RAM thì
      // restart là mất và account chết vĩnh viễn (Portal đã vô hiệu token cũ).
      if (r.refreshToken && r.refreshToken !== a.refreshToken) {
        a.refreshToken = r.refreshToken;
        a.credential = JSON.stringify({ provider: 'nous', refreshToken: r.refreshToken });
        luuTokenXoay(a);
      }
    }
    return this.sessionOf(a);
  },

  async generate(args: GenArgs): Promise<GenResult> {
    return generateOpenAI(args, wireFor(args.session)).catch(fixCreditError);
  },

  async *generateStream(args: GenArgs): AsyncGenerator<StreamEvent> {
    try {
      yield* streamOpenAI(args, wireFor(args.session));
    } catch (e) {
      fixCreditError(e);
    }
  },

  async checkToken(a: ProviderAccount, d?: Dispatcher): Promise<boolean> {
    try {
      return await checkTokenOpenAI(await this.ensureReady(a, d), INFERENCE_URL, d);
    } catch {
      return false;
    }
  },

  async checkLive(_a: ProviderAccount, s: ProviderSession, d?: Dispatcher): Promise<LiveResult> {
    return probeModel(this, s, this.defaultModel, d);
  },

  async checkModelsLive(s: ProviderSession, d?: Dispatcher) {
    const out: { id: string; status: 'ok' | 'quota' | 'error'; ms: number; detail?: string }[] = [];
    for (const m of this.models) out.push({ id: m.id, ...(await probeModel(this, s, m.id, d)) });
    return out;
  },

  /**
   * Trả ảnh chụp từ lần gọi gần nhất — KHÔNG tự gọi mạng.
   *
   * Nous không có API hạn mức, số chỉ đến kèm response gọi model. Account chưa gọi lần nào
   * thì `undefined` (đúng: chưa biết), không bịa số.
   */
  async quota(a: ProviderAccount): Promise<QuotaInfo | undefined> {
    return quotaCache.get(a.key);
  },
};
