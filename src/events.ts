import { EventEmitter } from 'node:events';

/**
 * Bus sự kiện toàn cục để đẩy log/trạng thái realtime ra dashboard qua SSE.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export interface LogEvent {
  type: 'log';
  runId: number;
  email: string;
  flow: string;
  level: string;
  msg: string;
  screenshot?: string;
  ts: string;
  // Gateway call→response (optional, backward-compatible):
  kind?: 'req' | 'res' | 'err' | 'check';
  model?: string;
  account?: string;
  ms?: number;
  tokens?: number;
  proxy?: string;
  endpoint?: string;
  status?: number;
  attempt?: number;
  /**
   * Tên API key gọi request này, và combo (nếu đi qua combo).
   *
   * Trước đây Live Log chỉ có account + model, nên nhìn một dòng lỗi KHÔNG biết được
   * user nào đang gây ra — phải mở trang Báo cáo lọc thủ công. Gửi kèm tên (không phải
   * id) để dashboard hiển thị thẳng, khỏi phải tra bảng api_keys cho mỗi dòng.
   */
  apiKey?: string;
  combo?: string;
  // Check live/token realtime (kind='check'):
  check?: { kind: 'token' | 'live'; result: string; done?: number; total?: number };
}

export interface RunEvent {
  type: 'run';
  runId: number;
  email: string;
  flow: string;
  status: string; // running|paused_needs_human|ok|failed
  detail?: string;
}

export type AppEvent = LogEvent | RunEvent;

export function emitLog(e: Omit<LogEvent, 'type' | 'ts'>): void {
  bus.emit('event', { type: 'log', ts: new Date().toISOString(), ...e } satisfies LogEvent);
}
export function emitRun(e: Omit<RunEvent, 'type'>): void {
  bus.emit('event', { type: 'run', ...e } satisfies RunEvent);
}
