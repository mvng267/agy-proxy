import { agyProvider } from './agy.js';
import { kiroProvider } from './kiro.js';
import { openrouterProvider } from './openrouter.js';
import { nousProvider } from './nous.js';
import type { Provider, ProviderId, ProviderModel } from './types.js';

export * from './types.js';
export { agyProvider, kiroProvider, openrouterProvider, nousProvider };

export const PROVIDERS: Record<ProviderId, Provider> = {
  agy: agyProvider,
  kr: kiroProvider,
  or: openrouterProvider,
  no: nousProvider,
};
export const PROVIDER_IDS: readonly ProviderId[] = ['agy', 'kr', 'or', 'no'];

/** Bí danh prefix → provider id. */
const ALIAS: Record<string, ProviderId> = {
  agy: 'agy',
  antigravity: 'agy',
  kr: 'kr',
  kiro: 'kr',
  or: 'or',
  openrouter: 'or',
  no: 'no',
  nous: 'no',
};

export function getProvider(id: string): Provider | undefined {
  const p = ALIAS[String(id).toLowerCase()];
  return p ? PROVIDERS[p] : undefined;
}

/** Credential.target trong store ('agy'|'kiro') → provider. Trả undefined với gweb/gcli. */
export function providerOfTarget(target: string): Provider | undefined {
  for (const id of PROVIDER_IDS) {
    if (PROVIDERS[id].credentialTarget === target) return PROVIDERS[id];
  }
  return undefined;
}

export interface PrefixedModel extends ProviderModel {
  provider: ProviderId;
  providerLabel: string;
  prefixed: string;
}

/** Toàn bộ model của mọi provider, id đã prefix. */
export function allModels(): PrefixedModel[] {
  const out: PrefixedModel[] = [];
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id];
    for (const m of p.models) {
      out.push({ ...m, provider: id, providerLabel: p.label, prefixed: `${id}/${m.id}` });
    }
  }
  return out;
}

/**
 * Chế độ id trần: bật khi gateway trung gian (OmniRoute…) tự thêm prefix của nó.
 * Đặt từ config lúc boot — KHÔNG import config ở đây để tránh phụ thuộc vòng.
 */
let bareMode = false;
export function setBareMode(on: boolean): void {
  bareMode = on;
}

export type ModelKind = 'provider' | 'combo' | 'auto';

export interface ParsedModel {
  kind: ModelKind;
  provider?: ProviderId; // kind==='provider'
  model?: string; // id trần
  prefixed: string; // id chuẩn hoá để log/usage/echo
  combo?: string; // kind==='combo' → tên combo; kind==='auto' → biến thể
}

/** Lỗi model id — routes trả 400 kèm gợi ý. */
export class ModelIdError extends Error {
  status = 400;
  suggestion?: string;
  constructor(message: string, suggestion?: string) {
    super(message);
    this.suggestion = suggestion;
  }
}

/** Tìm id trần này thuộc provider nào (để gợi ý khi thiếu prefix). */
function guessProvider(bare: string): ProviderId | undefined {
  for (const id of PROVIDER_IDS) {
    if (PROVIDERS[id].models.some((m) => m.id === bare)) return id;
  }
  return undefined;
}

/**
 * Phân tích model id. PREFIX BẮT BUỘC:
 *   agy/… | antigravity/…  → Antigravity
 *   kr/…  | kiro/…         → Kiro
 *   or/…  | openrouter/…   → OpenRouter / upstream OpenAI-compatible tuỳ ý
 *   combo/<tên>            → combo do người dùng tạo
 *   auto | auto/<biến thể> → combo ảo dựng theo từng request
 * Thiếu prefix hoặc prefix lạ → ModelIdError (HTTP 400) kèm gợi ý.
 */
