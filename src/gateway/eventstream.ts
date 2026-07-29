import { crc32 } from 'node:zlib';

/**
 * Parser AWS binary Event Stream (application/vnd.amazon.eventstream) — dùng cho Kiro/CodeWhisperer.
 *
 * Khung 1 frame:
 *   [0..4)   total_length   uint32 BE
 *   [4..8)   headers_length uint32 BE
 *   [8..12)  prelude_crc    = CRC32 của byte [0,8)
 *   [12..12+H) headers
 *   [12+H..total-4) payload
 *   [total-4..total) message_crc = CRC32 của byte [0, total-4)
 *
 * Header: uint8 name_len | name(utf8) | uint8 value_type | value
 *   type 0=true 1=false 2=int8 3=int16 4=int32 5=int64 6=bytes(uint16+data)
 *        7=string(uint16+utf8) 8=timestamp(int64 ms) 9=uuid(16B)
 */

const MAX_FRAME = 16 * 1024 * 1024; // chặn total_length hỏng gây OOM

export type HeaderValue = string | number | boolean | bigint | Uint8Array;

export interface EventFrame {
  headers: Record<string, HeaderValue>;
  payload: Uint8Array;
  event: string; // headers[':event-type']
  messageType: string; // headers[':message-type']
}

function u32(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) >>> 0) + (b[off + 1]! << 16) + (b[off + 2]! << 8) + b[off + 3]!;
}

function parseHeaders(b: Uint8Array, start: number, end: number): Record<string, HeaderValue> {
  const out: Record<string, HeaderValue> = {};
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const dec = new TextDecoder();
  let p = start;
  while (p < end) {
    const nameLen = b[p]!;
    p += 1;
    const name = dec.decode(b.subarray(p, p + nameLen));
    p += nameLen;
    const type = b[p]!;
    p += 1;
    switch (type) {
      case 0: out[name] = true; break;
      case 1: out[name] = false; break;
      case 2: out[name] = dv.getInt8(p); p += 1; break;
      case 3: out[name] = dv.getInt16(p); p += 2; break;
      case 4: out[name] = dv.getInt32(p); p += 4; break;
      case 5: out[name] = dv.getBigInt64(p); p += 8; break;
      case 6: {
        const len = dv.getUint16(p); p += 2;
        out[name] = b.subarray(p, p + len); p += len;
        break;
      }
      case 7: {
        const len = dv.getUint16(p); p += 2;
        out[name] = dec.decode(b.subarray(p, p + len)); p += len;
        break;
      }
      case 8: out[name] = Number(dv.getBigInt64(p)); p += 8; break;
      case 9: out[name] = b.subarray(p, p + 16); p += 16; break;
      default:
        throw new Error(`event-stream: header type lạ ${type} tại byte ${p}`);
    }
  }
  return out;
}

/**
 * Giải mã MỌI frame hoàn chỉnh trong buf; trả phần đuôi chưa đủ.
 * Ném lỗi khi CRC prelude sai (stream lệch pha → mọi byte sau đều rác).
 */
export function parseEventStream(buf: Uint8Array, opts: { strict?: boolean } = {}): { frames: EventFrame[]; rest: Uint8Array } {
  const strict = opts.strict !== false;
  const frames: EventFrame[] = [];
  let off = 0;
  while (buf.length - off >= 16) {
    const total = u32(buf, off);
    const headersLen = u32(buf, off + 4);
    if (total < 16 || total > MAX_FRAME) throw new Error(`event-stream: total_length không hợp lệ (${total})`);
    if (headersLen > total - 16) throw new Error(`event-stream: headers_length không hợp lệ (${headersLen}/${total})`);
    if (buf.length - off < total) break; // chưa đủ frame → để lại cho lần push sau

    const preludeCrc = u32(buf, off + 8);
    const gotPrelude = crc32(buf.subarray(off, off + 8)) >>> 0;
    if (gotPrelude !== preludeCrc) throw new Error('event-stream: CRC prelude sai (stream lệch pha)');

    if (strict) {
      const msgCrc = u32(buf, off + total - 4);
      const gotMsg = crc32(buf.subarray(off, off + total - 4)) >>> 0;
      if (gotMsg !== msgCrc) throw new Error('event-stream: CRC message sai');
    }

    const hStart = off + 12;
    const headers = parseHeaders(buf, hStart, hStart + headersLen);
    const payload = buf.subarray(hStart + headersLen, off + total - 4);
    frames.push({
      headers,
      payload,
      event: String(headers[':event-type'] ?? ''),
      messageType: String(headers[':message-type'] ?? ''),
    });
    off += total;
  }
  return { frames, rest: buf.subarray(off) };
}

/** Bọc stateful: nối chunk, trả frame hoàn chỉnh mỗi lần push. */
export class EventStreamParser {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): EventFrame[] {
    if (this.buf.length === 0) {
      this.buf = chunk;
    } else {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
    }
    const { frames, rest } = parseEventStream(this.buf);
    this.buf = rest;
    return frames;
  }

  get pending(): number {
    return this.buf.length;
  }
}

/**
 * Rút text từ các frame Kiro. Ném lỗi nếu gặp frame exception.
 * Payload dạng {"content":"…","modelId":"…"}.
 */
export function framesToText(frames: EventFrame[]): string {
  const dec = new TextDecoder();
  let out = '';
  for (const f of frames) {
    if (f.messageType === 'exception' || f.event === 'error') {
      const body = dec.decode(f.payload);
      const kind = String(f.headers[':exception-type'] ?? f.event ?? 'exception');
      throw new Error(`Kiro ${kind}: ${body.slice(0, 200)}`);
    }
    if (!f.payload.length) continue;
    try {
      const j = JSON.parse(dec.decode(f.payload)) as { content?: string };
      if (typeof j.content === 'string') out += j.content;
    } catch {
      /* frame không phải JSON (metadata) → bỏ qua */
    }
  }
  return out;
}
