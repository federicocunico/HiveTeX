import { BUFFER_HIGH_WATER, FRAGMENT_SIZE } from '@hivetex/protocol';

export type ChannelName = 'sync' | 'bulk';

/** A connected, encrypted link to one peer (WebRTC in production, loopback in tests). */
export interface PeerTransport {
  /** DTLS fingerprints of both ends; bound into the authentication handshake. */
  readonly localFingerprint: string;
  readonly remoteFingerprint: string;
  /** Resolves once the message is queued and the channel buffer is below the high-water mark. */
  send(channel: ChannelName, data: Uint8Array): Promise<void>;
  onMessage(cb: (channel: ChannelName, data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** Subset of RTCDataChannel that we depend on (also implemented by test fakes and the Rust bridge). */
export interface DataChannelLike {
  readyState: 'connecting' | 'open' | 'closing' | 'closed';
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array }) => void) | null;
  onclose: (() => void) | null;
  onbufferedamountlow: (() => void) | null;
  onopen?: (() => void) | null;
  label?: string;
}

const F_SINGLE = 0;
const F_FIRST = 1;
const F_LAST = 3;

/** Fragmenting, backpressured, reassembling wrapper around one ordered reliable data channel. */
export class FragmentedChannel {
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private sendChain: Promise<void> = Promise.resolve();
  /** Observed peak of bufferedAmount, for tests and metrics. */
  maxBuffered = 0;

  constructor(
    private dc: DataChannelLike,
    private onData: (data: Uint8Array) => void,
  ) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_HIGH_WATER / 2;
    dc.onmessage = (ev) => this.receive(ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data));
  }

  private waitDrain(): Promise<void> {
    if (this.dc.bufferedAmount <= BUFFER_HIGH_WATER) return Promise.resolve();
    return new Promise((resolve) => {
      const prev = this.dc.onbufferedamountlow;
      this.dc.onbufferedamountlow = () => {
        this.dc.onbufferedamountlow = prev;
        prev?.();
        resolve();
      };
    });
  }

  send(data: Uint8Array): Promise<void> {
    // Serialize sends so fragments of different messages never interleave.
    const run = async () => {
      const total = data.length;
      if (total <= FRAGMENT_SIZE) {
        await this.put(F_SINGLE, data);
        return;
      }
      for (let off = 0; off < total; off += FRAGMENT_SIZE) {
        const end = Math.min(off + FRAGMENT_SIZE, total);
        const kind = off === 0 ? F_FIRST : end === total ? F_LAST : 2;
        await this.put(kind, data.subarray(off, end));
      }
    };
    const p = this.sendChain.then(run);
    this.sendChain = p.catch(() => {});
    return p;
  }

  private async put(kind: number, chunk: Uint8Array) {
    if (this.dc.readyState !== 'open') throw new Error('channel closed');
    await this.waitDrain();
    const out = new Uint8Array(chunk.length + 1);
    out[0] = kind;
    out.set(chunk, 1);
    this.dc.send(out);
    this.maxBuffered = Math.max(this.maxBuffered, this.dc.bufferedAmount);
  }

  private receive(buf: Uint8Array) {
    const kind = buf[0];
    const body = buf.subarray(1);
    if (kind === F_SINGLE) return this.onData(body);
    if (kind === F_FIRST) {
      this.parts = [body];
      this.partBytes = body.length;
      return;
    }
    this.parts.push(body);
    this.partBytes += body.length;
    if (kind === F_LAST) {
      const out = new Uint8Array(this.partBytes);
      let o = 0;
      for (const p of this.parts) {
        out.set(p, o);
        o += p.length;
      }
      this.parts = [];
      this.partBytes = 0;
      this.onData(out);
    }
  }
}

/** PeerTransport over two data channels: `sync` (control + CRDT) and `bulk` (blobs, PDFs). */
export class DataChannelTransport implements PeerTransport {
  private msgCb: (c: ChannelName, d: Uint8Array) => void = () => {};
  private closeCb: () => void = () => {};
  private sync: FragmentedChannel;
  private bulk: FragmentedChannel;
  private closed = false;
  private dcs: DataChannelLike[];

  constructor(
    syncDc: DataChannelLike,
    bulkDc: DataChannelLike,
    readonly localFingerprint: string,
    readonly remoteFingerprint: string,
    private dispose: () => void = () => {},
  ) {
    this.sync = new FragmentedChannel(syncDc, (d) => this.msgCb('sync', d));
    this.bulk = new FragmentedChannel(bulkDc, (d) => this.msgCb('bulk', d));
    const fire = () => {
      if (this.closed) return;
      this.closed = true;
      this.closeCb();
    };
    syncDc.onclose = fire;
    bulkDc.onclose = fire;
    this.dcs = [syncDc, bulkDc];
  }