export function parseModelId(raw: string | undefined | null): ParsedModel {
  const s = String(raw ?? '').trim();
  if (!s) {
    throw new ModelIdError(
      'Thiếu tham số "model". Dùng id có prefix, ví dụ: agy/gemini-3-pro-low hoặc kr/claude-sonnet-4.',
    );
  }

  if (s === 'auto') return { kind: 'auto', prefixed: 'auto', combo: 'default' };

  const slash = s.indexOf('/');
  if (slash < 0) {
    // Chế độ id trần (cho gateway trung gian tự thêm prefix, vd OmniRoute):
    // chấp nhận id không prefix; đuôi "-kr" để chỉ rõ model Kiro khi trùng tên.
    if (bareMode) {
      const krSuffix = s.endsWith('-kr');
      const base = krSuffix ? s.slice(0, -3) : s;
      const pid: ProviderId | undefined = krSuffix
        ? (PROVIDERS.kr.models.some((m) => m.id === base) ? 'kr' : undefined)
        : guessProvider(base);
      if (pid) {
        const norm = PROVIDERS[pid].normalizeModel?.(base) ?? base;
        return { kind: 'provider', provider: pid, model: norm, prefixed: `${pid}/${norm}` };
      }
    }
    const guess = guessProvider(s);
    throw new ModelIdError(
      `Model "${s}" thiếu prefix provider.` + (guess ? ` Dùng "${guess}/${s}".` : ' Xem danh sách ở /proxy/v1/models.'),
      guess ? `${guess}/${s}` : undefined,
    );
  }

  const head = s.slice(0, slash).toLowerCase();
  const rest = s.slice(slash + 1);

  /**
   * Tên combo/auto chuẩn hoá về CHỮ THƯỜNG.
   *
   * `admin.ts` khi tạo combo luôn ép id về chữ thường (`.toLowerCase()` + lọc ký tự),
   * nên id trong DB không bao giờ có chữ hoa. Bản trước chỉ hạ chữ phần prefix mà giữ
   * nguyên phần tên, nên `combo/FAST` tra không ra và trả 404 dù combo `fast` tồn tại —
   * một client viết hoa tên combo là chết mà không hiểu vì sao.
   */
  if (head === 'auto') {
    const name = rest.toLowerCase();
    return { kind: 'auto', prefixed: `auto/${name}`, combo: name || 'default' };
  }
  if (head === 'combo') {
    if (!rest) throw new ModelIdError('Combo thiếu tên: dùng combo/<tên>.');
    const name = rest.toLowerCase();
    return { kind: 'combo', prefixed: `combo/${name}`, combo: name };
  }

  // Alias đặc biệt: kiro/<model> → route sang backend Antigravity (agy).
  // Mục đích: worker Claude CLI chấp nhận prefix `kiro/` (không chấp nhận `agy/`),
  // nhưng muốn dùng quota Antigravity. Mọi model kiro/<x> mà không phải model Kiro thật
  // (không có trong KIRO_MODELS) sẽ được coi là alias sang agy backend với id = x.
  // Ví dụ: kiro/claude-opus-4-6 → agy/claude-opus-4-6-thinking,
  //        kiro/claude-sonnet-4.6 → agy/claude-sonnet-4.6,
  //        kiro/gemini-3-flash → agy/gemini-3-flash, ...
  if (head === 'kiro') {
    const kiroModel = PROVIDERS.kr.models.find((m) => m.id === rest);
    if (!kiroModel) {
      // Không phải model Kiro thật → có thể là alias sang agy backend.
      // Quy ước: tên bắt đầu bằng "agy-" → route sang Antigravity với id tương ứng.
      //   kiro/agy-opus-4-6     → agy/claude-opus-4-6-thinking
      //   kiro/agy-sonnet-4.6   → agy/claude-opus-4-6-thinking (sonnet-4.6 đã retire)
      //   kiro/agy-gemini-3-flash → agy/gemini-3-flash
      // Model Kiro thật (claude-sonnet-4.5, haiku, qwen...) vẫn đi thẳng vào kiro.
      if (rest.startsWith('agy-')) {
        const agyId = rest.slice('agy-'.length); // bỏ "agy-" → "opus-4-6", "gemini-3-flash"
        let agyModel = agyId;
        // ánh xạ tên ngắn → id thật trên agy
        if (agyId === 'opus-4-6' || agyId === 'sonnet-4.6' || agyId === 'sonnet-4-5') {
          agyModel = 'claude-opus-4-6-thinking';
        } else if (agyId.startsWith('gemini') || agyId.startsWith('gpt')) {
          agyModel = agyId; // giữ nguyên id gemini/gpt
        }
        return { kind: 'provider', provider: 'agy', model: agyModel, prefixed: `agy/${agyModel}` };
      }
      // Không rõ → để logic mặc định ném lỗi rõ nghĩa
    }
  }

  const pid = ALIAS[head];
  if (!pid) {
    const guess = guessProvider(s);
    throw new ModelIdError(
      `Prefix "${head}/" không phải provider của gateway này (agy/, kr/, or/, combo/, auto).` +
        (guess ? ` Có phải bạn muốn "${guess}/${s}"?` : ''),
      guess ? `${guess}/${s}` : undefined,
    );
  }
  if (!rest) throw new ModelIdError(`Thiếu tên model sau "${head}/".`);
  // chuẩn hoá bí danh (vd kr/claude-haiku-4-5 → kr/claude-haiku-4.5) để log/usage/combo đồng nhất
  const norm = PROVIDERS[pid].normalizeModel?.(rest) ?? rest;
  return { kind: 'provider', provider: pid, model: norm, prefixed: `${pid}/${norm}` };
}
