import type { Dispatcher } from 'undici';
import type { ChatMessage, GenResult, QuotaBucket, QuotaInfo, TokenInfo, ToolCall, ToolDef, Usage } from '../antigravity.js';

/**
 * Trừu tượng provider: gateway phục vụ nhiều nguồn model (Antigravity, Kiro…).
 * Quy tắc: file trong providers/ KHÔNG import pool.js (tránh vòng lặp).
 * PoolAccount kế thừa ProviderAccount.
 */

export type ProviderId = 'agy' | 'kr';

/** Kết quả ensureReady — phẳng, mỗi provider điền phần của mình. */
export interface ProviderSession {
  accessToken: string;
  projectId?: string; // agy
  profileArn?: string; // kr
  region?: string; // kr
}

/** Thông tin tối thiểu 1 provider cần để chạy 1 account. */
export interface ProviderAccount {
  provider: ProviderId;
  email: string;
  key: string; // `${provider}:${email}`
  refreshToken: string;
  credential: string; // giá trị thô trong store (kr: chuỗi JSON)
  profileArn?: string;
  region?: string;
  health: string;
  token?: TokenInfo;
  projectId?: string;
}

export interface ProviderModel {
  id: string; // id trần, chưa prefix
  label: string;
  image: boolean;
  /** Trần ngữ cảnh (token). Dùng để gợi ý model thay thế khi prompt quá dài. */
  maxInput?: number;
  /** Bể hạn mức (agy chia 2 bể độc lập). Không đặt = provider không chia bể (Kiro). */
  bucket?: QuotaBucket;
}

export interface GenArgs {
  session: ProviderSession;
  model: string; // id TRẦN (đã bỏ prefix)
  messages: ChatMessage[];
  generationConfig?: Record<string, unknown>;
  /** Provider có `supportsTools` mới dùng; provider khác bỏ qua an toàn. */
  tools?: ToolDef[];
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
}

export type StreamEvent = {
  delta?: string; image?: string; toolCall?: ToolCall; usage?: Usage; done?: boolean;
  /** Lý do dừng của upstream, chỉ có ở event cuối. Thiếu nó thì stream luôn báo 'stop'
   *  kể cả khi thực sự bị cắt vì max_tokens. */
  finishReason?: string;
};

export interface LiveResult {
  status: 'ok' | 'quota' | 'error';
  ms: number;
  detail?: string;
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** Khớp Credential.target trong store ('agy' | 'kiro') — KHÁC với id ('agy' | 'kr'). */
  readonly credentialTarget: string;
  readonly models: ProviderModel[];
  readonly defaultModel: string;
  /** Có function calling native không. false → GenArgs.tools bị bỏ qua (Kiro). */
  readonly supportsTools: boolean;
  /** Provider không có tool-use native nhưng agy-proxy tự bypass qua prompt injection. */
  readonly bypassTools?: boolean;

  /** Chuẩn hoá id model của người dùng về id thật (bí danh → id chính thức). */
  normalizeModel?(id: string): string;

  /** Giá trị credential này có phải của provider không. */
  accepts(value: string): boolean;
  /** Bóc credential thô → refreshToken (+ profileArn/region nếu có). null = không hợp lệ. */
  parseCredential(value: string): { refreshToken: string; profileArn?: string; region?: string } | null;

  /** Session còn dùng được? (pool chỉ lo dedupe promise, provider tự quyết freshness) */
  sessionFresh(a: ProviderAccount, now: number): boolean;
  sessionOf(a: ProviderAccount): ProviderSession;
  ensureReady(a: ProviderAccount, d?: Dispatcher): Promise<ProviderSession>;

  generate(args: GenArgs): Promise<GenResult>;
  generateStream(args: GenArgs): AsyncGenerator<StreamEvent>;

  /** Token còn sống? (dùng cho health check) */
  checkToken(a: ProviderAccount, d?: Dispatcher): Promise<boolean>;
  /** Gọi thử 1 request nhỏ → còn phục vụ được không. */
  checkLive(a: ProviderAccount, s: ProviderSession, d?: Dispatcher): Promise<LiveResult>;
  /** Kiểm từng model. */
  checkModelsLive(s: ProviderSession, d?: Dispatcher): Promise<{ id: string; status: 'ok' | 'quota' | 'error'; ms: number; detail?: string }[]>;

  /** Chỉ provider có API hạn mức mới cài (agy). Kiro không có → undefined. */
  quota?(a: ProviderAccount, s: ProviderSession, d?: Dispatcher): Promise<QuotaInfo | undefined>;
}

export type { ChatMessage, GenResult, QuotaBucket, QuotaInfo, TokenInfo, ToolCall, ToolDef, Usage };
