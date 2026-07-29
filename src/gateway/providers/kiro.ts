import type { Dispatcher } from 'undici';
import {
  KIRO_MODELS,
  KiroError,
  kiroGenerate,
  kiroGenerateStream,
  parseKiroCredential,
  refreshKiroToken,
} from '../kiro.js';
import type { GenArgs, LiveResult, Provider, ProviderAccount, ProviderSession, StreamEvent } from './types.js';
import type { GenResult } from '../antigravity.js';

/**
 * Adapter Kiro (AWS CodeWhisperer).
 * Khác Antigravity: không có API hạn mức → `quota` KHÔNG được cài; trạng thái còn dùng được
 * chỉ biết bằng cách gọi thử (checkLive). Hết hạn mức tháng = HTTP 402 MONTHLY_REQUEST_COUNT.
 */

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const LIVE_PROBE_MODEL = 'claude-haiku-4-5'; // model rẻ nhất để dò

/** Lỗi này có nghĩa account hết hạn mức (không phải hỏng token). */
export function isKiroQuotaError(e: unknown): boolean {
  const err = e as KiroError | undefined;
  if (!err) return false;
  if (err.status === 402 || err.status === 429) return true;
  return /MONTHLY_REQUEST_COUNT|Throttling|ServiceQuotaExceeded|reached the limit/i.test(String(err.message ?? ''));
}

export const kiroProvider: Provider = {
  id: 'kr',
  label: 'Kiro',
  credentialTarget: 'kiro',
  models: KIRO_MODELS,
  defaultModel: 'claude-sonnet-4',

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
      if (t.refreshToken && t.refreshToken !== a.refreshToken) a.refreshToken = t.refreshToken;
    }
    return { accessToken: a.token.accessToken, profileArn: a.profileArn, region: a.region };
  },

  generate(args: GenArgs): Promise<GenResult> {
    return kiroGenerate({
      session: { accessToken: args.session.accessToken, profileArn: args.session.profileArn },
      model: args.model,
      messages: args.messages,
      dispatcher: args.dispatcher,
      signal: args.signal,
    });
  },

  generateStream(args: GenArgs): AsyncGenerator<StreamEvent> {
    return kiroGenerateStream({
      session: { accessToken: args.session.accessToken, profileArn: args.session.profileArn },
      model: args.model,
      messages: args.messages,
      dispatcher: args.dispatcher,
      signal: args.signal,
    });
  },

  async checkToken(a: ProviderAccount, d?: Dispatcher): Promise<boolean> {
    try {
      const t = await refreshKiroToken(a.refreshToken, d);
      a.token = { accessToken: t.accessToken, expiresAt: t.expiresAt };
      if (t.profileArn) a.profileArn = t.profileArn;
      return true;
    } catch {
      return false;
    }
  },

  /** Dò hạn mức bằng cách gọi thật 1 request cực nhỏ (Kiro không có API quota). */
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

  // quota: KHÔNG cài — Kiro không có API hạn mức. Dùng checkLive để dò.
};
