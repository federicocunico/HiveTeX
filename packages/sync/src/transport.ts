import { BUFFER_HIGH_WATER, FRAGMENT_SIZE } from '@hivetex/protocol';
import { MAX_DECOMPRESSED } from './frames.js';

export type ChannelName = 'sync' | 'bulk';

/** Transport-specific material covered by the peer's device-key possession proof. */
export type PeerAuthenticationBinding =
  | { readonly kind: "dtls"; readonly localFingerprint: string; readonly remoteFingerprint: string }
  | {
      readonly kind: "relay";
      /** SHA-256 of the mutually authenticated ephemeral relay handshake transcript (base64url). */
      readonly transcriptHash: string;
      readonly localRole: "initiator" | "responder";
    };

/** A connected, encrypted link to one peer. Relay implementations must complete key confirmation before exposure. */
export interface PeerTransport {
  /** Explicit on new transports. Absent only for legacy DTLS adapters. */
  readonly authenticationBinding?: PeerAuthenticationBinding | undefined;
  /** Legacy DTLS adapter compatibility; never synthesize fingerprints for a relay. */
  readonly localFingerprint?: string | undefined;
  readonly remoteFingerprint?: string | undefined;
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
  onerror?: (() => void) | null;
  onopen?: (() => void) | null;
  label?: string;
}

const F_SINGLE = 0;
const F_FIRST = 1;
const F_MIDDLE = 2;
const F_LAST = 3;

/** Largest reassembled message: the decoded-frame limit plus framing overhead (checked before any decompression). */
export const MAX_MESSAGE_BYTES = MAX_DECOMPRESSED + 1024;
/**
 * Bytes one channel may hold between `send()` and the data reaching the RTC buffer: two maximum messages, so a
 * 20 MiB transfer or a full 32 MiB document update fits with room for control traffic behind it.
 */
export const MAX_QUEUED_BYTES = 2 * MAX_MESSAGE_BYTES;
/** A partly received message is dropped when no further fragment arrives for this long. */
export const ASSEMBLY_TIMEOUT_MS = 30_000;

export interface FragmentedChannelOptions {
  maxMessageBytes?: number;
  maxQueuedBytes?: number;
  /** Idle time allowed between fragments of one message. */
  assemblyTimeoutMs?: number;
  /** The peer broke the framing rules; the channel has already been aborted. */
  onViolation?: (reason: string) => void;
}

/** Fragmenting, backpressured, reassembling wrapper around one ordered reliable data channel. */
export class FragmentedChannel {
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private sendChain: Promise<void> = Promise.resolve();
  /** Set once the channel closed, errored, or was aborted; every pending and later send rejects with it. */
  private failure: Error | null = null;
  private queued = 0;
  private assemblyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxMessage: number;
  private readonly maxQueued: number;
  private readonly assemblyTimeout: number;
  private readonly onViolation: (reason: string) => void;
  /** Observed peak of queued outbound bytes, for tests and metrics. */
  maxQueuedSeen = 0;
  private drainWaiters = new Set<{ resolve: () => void; reject: (e: Error) => void }>();
  /** Observed peak of bufferedAmount, for tests and metrics. */
  maxBuffered = 0;

