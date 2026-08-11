import type { Dispatcher } from 'undici';
import type { GenArgs, GenResult, LiveResult, Provider, ProviderAccount, ProviderSession, StreamEvent } from './types.js';
import {
  checkTokenOpenAI, generateOpenAI, probeModel, streamOpenAI, toOpenAIWire,
} from './openaiWire.js';

/**
 * Adapter OpenAI-compatible (OpenRouter hoặc BẤT KỲ upstream nào nói wire-format
 * /chat/completions) — provider thứ 3, chứng minh dialect pattern mở rộng được:
 * toàn bộ engine/pool/combo/breaker dùng lại nguyên vẹn, chỉ cần cài interface Provider.
 *
 * Credential (bảng credentials, target 'openrouter') nhận 2 dạng:
 *   - key trần:  sk-or-v1-…                     → baseUrl mặc định openrouter.ai
 *   - JSON:      {"apiKey":"…","baseUrl":"…"}   → trỏ upstream OpenAI-compatible tuỳ ý
 *
 * Khác agy/kr: không có OAuth refresh (API key sống mãi → sessionFresh luôn true),
 * không có API hạn mức chung (quota = undefined; 429/402 đã được pool cooldown lo).
 *
 * Phần wire (dựng body, parse SSE, gom tool_calls) nằm ở `openaiWire.ts` — dùng chung
 * với provider Nous, vốn chỉ khác ở khâu xác thực.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/** Giữ export cũ: vài chỗ ngoài file này import `toOpenAIWire` từ đây. */
export { toOpenAIWire };

export interface OrCredential {
  apiKey: string;
  baseUrl: string;
}

/** Bóc credential thô → {apiKey, baseUrl}. null = không phải credential OpenRouter. */
export function parseOrCredential(value: string): OrCredential | null {
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (s.startsWith('sk-or-')) return { apiKey: s, baseUrl: DEFAULT_BASE_URL };
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      if (typeof j?.apiKey === 'string' && j.apiKey) {
        const baseUrl = typeof j.baseUrl === 'string' && j.baseUrl
          ? j.baseUrl.replace(/\/+$/, '')
          : DEFAULT_BASE_URL;
        return { apiKey: j.apiKey, baseUrl };
      }
    } catch { /* không phải JSON → không phải của provider này */ }
  }
  return null;
}

const WIRE = { label: 'openrouter', defaultBaseUrl: DEFAULT_BASE_URL };

export const openrouterProvider: Provider = {
  id: 'or',
  label: 'OpenRouter',
  credentialTarget: 'openrouter',
  /**
   * Danh sách chỉ để LIỆT KÊ (UI, /v1/models, check live) — parseModelId cho qua mọi id
   * sau prefix `or/`, kể cả id có dấu gạch chéo (or/anthropic/claude-sonnet-4).
   */
  models: [
    { id: 'openrouter/auto', label: 'OpenRouter Auto', image: false },
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', image: false },
    { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder', image: false },
  ],
  defaultModel: 'openrouter/auto',
  supportsTools: true,

  accepts(value) {
    return parseOrCredential(value) !== null;
  },

  parseCredential(value) {
    const c = parseOrCredential(value);
    // API key đóng luôn vai refreshToken (pool chỉ cần MỘT chuỗi định danh phiên).
    return c ? { refreshToken: c.apiKey } : null;
  },

  // API key không hết hạn → session luôn tươi, không có vòng refresh.
  sessionFresh() {
    return true;
  },

  sessionOf(a): ProviderSession {
    const c = parseOrCredential(a.credential);
    return { accessToken: c?.apiKey ?? a.refreshToken, baseUrl: c?.baseUrl ?? DEFAULT_BASE_URL };
  },

  async ensureReady(a: ProviderAccount): Promise<ProviderSession> {
    return this.sessionOf(a);
  },

  generate(args: GenArgs): Promise<GenResult> {
    return generateOpenAI(args, WIRE);
  },

  generateStream(args: GenArgs): AsyncGenerator<StreamEvent> {
    return streamOpenAI(args, WIRE);
  },

  async checkToken(a: ProviderAccount, d?: Dispatcher): Promise<boolean> {
    return checkTokenOpenAI(this.sessionOf(a), DEFAULT_BASE_URL, d);
  },

  async checkLive(_a: ProviderAccount, s: ProviderSession, d?: Dispatcher): Promise<LiveResult> {
    return probeModel(this, s, this.defaultModel, d);
  },

  async checkModelsLive(s: ProviderSession, d?: Dispatcher) {
    const out: { id: string; status: 'ok' | 'quota' | 'error'; ms: number; detail?: string }[] = [];
    for (const m of this.models) out.push({ id: m.id, ...(await probeModel(this, s, m.id, d)) });
    return out;
  },

  // Không có API hạn mức chung cho mọi upstream OpenAI-compatible → không cài quota().
};
