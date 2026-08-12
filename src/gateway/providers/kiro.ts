import type { Dispatcher } from 'undici';
import {
  KIRO_MODELS,
  KiroError,
  kiroGenerate,
  kiroGenerateStream,
  parseKiroCredential,
  resolveKiroUpstream,
  refreshKiroToken,
  fetchKiroUsage,
} from '../kiro.js';
import { luuTokenXoay } from './types.js';
import type { GenArgs, LiveResult, Provider, ProviderAccount, ProviderSession, StreamEvent } from './types.js';
import type { GenResult, QuotaInfo } from '../antigravity.js';

/**
 * Adapter Kiro (AWS CodeWhisperer).
 * Hạn mức lấy THẬT qua GetUsageLimits (host q.us-east-1, KHÔNG tốn credit).
 * Hết hạn mức tháng = HTTP 402 MONTHLY_REQUEST_COUNT.
 */

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const LIVE_PROBE_MODEL = 'qwen3-coder-next'; // RẺ NHẤT: 0.05 credit/lượt (haiku 0.4, sonnet 1.3)

/** Lỗi này có nghĩa account hết hạn mức (không phải hỏng token). */
export function isKiroQuotaError(e: unknown): boolean {
  const err = e as KiroError | undefined;
  if (!err) return false;
  if (err.status === 402 || err.status === 429) return true;
  return /MONTHLY_REQUEST_COUNT|Throttling|ServiceQuotaExceeded|reached the limit/i.test(String(err.message ?? ''));
}

/**
 * Ghi refresh token vừa xoay vào RAM **và** xuống đĩa.
 *
 * Chỉ gán `a.refreshToken` là vô nghĩa: `pool.upsert()` ghi đè nó bằng bản từ CSV sau mỗi
 * nhịp sync 2 giây, nên token mới sống nhiều nhất 2 giây. Phải cập nhật cả `a.credential`
 * (thứ thực sự được ghi xuống CSV) rồi báo hook.
 *
 * Credential Kiro là JSON nhiều trường — giữ nguyên các trường cũ, chỉ thay phần đổi. Ghi
 * đè bằng `{refreshToken}` trần là mất `profileArn`/`region`: account vẫn refresh được
 * nhưng gọi model thì hỏng.
 */
function ghiTokenMoi(a: ProviderAccount, refreshToken: string, profileArn?: string): void {
  a.refreshToken = refreshToken;
  const cu = parseKiroCredential(a.credential ?? '') ?? {};
  a.credential = JSON.stringify({
    ...cu,
    refreshToken,
    ...(profileArn ? { profileArn } : {}),
  });
  luuTokenXoay(a);
}

