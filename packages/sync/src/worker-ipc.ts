/**
 * Supervisor <-> worker protocol (D1, 6.1). Frames on inherited pipes: a 4-byte big-endian length, then UTF-8 JSON.
 * Every message carries the protocol version and the worker generation it belongs to; requests carry an id and may be
 * cancelled. Unknown versions, unknown methods, malformed or oversized frames and messages of an obsolete generation are
 * rejected without being acted on. The same codec is implemented on the Rust side (src-tauri/src/worker.rs).
 */

export const WORKER_PROTOCOL = 1;
/** Largest frame accepted in either direction (payload bytes after the length prefix). */
export const MAX_FRAME = 8 * 1024 * 1024;
/** Bounded logical storage message; each pipe frame still respects MAX_FRAME. */
export const MAX_MESSAGE = 160 * 1024 * 1024;
const MORE = 0x80000000, CONTINUATION = 0x40000000, LENGTH = 0x3fffffff;

export type WireMessage =
  | { v: 1; gen: number; kind: 'req'; id: number; method: string; params?: unknown }
  | { v: 1; gen: number; kind: 'res'; id: number; ok: true; result?: unknown }
  | { v: 1; gen: number; kind: 'res'; id: number; ok: false; error: { code: string; message: string } }
  | { v: 1; gen: number; kind: 'evt'; event: string; data?: unknown }
  | { v: 1; gen: number; kind: 'cancel'; id: number };

