import { COMPRESSED_FLAG, COMPRESS_THRESHOLD } from '@hivetex/protocol';

const enc = new TextEncoder();
const dec = new TextDecoder();
export const MAX_DECOMPRESSED = 64 * 1024 * 1024;

export const utf8 = (s: string) => enc.encode(s);
export const fromUtf8 = (b: Uint8Array) => dec.decode(b);
export const jsonBytes = (v: unknown) => enc.encode(JSON.stringify(v));
export const parseJson = <T>(b: Uint8Array): T => JSON.parse(dec.decode(b)) as T;

async function pump(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) {
      await reader.cancel();
      throw new Error('decompressed frame too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function transform(data: Uint8Array, t: CompressionStream | DecompressionStream, limit: number) {
  const w = t.writable.getWriter();
  const read = pump(t.readable as ReadableStream<Uint8Array>, limit);
  w.write(data as unknown as BufferSource).catch(() => {});
  w.close().catch(() => {});
  return read;
}

export const deflate = (d: Uint8Array) => transform(d, new CompressionStream('deflate-raw'), MAX_DECOMPRESSED);
export const inflate = (d: Uint8Array) => transform(d, new DecompressionStream('deflate-raw'), MAX_DECOMPRESSED);

/** Encodes [type][payload], deflating payloads over the threshold unless `noCompress` (already-compressed data). */
export async function encodeFrame(type: number, payload: Uint8Array, noCompress = false): Promise<Uint8Array> {
  let body = payload;
  let t = type;
  if (!noCompress && payload.length > COMPRESS_THRESHOLD) {
    const z = await deflate(payload);
    if (z.length < payload.length) {
      body = z;
      t = type | COMPRESSED_FLAG;
    }
  }
  const out = new Uint8Array(body.length + 1);
  out[0] = t;
  out.set(body, 1);
  return out;
}

export async function decodeFrame(frame: Uint8Array): Promise<{ type: number; payload: Uint8Array }> {
  if (frame.length < 1) throw new Error('empty frame');
  const raw = frame[0] as number;
  const body = frame.subarray(1);
  if (raw & COMPRESSED_FLAG) return { type: raw & ~COMPRESSED_FLAG, payload: await inflate(body) };
  return { type: raw, payload: body };
}

/** Doc payload: [idLen u16 BE][docId][data]. */
export function packDoc(docId: string, data: Uint8Array): Uint8Array {
  const id = enc.encode(docId);
  const out = new Uint8Array(2 + id.length + data.length);
  out[0] = id.length >> 8;
  out[1] = id.length & 255;
  out.set(id, 2);
  out.set(data, 2 + id.length);
  return out;
}

export function unpackDoc(payload: Uint8Array): { docId: string; data: Uint8Array } {
  const len = ((payload[0] as number) << 8) | (payload[1] as number);
  if (2 + len > payload.length) throw new Error('bad doc frame');
  return { docId: dec.decode(payload.subarray(2, 2 + len)), data: payload.subarray(2 + len) };
}
