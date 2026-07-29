import { agyProvider } from './agy.js';
import { kiroProvider } from './kiro.js';
import type { Provider, ProviderId, ProviderModel } from './types.js';

export * from './types.js';
export { agyProvider, kiroProvider };

export const PROVIDERS: Record<ProviderId, Provider> = {
  agy: agyProvider,
  kr: kiroProvider,
};
export const PROVIDER_IDS: readonly ProviderId[] = ['agy', 'kr'];

/** Bí danh prefix → provider id. */
const ALIAS: Record<string, ProviderId> = {
  agy: 'agy',
  antigravity: 'agy',
  kr: 'kr',
  kiro: 'kr',
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
    const guess = guessProvider(s);
    throw new ModelIdError(
      `Model "${s}" thiếu prefix provider.` + (guess ? ` Dùng "${guess}/${s}".` : ' Xem danh sách ở /proxy/v1/models.'),
      guess ? `${guess}/${s}` : undefined,
    );
  }

  const head = s.slice(0, slash).toLowerCase();
  const rest = s.slice(slash + 1);

  if (head === 'auto') return { kind: 'auto', prefixed: `auto/${rest}`, combo: rest || 'default' };
  if (head === 'combo') {
    if (!rest) throw new ModelIdError('Combo thiếu tên: dùng combo/<tên>.');
    return { kind: 'combo', prefixed: `combo/${rest}`, combo: rest };
  }

  const pid = ALIAS[head];
  if (!pid) {
    const guess = guessProvider(s);
    throw new ModelIdError(
      `Prefix "${head}/" không phải provider của gateway này (agy/, kr/, combo/, auto).` +
        (guess ? ` Có phải bạn muốn "${guess}/${s}"?` : ''),
      guess ? `${guess}/${s}` : undefined,
    );
  }
  if (!rest) throw new ModelIdError(`Thiếu tên model sau "${head}/".`);
  return { kind: 'provider', provider: pid, model: rest, prefixed: `${pid}/${rest}` };
}