  get peakBuffered() {
    return Math.max(this.sync.maxBuffered, this.bulk.maxBuffered);
  }
  send(channel: ChannelName, data: Uint8Array) {
    return (channel === 'sync' ? this.sync : this.bulk).send(data);
  }
  onMessage(cb: (c: ChannelName, d: Uint8Array) => void) {
    this.msgCb = cb;
  }
  onClose(cb: () => void) {
    this.closeCb = cb;
  }
  close() {
    for (const dc of this.dcs) dc.close();
    this.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------------------------

/** In-memory data channel that drains its buffer at a limited rate, to exercise backpressure. */
export class FakeDataChannel implements DataChannelLike {
  readyState: DataChannelLike['readyState'] = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  onmessage: DataChannelLike['onmessage'] = null;
  onclose: DataChannelLike['onclose'] = null;
  onbufferedamountlow: DataChannelLike['onbufferedamountlow'] = null;
  onopen: (() => void) | null = null;
  peer!: FakeDataChannel;
  private draining = false;

  constructor(private bytesPerTick = 256 * 1024) {}

  send(data: Uint8Array) {
    this.bufferedAmount += data.length;
    const copy = data.slice();
    queueMicrotask(() => this.peer.onmessage?.({ data: copy }));
    this.scheduleDrain();
  }
  private scheduleDrain() {
    if (this.draining) return;
    this.draining = true;
    setTimeout(() => {
      this.draining = false;
      const before = this.bufferedAmount;
      this.bufferedAmount = Math.max(0, this.bufferedAmount - this.bytesPerTick);
      if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.onbufferedamountlow?.();
      }
      if (this.bufferedAmount > 0) this.scheduleDrain();
    }, 0);
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    if (this.peer) {
      this.peer.readyState = 'closed';
      this.peer.onclose?.();
    }
  }
}

export function fakeChannelPair(bytesPerTick?: number): [FakeDataChannel, FakeDataChannel] {
  const a = new FakeDataChannel(bytesPerTick);
  const b = new FakeDataChannel(bytesPerTick);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** Node's setImmediate when available (not in browsers, where this transport is not used for timing). */
const setImmediateFn = (globalThis as { setImmediate?: (cb: () => void) => unknown }).setImmediate;

class Loopback implements PeerTransport {
  peer!: Loopback;
  closed = false;
  private msgCb: (c: ChannelName, d: Uint8Array) => void = () => {};
  private closeCb: () => void = () => {};
  constructor(
    readonly localFingerprint: string,
    readonly remoteFingerprint: string,
    private delivery: { immediate?: boolean; latencyMs?: number } = {},
  ) {}
  deliver(c: ChannelName, d: Uint8Array) {
    if (!this.closed) this.msgCb(c, d);
  }
  fireClose() {
    if (this.closed) return;
    this.closed = true;
    this.closeCb();
  }
  send(c: ChannelName, d: Uint8Array) {
    if (this.closed) return Promise.reject(new Error('closed'));
    const copy = d.slice();
    const peer = this.peer;
    const { immediate, latencyMs } = this.delivery;
    if (latencyMs) setTimeout(() => peer.deliver(c, copy), latencyMs);
    // setImmediate keeps FIFO order without the ~15.6 ms clamp Windows applies to setTimeout(0) (benchmarks).
    else if (immediate && setImmediateFn) setImmediateFn(() => peer.deliver(c, copy));
    else setTimeout(() => peer.deliver(c, copy), 0);
    return Promise.resolve();
  }
  onMessage(cb: (c: ChannelName, d: Uint8Array) => void) {
    this.msgCb = cb;
  }
  onClose(cb: () => void) {
    this.closeCb = cb;
  }
  close() {
    this.fireClose();
    setTimeout(() => this.peer.fireClose(), 0);
  }
}

/**
 * Direct in-memory transport pair. `seenBy*` override what each side believes the other's fingerprint is;
 * `immediate` delivers without timer clamping and `latencyMs` simulates one-way network delay (benchmarks).
 */
export function loopbackPair(
  opts: { fpA?: string; fpB?: string; seenByA?: string; seenByB?: string; immediate?: boolean; latencyMs?: number } = {},
): [PeerTransport, PeerTransport] {
  const fpA = opts.fpA ?? 'AA:AA';
  const fpB = opts.fpB ?? 'BB:BB';
  const delivery = { ...(opts.immediate ? { immediate: true } : {}), ...(opts.latencyMs ? { latencyMs: opts.latencyMs } : {}) };
  const a = new Loopback(fpA, opts.seenByA ?? fpB, delivery);
  const b = new Loopback(fpB, opts.seenByB ?? fpA, delivery);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