  constructor(
    private dc: DataChannelLike,
    private onData: (data: Uint8Array) => void,
    opts: FragmentedChannelOptions = {},
  ) {
    this.maxMessage = opts.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.maxQueued = opts.maxQueuedBytes ?? MAX_QUEUED_BYTES;
    this.assemblyTimeout = opts.assemblyTimeoutMs ?? ASSEMBLY_TIMEOUT_MS;
    this.onViolation = opts.onViolation ?? (() => {});
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_HIGH_WATER / 2;
    dc.onmessage = (ev) => this.receive(ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data));
    dc.onbufferedamountlow = () => {
      for (const w of [...this.drainWaiters]) w.resolve();
    };
  }

  /** Fails the channel: the draining send rejects now, queued sends reject when their turn comes, later sends reject at once. */
  abort(reason: Error = new Error('channel closed')) {
    this.failure ??= reason;
    this.dropAssembly();
    for (const w of [...this.drainWaiters]) w.reject(this.failure);
    this.drainWaiters.clear();
  }

  private async waitDrain(): Promise<void> {
    while (this.dc.bufferedAmount > BUFFER_HIGH_WATER) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve, reject) => {
        const w = {
          resolve: () => {
            this.drainWaiters.delete(w);
            resolve();
          },
          reject: (e: Error) => {
            this.drainWaiters.delete(w);
            reject(e);
          },
        };
        this.drainWaiters.add(w);
      });
    }
    if (this.failure) throw this.failure;
  }

  send(data: Uint8Array): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.queued + data.length > this.maxQueued) return Promise.reject(new Error('send queue full'));
    this.queued += data.length;
    this.maxQueuedSeen = Math.max(this.maxQueuedSeen, this.queued);
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
    const p = this.sendChain.then(run).finally(() => {
      this.queued -= data.length;
    });
    this.sendChain = p.catch(() => {});
    return p;
  }

  private async put(kind: number, chunk: Uint8Array) {
    if (this.failure) throw this.failure;
    if (this.dc.readyState !== 'open') throw new Error('channel closed');
    await this.waitDrain();
    const out = new Uint8Array(chunk.length + 1);
    out[0] = kind;
    out.set(chunk, 1);
    this.dc.send(out);
    this.maxBuffered = Math.max(this.maxBuffered, this.dc.bufferedAmount);
  }

  /** Outbound bytes accepted by `send()` that have not yet reached the RTC buffer. */
  get queuedBytes() {
    return this.queued;
  }
  /** Bytes of the partly received message currently retained. */
  get assembledBytes() {
    return this.partBytes;
  }

  private dropAssembly() {
    this.parts = [];
    this.partBytes = 0;
    if (this.assemblyTimer) clearTimeout(this.assemblyTimer);
    this.assemblyTimer = null;
  }

  private violate(reason: string) {
    this.abort(new Error(`protocol violation: ${reason}`));
    this.onViolation(reason);
  }

  private receive(buf: Uint8Array) {
    if (this.failure) return;
    if (buf.length < 1) return this.violate('empty fragment');
    if (buf.length > FRAGMENT_SIZE + 1) return this.violate('oversized fragment');
    const kind = buf[0] as number;
    const body = buf.subarray(1);
    const assembling = this.parts.length > 0;
    if (kind === F_SINGLE) {
      if (assembling) return this.violate('message started inside a fragmented message');
      return this.onData(body);
    }
    if (kind === F_FIRST) {
      if (assembling) return this.violate('fragmented message started twice');
    } else if (kind === F_MIDDLE || kind === F_LAST) {
      if (!assembling) return this.violate('fragment without a start');
    } else return this.violate('unknown fragment kind');
    if (this.partBytes + body.length > this.maxMessage) return this.violate('message exceeds the assembly budget');
    this.parts.push(body);
    this.partBytes += body.length;
    if (this.assemblyTimer) clearTimeout(this.assemblyTimer);
    this.assemblyTimer = null;
    if (kind === F_LAST) {
      const out = new Uint8Array(this.partBytes);
      let o = 0;
      for (const p of this.parts) {
        out.set(p, o);
        o += p.length;
      }
      this.dropAssembly();
      this.onData(out);
    } else {
      this.assemblyTimer = setTimeout(() => this.violate('incomplete message timed out'), this.assemblyTimeout);
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
  /** The selected ICE path once known: a TURN server, a direct pair, or not reported by the RTC implementation. */
  path: 'direct' | 'turn' | 'unknown' = 'unknown';

  constructor(
    syncDc: DataChannelLike,
    bulkDc: DataChannelLike,
    readonly localFingerprint: string,
    readonly remoteFingerprint: string,
    private dispose: () => void = () => {},
    limits: Omit<FragmentedChannelOptions, 'onViolation'> = {},
  ) {
    // A framing violation poisons only this peer's transport; the mesh and its other peers carry on.
    const bad = () => this.close();
    this.sync = new FragmentedChannel(syncDc, (d) => this.msgCb('sync', d), { ...limits, onViolation: bad });
    this.bulk = new FragmentedChannel(bulkDc, (d) => this.msgCb('bulk', d), { ...limits, onViolation: bad });
    const fire = () => {
      // Settle pending sends first so nothing waits on a drain event that a dead channel never delivers.
      this.sync.abort();
      this.bulk.abort();
      if (this.closed) return;
      this.closed = true;
      this.closeCb();
    };
    syncDc.onclose = fire;
    bulkDc.onclose = fire;
    syncDc.onerror = fire;
    bulkDc.onerror = fire;
    this.dcs = [syncDc, bulkDc];
  }

  get authenticationBinding(): PeerAuthenticationBinding {
    return {
      kind: "dtls",
      localFingerprint: this.localFingerprint,
      remoteFingerprint: this.remoteFingerprint,
    };
  }

  get peakBuffered() {
    return Math.max(this.sync.maxBuffered, this.bulk.maxBuffered);
  }
  get peakQueued() {
    return Math.max(this.sync.maxQueuedSeen, this.bulk.maxQueuedSeen);
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
    this.sync.abort(new Error('transport closed'));
    this.bulk.abort(new Error('transport closed'));
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
