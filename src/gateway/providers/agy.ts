import type { Dispatcher } from 'undici';
import {
  MODELS,
  refreshAccessToken,
  discoverProject,
  generate,
  generateStream,
  fetchQuota,
  checkModelsLive,
} from '../antigravity.js';
import type { GenArgs, LiveResult, Provider, ProviderAccount, ProviderSession, StreamEvent } from './types.js';
import type { GenResult, QuotaInfo } from '../antigravity.js';

/**
 * Adapter Antigravity — bọc mỏng antigravity.ts (KHÔNG chuyển logic ra ngoài,
 * để test convert.test.ts vẫn import trực tiếp module cũ).
 */

const REFRESH_SKEW_MS = 5 * 60 * 1000;
const LIVE_PROBE_MODEL = 'gemini-2.5-flash';

export const agyProvider: Provider = {
  id: 'agy',
  label: 'Antigravity',
  credentialTarget: 'agy',
  models: MODELS,
  defaultModel: 'gemini-3-pro-low',
  supportsTools: true, // Gemini functionDeclarations/functionCall

  accepts(value) {
    return typeof value === 'string' && value.startsWith('1//');
  },

  parseCredential(value) {
    return this.accepts(value) ? { refreshToken: value } : null;
  },

  sessionFresh(a, now) {
    return !!(a.token && a.token.expiresAt - REFRESH_SKEW_MS > now && a.projectId);
  },

  sessionOf(a): ProviderSession {
    return { accessToken: a.token?.accessToken ?? '', projectId: a.projectId };
  },

  async ensureReady(a: ProviderAccount, d?: Dispatcher): Promise<ProviderSession> {
    const now = Date.now();
    if (!a.token || a.token.expiresAt - REFRESH_SKEW_MS <= now) {
      a.token = await refreshAccessToken(a.refreshToken, d);
    }
    if (!a.projectId) {
      a.projectId = await discoverProject(a.token.accessToken, d);
    }
    return { accessToken: a.token.accessToken, projectId: a.projectId };
  },

  generate(args: GenArgs): Promise<GenResult> {
    return generate({
      accessToken: args.session.accessToken,
      projectId: args.session.projectId ?? '',
      model: args.model,
      messages: args.messages,
      generationConfig: args.generationConfig,
      tools: args.tools,
      dispatcher: args.dispatcher,
      signal: args.signal,
    });
  },

  generateStream(args: GenArgs): AsyncGenerator<StreamEvent> {
    return generateStream({
      accessToken: args.session.accessToken,
      projectId: args.session.projectId ?? '',
      model: args.model,
      messages: args.messages,
      generationConfig: args.generationConfig,
      tools: args.tools,
      dispatcher: args.dispatcher,
      signal: args.signal,
    });
  },

  async checkToken(a: ProviderAccount, d?: Dispatcher): Promise<boolean> {
    try {
      const t = await refreshAccessToken(a.refreshToken, d);
      a.token = t;
      return !!t.accessToken;
    } catch {
      return false;
    }
  },

  async checkLive(_a: ProviderAccount, s: ProviderSession, d?: Dispatcher): Promise<LiveResult> {
    const t0 = Date.now();
    try {
      const r = await generate({
        accessToken: s.accessToken,
        projectId: s.projectId ?? '',
        model: LIVE_PROBE_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        generationConfig: { maxOutputTokens: 8 },
        dispatcher: d,
      });
      return { status: 'ok', ms: Date.now() - t0, detail: (r.text || '').slice(0, 40) };
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const quota = e?.status === 429 || /quota|exhaust|resource_exhausted/i.test(msg);
      return { status: quota ? 'quota' : 'error', ms: Date.now() - t0, detail: msg.slice(0, 120) };
    }
  },

  checkModelsLive(s: ProviderSession, d?: Dispatcher) {
    return checkModelsLive(s.accessToken, s.projectId ?? '', d);
  },

  async quota(_a: ProviderAccount, s: ProviderSession, d?: Dispatcher): Promise<QuotaInfo | undefined> {
    return fetchQuota(s.accessToken, s.projectId ?? '', d);
  },
};