export class ProtocolError extends Error {
  constructor(
    readonly code: 'frame_too_large' | 'malformed' | 'version' | 'generation' | 'unknown_method' | 'closed',
    message: string,
  ) {
    super(message);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function encodeFrame(m: WireMessage): Uint8Array {
  const body = enc.encode(JSON.stringify(m));
  if (body.length > MAX_MESSAGE) throw new ProtocolError('frame_too_large', `message of ${body.length} bytes`);
  const count = Math.max(1, Math.ceil(body.length / MAX_FRAME));
  const out = new Uint8Array(body.length + 4 * count), view = new DataView(out.buffer);
  for (let part = 0, offset = 0; part < count; part++) {
    const start = part * MAX_FRAME, chunk = body.subarray(start, start + MAX_FRAME);
    view.setUint32(offset, (chunk.length | (part ? CONTINUATION : 0) | (part < count - 1 ? MORE : 0)) >>> 0);
    out.set(chunk, offset + 4); offset += chunk.length + 4;
  }
  return out;
}

/** Validates the shape of a decoded message; throws ProtocolError otherwise. */
export function validateMessage(x: unknown): WireMessage {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new ProtocolError('malformed', 'not an object');
  const m = x as Record<string, unknown>;
  if (m.v !== WORKER_PROTOCOL) throw new ProtocolError('version', `unsupported protocol version ${String(m.v)}`);
  if (!Number.isSafeInteger(m.gen) || (m.gen as number) < 0) throw new ProtocolError('malformed', 'bad generation');
  const id = () => Number.isSafeInteger(m.id) && (m.id as number) >= 0;
  switch (m.kind) {
    case 'req':
      if (!id() || typeof m.method !== 'string' || m.method.length === 0 || m.method.length > 64) throw new ProtocolError('malformed', 'bad request');
      return m as WireMessage;
    case 'res':
      if (!id() || typeof m.ok !== 'boolean') throw new ProtocolError('malformed', 'bad response');
      if (m.ok === false) {
        const e = m.error as { code?: unknown; message?: unknown } | undefined;
        if (!e || typeof e.code !== 'string' || typeof e.message !== 'string') throw new ProtocolError('malformed', 'bad error');
      }
      return m as WireMessage;
    case 'evt':
      if (typeof m.event !== 'string' || m.event.length === 0 || m.event.length > 64) throw new ProtocolError('malformed', 'bad event');
      return m as WireMessage;
    case 'cancel':
      if (!id()) throw new ProtocolError('malformed', 'bad cancel');
      return m as WireMessage;
  }
  throw new ProtocolError('malformed', 'unknown kind');
}

/**
 * Incremental frame decoder. `push` returns the messages completed by a chunk. An oversized length or an undecodable
 * frame throws: the stream is then unrecoverable (framing is lost) and the caller must close the pipe.
 */
export class FrameReader {
  private buf = new Uint8Array(0);
  private fragments: Uint8Array[] = [];
  private fragmentBytes = 0;
  constructor(private maxMessageBytes = MAX_MESSAGE) {}
  push(chunk: Uint8Array): WireMessage[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out: WireMessage[] = [];
    let offset = 0;
    for (;;) {
      if (this.buf.length - offset < 4) break;
      const header = new DataView(this.buf.buffer, this.buf.byteOffset + offset).getUint32(0);
      const len = header & LENGTH, more = (header & MORE) !== 0, continuation = (header & CONTINUATION) !== 0;
      if (len > MAX_FRAME) throw new ProtocolError('frame_too_large', `announced frame of ${len} bytes`);
      if (this.buf.length - offset < 4 + len) break;
      let body = this.buf.subarray(offset + 4, offset + 4 + len);
      offset += 4 + len;
      if (continuation !== (this.fragments.length > 0) || ((more || continuation) && len === 0)) throw new ProtocolError('malformed', 'invalid fragment sequence');
      if (more || continuation) {
        this.fragmentBytes += body.length;
        if (this.fragmentBytes > Math.min(MAX_MESSAGE, this.maxMessageBytes)) throw new ProtocolError('frame_too_large', 'assembled message too large');
        this.fragments.push(body.slice());
        if (more) continue;
        const joined = new Uint8Array(this.fragmentBytes); let at = 0;
        for (const part of this.fragments) { joined.set(part, at); at += part.length; }
        body = joined; this.fragments = []; this.fragmentBytes = 0;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(dec.decode(body));
      } catch {
        throw new ProtocolError('malformed', 'frame is not UTF-8 JSON');
      }
      out.push(validateMessage(parsed));
    }
    this.buf = this.buf.slice(offset);
    return out;
  }
  get buffered() {
    return this.buf.length + this.fragmentBytes;
  }
}

export type Handler = (params: unknown, signal: AbortSignal) => Promise<unknown> | unknown;

/**
 * One end of the pipe: typed requests with ids and cancellation, responses, and events, all bound to a generation.
 * Messages of another generation are dropped (a late answer of a replaced worker cannot reach the new one).
 */
export class RpcEndpoint {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private running = new Map<number, AbortController>();
  private handlers = new Map<string, Handler>();
  private eventCbs = new Map<string, Set<(data: unknown) => void>>();
  private reader = new FrameReader();
  private closed = false;
  readonly rejected: Array<{ code: string; message: string }> = [];

  constructor(
    private o: { gen: number; write: (frame: Uint8Array) => void; onFatal?: (e: ProtocolError) => void; maxPending?: number },
  ) {}

  get generation() {
    return this.o.gen;
  }

  handle(method: string, h: Handler) {
    this.handlers.set(method, h);
  }
  on(event: string, cb: (data: unknown) => void) {
    const s = this.eventCbs.get(event) ?? new Set();
    s.add(cb);
    this.eventCbs.set(event, s);
    return () => void s.delete(cb);
  }

  private send(m: WireMessage) {
    if (this.closed) throw new ProtocolError('closed', 'endpoint closed');
    this.o.write(encodeFrame(m));
  }

  request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new ProtocolError('closed', 'endpoint closed'));
    if (this.pending.size >= (this.o.maxPending ?? 1024)) return Promise.reject(new Error('too many requests in flight'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        reject(new Error('cancelled'));
        if (!this.closed) this.send({ v: 1, gen: this.o.gen, kind: 'cancel', id });
      }, { once: true });
      try {
        this.send({ v: 1, gen: this.o.gen, kind: 'req', id, method, ...(params === undefined ? {} : { params }) });
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  emit(event: string, data?: unknown) {
    this.send({ v: 1, gen: this.o.gen, kind: 'evt', event, ...(data === undefined ? {} : { data }) });
  }

  /** Feeds bytes read from the pipe. A framing error is fatal: everything pending fails and onFatal is called. */
  receive(chunk: Uint8Array) {
    if (this.closed) return;
    let messages: WireMessage[];
    try {
      messages = this.reader.push(chunk);
    } catch (e) {
      const err = e instanceof ProtocolError ? e : new ProtocolError('malformed', String(e));
      this.rejected.push({ code: err.code, message: err.message });
      this.close(err);
      this.o.onFatal?.(err);
      return;
    }
    for (const m of messages) this.dispatch(m);
  }

  private dispatch(m: WireMessage) {
    if (m.gen !== this.o.gen) {
      this.rejected.push({ code: 'generation', message: `message of generation ${m.gen}` });
      return;
    }
    if (m.kind === 'res') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
    } else if (m.kind === 'evt') {
      for (const cb of this.eventCbs.get(m.event) ?? []) cb(m.data);
    } else if (m.kind === 'cancel') {
      this.running.get(m.id)?.abort();
    } else {
      const h = this.handlers.get(m.method);
      if (!h) {
        this.rejected.push({ code: 'unknown_method', message: m.method });
        this.send({ v: 1, gen: this.o.gen, kind: 'res', id: m.id, ok: false, error: { code: 'unknown_method', message: `unknown method ${m.method}` } });
        return;
      }
      const ctl = new AbortController();
      this.running.set(m.id, ctl);
      void Promise.resolve()
        .then(() => h(m.params, ctl.signal))
        .then(
          (result) => {
            if (!ctl.signal.aborted && !this.closed) this.send({ v: 1, gen: this.o.gen, kind: 'res', id: m.id, ok: true, ...(result === undefined ? {} : { result }) });
          },
          (e: unknown) => {
            if (ctl.signal.aborted || this.closed) return;
            const code = (e as { code?: unknown })?.code;
            this.send({ v: 1, gen: this.o.gen, kind: 'res', id: m.id, ok: false, error: { code: typeof code === 'string' ? code : 'error', message: e instanceof Error ? e.message : String(e) } });
          },
        )
        .finally(() => this.running.delete(m.id));
    }
  }

  /** Fails every pending request and aborts every running handler. */
  close(reason: Error = new ProtocolError('closed', 'endpoint closed')) {
    if (this.closed) return;
    this.closed = true;
    this.reader = new FrameReader();
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
    for (const c of this.running.values()) c.abort();
    this.running.clear();
  }
}

/**
 * Removes secrets from a diagnostic line before it is logged: JWS tokens (tickets, ring and session tokens), bearer
 * values, long base64/hex runs (keys, ciphertext) and push topics. Project content must never be passed in at all.
 */
export function redactDiagnostics(line: string): string {
  return line
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[token]')
    .replace(/\b(Bearer|bearer)\s+\S+/g, '$1 [redacted]')
    .replace(/\bht[a-z2-7]{26}\b/g, '[topic]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[hex]')
    .replace(/[A-Za-z0-9+/_-]{43,}={0,2}/g, '[b64]');
}
