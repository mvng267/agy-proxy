// Structured logger thay thế console.log rải rác.
// Format: [agy][LEVEL] message {meta}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Mức đặt từ cấu hình (trang Cấu hình / DB), ưu tiên hơn biến môi trường.
 *
 * Không import `config` ở đây: logger nằm dưới cùng cây phụ thuộc, mọi tầng đều dùng nó —
 * import ngược lên là tạo vòng lặp module. `config.ts` đẩy giá trị xuống thay vì logger
 * tự đi hỏi.
 */
let mucTuConfig: LogLevel | null = null;

export function setLogLevel(v: string): void {
  const s = String(v).toLowerCase();
  mucTuConfig = s in LEVEL_ORDER ? (s as LogLevel) : null;
}

function threshold(): LogLevel {
  if (mucTuConfig) return mucTuConfig;
  const v = (process.env.AGY_LOG_LEVEL || 'info').toLowerCase();
  return (v as LogLevel) in LEVEL_ORDER ? (v as LogLevel) : 'info';
}

function emit(level: LogLevel, msg: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold()]) return;
  const ts = new Date().toISOString();
  const prefix = `[agy][${level.toUpperCase()}]`;
  const metaStr = meta !== undefined ? ' ' + safeStringify(meta) : '';
  const line = `${ts} ${prefix} ${msg}${metaStr}`;
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const logger = {
  debug: (msg: string, meta?: unknown) => emit('debug', msg, meta),
  info: (msg: string, meta?: unknown) => emit('info', msg, meta),
  warn: (msg: string, meta?: unknown) => emit('warn', msg, meta),
  error: (msg: string, meta?: unknown) => emit('error', msg, meta),
};

export default logger;
