import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { parseEventStream, EventStreamParser, framesToText } from '../../src/gateway/eventstream.js';

/**
 * Encoder viết RIÊNG trong test (không dùng chung code với decoder)
 * → mọi case là round-trip thật, không phải tự khớp với chính mình.
 */
function encodeFrame(headers: Record<string, string>, payload: string | Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const body = typeof payload === 'string' ? enc.encode(payload) : payload;

  const hparts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k);
    const val = enc.encode(v);
    const b = new Uint8Array(1 + name.length + 1 + 2 + val.length);
    const dv = new DataView(b.buffer);
    let p = 0;
    b[p++] = name.length;
    b.set(name, p); p += name.length;
    b[p++] = 7; // string
    dv.setUint16(p, val.length); p += 2;
    b.set(val, p);
    hparts.push(b);
  }
  const hlen = hparts.reduce((s, x) => s + x.length, 0);
  const total = 12 + hlen + body.length + 4;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  dv.setUint32(4, hlen);
  dv.setUint32(8, crc32(out.subarray(0, 8)) >>> 0);
  let p = 12;
  for (const h of hparts) { out.set(h, p); p += h.length; }
  out.set(body, p); p += body.length;
  dv.setUint32(total - 4, crc32(out.subarray(0, total - 4)) >>> 0);
  return out;
}

const H = { ':event-type': 'assistantResponseEvent', ':content-type': 'application/json', ':message-type': 'event' };

function concat(...arrs: Uint8Array[]): Uint8Array {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let p = 0;
  for (const a of arrs) { out.set(a, p); p += a.length; }
  return out;
}

test('1 frame: giải mã header + payload', () => {
  const buf = encodeFrame(H, '{"content":"Hey","modelId":"claude-sonnet-4"}');
  const { frames, rest } = parseEventStream(buf);
  assert.equal(frames.length, 1);
  assert.equal(rest.length, 0);
  assert.equal(frames[0]!.event, 'assistantResponseEvent');
  assert.equal(frames[0]!.messageType, 'event');
  assert.equal(frames[0]!.headers[':content-type'], 'application/json');
  assert.equal(new TextDecoder().decode(frames[0]!.payload), '{"content":"Hey","modelId":"claude-sonnet-4"}');
});

test('nhiều frame trong 1 buffer', () => {
  const buf = concat(
    encodeFrame(H, '{"content":"A"}'),
    encodeFrame(H, '{"content":"B"}'),
    encodeFrame(H, '{"content":"C"}'),
  );
  const { frames } = parseEventStream(buf);
  assert.equal(frames.length, 3);
  assert.equal(framesToText(frames), 'ABC');
});

test('frame vỡ qua ranh giới chunk — cắt GIỮA PRELUDE', () => {
  const full = concat(encodeFrame(H, '{"content":"xin"}'), encodeFrame(H, '{"content":" chao"}'));
  const p = new EventStreamParser();
  assert.equal(p.push(full.subarray(0, 6)).length, 0, 'chưa đủ prelude → chưa có frame');
  assert.ok(p.pending > 0);
  const rest = p.push(full.subarray(6));
  assert.equal(framesToText(rest), 'xin chao');
  assert.equal(p.pending, 0);
});

test('frame vỡ qua ranh giới chunk — cắt GIỮA PAYLOAD', () => {
  const f = encodeFrame(H, '{"content":"payload dai hon mot chut"}');
  const cut = f.length - 9;
  const p = new EventStreamParser();
  assert.equal(p.push(f.subarray(0, cut)).length, 0);
  const frames = p.push(f.subarray(cut));
  assert.equal(frames.length, 1);
  assert.equal(framesToText(frames), 'payload dai hon mot chut');
});

test('nhiều chunk 1 byte một (worst case)', () => {
  const f = encodeFrame(H, '{"content":"abc"}');
  const p = new EventStreamParser();
  let got: string = '';
  for (let i = 0; i < f.length; i++) got += framesToText(p.push(f.subarray(i, i + 1)));
  assert.equal(got, 'abc');
});

test('CRC prelude sai → ném lỗi (stream lệch pha)', () => {
  const f = encodeFrame(H, '{"content":"x"}');
  f[9] = (f[9]! ^ 0xff) & 0xff; // phá prelude crc
  assert.throws(() => parseEventStream(f), /CRC prelude sai/);
});

test('CRC message sai → ném lỗi khi strict', () => {
  const f = encodeFrame(H, '{"content":"x"}');
  f[f.length - 1] = (f[f.length - 1]! ^ 0xff) & 0xff;
  assert.throws(() => parseEventStream(f), /CRC message sai/);
  assert.doesNotThrow(() => parseEventStream(f, { strict: false }));
});

test('total_length hỏng → ném lỗi, không OOM', () => {
  const f = encodeFrame(H, '{"content":"x"}');
  new DataView(f.buffer).setUint32(0, 0x7fffffff);
  assert.throws(() => parseEventStream(f), /total_length không hợp lệ/);
});

test('frame exception → framesToText ném lỗi', () => {
  const buf = encodeFrame(
    { ':message-type': 'exception', ':exception-type': 'ThrottlingException' },
    '{"message":"slow down"}',
  );
  const { frames } = parseEventStream(buf);
  assert.throws(() => framesToText(frames), /ThrottlingException/);
});

test('frame không phải JSON → bỏ qua, không vỡ', () => {
  const buf = concat(
    encodeFrame(H, 'khong-phai-json'),
    encodeFrame(H, '{"content":"ok"}'),
  );
  assert.equal(framesToText(parseEventStream(buf).frames), 'ok');
});

test('đuôi dở dang được giữ trong rest', () => {
  const full = concat(encodeFrame(H, '{"content":"1"}'), encodeFrame(H, '{"content":"2"}'));
  const partial = full.subarray(0, full.length - 5);
  const { frames, rest } = parseEventStream(partial);
  assert.equal(frames.length, 1);
  assert.ok(rest.length > 0);
});