export const kiroProvider: Provider = {
  id: 'kr',
  label: 'Kiro',
  credentialTarget: 'kiro',
  models: KIRO_MODELS,
  defaultModel: 'claude-sonnet-4.5',
  // CodeWhisperer không có function calling native → agy-proxy tự bypass:
  // tools được chuyển thành text prompt, output parse thủ công thành tool_calls.
  supportsTools: true,
  bypassTools: true, // cờ báo route: không ném 400, xử lý tool qua prompt injection

  /** claude-haiku-4-5 → claude-haiku-4.5 (id thật dùng dấu chấm). */
  normalizeModel(id) {
    return resolveKiroUpstream(id);
  },

  accepts(value) {
    return parseKiroCredential(value) !== null;
  },

  parseCredential(value) {
    const c = parseKiroCredential(value);
    if (!c) return null;
    return { refreshToken: c.refreshToken, profileArn: c.profileArn, region: c.region };
  },

  sessionFresh(a, now) {
    return !!(a.token && a.token.expiresAt - REFRESH_SKEW_MS > now && a.profileArn);
  },

  sessionOf(a): ProviderSession {
    return { accessToken: a.token?.accessToken ?? '', profileArn: a.profileArn, region: a.region };
  },

  async ensureReady(a: ProviderAccount, d?: Dispatcher): Promise<ProviderSession> {
    const now = Date.now();
    if (!a.token || a.token.expiresAt - REFRESH_SKEW_MS <= now) {
      const t = await refreshKiroToken(a.refreshToken, d);
      a.token = { accessToken: t.accessToken, expiresAt: t.expiresAt };
      // refresh trả profileArn mới → dùng bản mới nhất
      if (t.profileArn) a.profileArn = t.profileArn;
      // Kiro xoay refresh token: cập nhật để lần sau còn dùng được
      if (t.refreshToken && t.refreshToken !== a.refreshToken) ghiTokenMoi(a, t.refreshToken, t.profileArn);
    }
    return { accessToken: a.token!.accessToken, profileArn: a.profileArn, region: a.region };
  },

  generate(args: GenArgs): Promise<GenResult> {
    return kiroGenerate({
      session: { accessToken: args.session.accessToken, profileArn: args.session.profileArn },
      model: args.model,
      messages: args.messages,
      tools: args.tools,
      dispatcher: args.dispatcher,
      signal: args.signal,
    });
  },

  generateStream(args: GenArgs): AsyncGenerator<StreamEvent> {
    return kiroGenerateStream({
      session: { accessToken: args.session.accessToken, profileArn: args.session.profileArn },
      model: args.model,
      messages: args.messages,
      tools: args.tools,
      dispatcher: args.dispatcher,
      signal: args.signal,
    });
  },

  async checkToken(a: ProviderAccount, d?: Dispatcher): Promise<boolean> {
    try {
      const t = await refreshKiroToken(a.refreshToken, d);
      a.token = { accessToken: t.accessToken, expiresAt: t.expiresAt };
      if (t.profileArn) a.profileArn = t.profileArn;
      // Health check cũng refresh thật → cũng nhận token xoay. Bản trước VỨT nó đi, mà
      // đường này chạy thường xuyên hơn cả `ensureReady`.
      if (t.refreshToken && t.refreshToken !== a.refreshToken) ghiTokenMoi(a, t.refreshToken, t.profileArn);
      return true;
    } catch {
      return false;
    }
  },

  /** Gọi thử 1 request cực nhỏ bằng model RẺ NHẤT để xác nhận account còn phục vụ được. */
  async checkLive(_a: ProviderAccount, s: ProviderSession, d?: Dispatcher): Promise<LiveResult> {
    const t0 = Date.now();
    try {
      const r = await kiroGenerate({
        session: { accessToken: s.accessToken, profileArn: s.profileArn },
        model: LIVE_PROBE_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        dispatcher: d,
      });
      return { status: 'ok', ms: Date.now() - t0, detail: (r.text || '').slice(0, 40) };
    } catch (e: any) {
      const quota = isKiroQuotaError(e);
      return {
        status: quota ? 'quota' : 'error',
        ms: Date.now() - t0,
        detail: String(e?.message ?? e).slice(0, 120),
      };
    }
  },

  async checkModelsLive(s: ProviderSession, d?: Dispatcher) {
    const out: { id: string; status: 'ok' | 'quota' | 'error'; ms: number; detail?: string }[] = [];
    for (const m of KIRO_MODELS) {
      const t0 = Date.now();
      try {
        const r = await kiroGenerate({
          session: { accessToken: s.accessToken, profileArn: s.profileArn },
          model: m.id,
          messages: [{ role: 'user', content: 'hi' }],
          dispatcher: d,
        });
        out.push({ id: m.id, status: 'ok', ms: Date.now() - t0, detail: (r.text || '').slice(0, 30) });
      } catch (e: any) {
        out.push({
          id: m.id,
          status: isKiroQuotaError(e) ? 'quota' : 'error',
          ms: Date.now() - t0,
          detail: String(e?.message ?? e).slice(0, 100),
        });
      }
    }
    return out;
  },

  /**
   * Hạn mức THẬT từ GetUsageLimits (q.us-east-1, KHÔNG tốn credit).
   * Trả về dạng QuotaInfo để dùng chung mọi UI/biểu đồ sẵn có.
   */
  async quota(_a: ProviderAccount, s: ProviderSession, d?: Dispatcher): Promise<QuotaInfo | undefined> {
    const u = await fetchKiroUsage(s.accessToken, s.profileArn, d);
    if (!u) return undefined;
    const reset = u.resetAt ? new Date(u.resetAt).toISOString() : '';
    return {
      tier: u.plan,
      groups: [
        { name: 'Credits', pct: u.pct, resetTime: reset, desc: `${u.used}/${u.limit} credit · reset sau ${u.daysUntilReset} ngày` },
      ],
      models: [],
      fetchedAt: Date.now(),
    };
  },
};
