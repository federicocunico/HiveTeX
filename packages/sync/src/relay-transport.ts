import { fromB64u, type RelayEnvelope, type RelayFrameContext, type RelaySession, toB64u } from '@hivetex/crypto';
import { FRAGMENT_SIZE } from '@hivetex/protocol';
import { fromUtf8, utf8 } from './frames.js';
import { ASSEMBLY_TIMEOUT_MS, type ChannelName, MAX_MESSAGE_BYTES, MAX_QUEUED_BYTES, type PeerAuthenticationBinding, type PeerTransport } from './transport.js';

/**
 * Wire encoding of the opaque `env` of an app-relay message (base64url only, see isApplicationRelayMessage):
 *  - `H` + base64url(JSON handshake step)
 *  - `F` + 4-digit base36 length of the header + base64url(JSON envelope without ciphertext) + ciphertext
 */
export type RelayWire = { kind: 'handshake'; body: unknown } | { kind: 'frame'; envelope: RelayEnvelope };
export function encodeRelayHandshake(body: unknown): string {
  return `H${toB64u(utf8(JSON.stringify(body)))}`;
}
export function encodeRelayFrame(e: RelayEnvelope): string {
  const { ciphertext, ...header } = e;
  const h = toB64u(utf8(JSON.stringify(header)));
  return `F${h.length.toString(36).padStart(4, '0')}${h}${ciphertext}`;
}
export function decodeRelayWire(env: string): RelayWire | null {
  try {
    if (env.startsWith('H')) return { kind: 'handshake', body: JSON.parse(fromUtf8(fromB64u(env.slice(1)))) };
    if (env.startsWith('F')) {
      const n = Number.parseInt(env.slice(1, 5), 36);
      if (!Number.isSafeInteger(n) || n <= 0 || n > 1024) return null;
      const header = JSON.parse(fromUtf8(fromB64u(env.slice(5, 5 + n)))) as Record<string, unknown>;
      if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
      return { kind: 'frame', envelope: { ...header, ciphertext: env.slice(5 + n) } as RelayEnvelope };
    }
  } catch {
    /* malformed: dropped */
  }
  return null;
}

export interface RelayTransportOptions {
  session: RelaySession;
  /** Hands an encoded frame to the signaling socket; false when the socket is gone (the frame is retried or failed). */
  post(env: string): boolean;
  /** Unacknowledged plaintext allowed in flight towards the peer (D11). Default 64 KiB, including reserved control space. */
  windowBytes?: number;
  /** First retransmission timeout; doubles per retry. Default 1.5 s. */
  rtoMs?: number;
  /** Retransmissions of one fragment before the generation fails. Default 6. */
  maxRetries?: number;
  /** Out-of-order data retained for reassembly beyond the next expected message. Default 4 MiB. */
  reorderBytes?: number;
  /** Acknowledgements are batched for at most this long. Default 20 ms. */
  ackDelayMs?: number;
  assemblyTimeoutMs?: number;
}

/** Delivery state as observed by the sender. A fragment ACK releases credit only; it is not a durable-save receipt. */
export interface RelayTransportStats {
  sentFragments: number;
  retransmits: number;
  ackedFragments: number;
  duplicateFragments: number;
  inflightBytes: number;
  queuedBytes: number;
  /** The server refused forwarding (budget, accounting) and bulk traffic is deferred until this time (epoch ms). */
  limitedUntil: number;
  limitedReason: string | null;
}

interface Outgoing {
  channel: ChannelName;
  data: Uint8Array;
  message: number;
  fragments: number;
  next: number;
  resolve: () => void;
  reject: (e: Error) => void;
}
interface Inflight {
  env: string;
  bytes: number;
  tries: number;
  timer: ReturnType<typeof setTimeout> | null;
}
interface Assembly {
  parts: (Uint8Array | undefined)[];
  got: number;
  bytes: number;
}

const MAX_FRAGMENTS = 4096;
const MAX_MESSAGE_AHEAD = 1024;

/**
 * PeerTransport over the application relay: one confirmed RelaySession, fragments of at most 16 KiB plaintext, per-channel
 * ordering, authenticated acknowledgements, a credit window and bounded retransmission of identical ciphertext. Pub/Sub
 * delivery is at most once, so a published frame counts only once the peer acknowledged it. When delivery cannot recover
 * the transport closes; the mesh then reconnects and reconciles from endpoint state.
 */
export class RelayTransport implements PeerTransport {
  private msgCb: ((c: ChannelName, d: Uint8Array) => void) | null = null;
  /** Messages delivered before the connection registered its handler (bounded by the reassembly budget). */
  private early: Array<[ChannelName, Uint8Array]> = [];
  private earlyBytes = 0;
  private closeCb: () => void = () => {};
  private closeListeners = new Set<() => void>();
  private closed = false;
  private queues: Record<ChannelName, Outgoing[]> = { sync: [], bulk: [] };
  private queued = 0;
  private seq: Record<ChannelName, number> = { sync: 0, bulk: 0 };
  private inflight = new Map<number, Inflight>();
  private inflightBytes = 0;
  private pumping = false;
  private expect: Record<ChannelName, number> = { sync: 0, bulk: 0 };
  private assemblies: Record<ChannelName, Map<number, Assembly>> = { sync: new Map(), bulk: new Map() };
  private reorder = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private acks: number[] = [];
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private limitedTimer: ReturnType<typeof setTimeout> | null = null;
  readonly stats: RelayTransportStats = {
    sentFragments: 0, retransmits: 0, ackedFragments: 0, duplicateFragments: 0, inflightBytes: 0, queuedBytes: 0, limitedUntil: 0, limitedReason: null,
  };
  private readonly window: number;
  private readonly rto: number;
  private readonly maxRetries: number;
  private readonly reorderMax: number;
  private readonly ackDelay: number;
  private readonly assemblyTimeout: number;

  constructor(private o: RelayTransportOptions) {
    this.window = o.windowBytes ?? 64 * 1024;
    this.rto = o.rtoMs ?? 1500;
    this.maxRetries = o.maxRetries ?? 6;
    this.reorderMax = o.reorderBytes ?? 4 * 1024 * 1024;
    this.ackDelay = o.ackDelayMs ?? 20;
    this.assemblyTimeout = o.assemblyTimeoutMs ?? ASSEMBLY_TIMEOUT_MS;
  }

  get authenticationBinding(): PeerAuthenticationBinding {
    return this.o.session.binding;
  }
  /** The confirmed session this transport belongs to (frames of another session are not for it). */
  get sessionId() {
    return this.o.session.id;
  }
  get isClosed() {
    return this.closed;
  }
  /** True while the server refuses forwarding: pending data stays queued with its reason. */
  get limited() {
    return Date.now() < this.stats.limitedUntil;
  }

  onMessage(cb: (c: ChannelName, d: Uint8Array) => void) {
    this.msgCb = cb;
    const early = this.early.splice(0);
    this.earlyBytes = 0;
    for (const [c, d] of early) cb(c, d);
  }
  onClose(cb: () => void) {
    this.closeCb = cb;
  }
  /** Additional observers (the connection manager), independent of the connection's own close handler. */
  onClosed(cb: () => void) {
    if (this.closed) cb();
    else this.closeListeners.add(cb);
  }

  send(channel: ChannelName, data: Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error('relay transport closed'));
    if (data.length > MAX_MESSAGE_BYTES) return Promise.reject(new Error('message too large'));
    if (this.queued + data.length > MAX_QUEUED_BYTES) return Promise.reject(new Error('send queue full'));
    const fragments = Math.max(1, Math.ceil(data.length / FRAGMENT_SIZE));
    if (fragments > MAX_FRAGMENTS) return Promise.reject(new Error('message too large'));
    return new Promise<void>((resolve, reject) => {
      this.queued += data.length;
      this.stats.queuedBytes = this.queued;
      this.queues[channel].push({ channel, data, message: this.seq[channel]++, fragments, next: 0, resolve, reject });
      void this.pump();
    });
  }

  /** The server refused to forward (`relay_limited`, `relay_accounting_unavailable`, rate limits): defer and retry later. */
  noteLimited(reason: string, retryAfterMs: number) {
    if (this.closed) return;
    const until = Date.now() + Math.max(1000, Math.min(retryAfterMs, 60_000));
    if (until <= this.stats.limitedUntil) return;
    this.stats.limitedUntil = until;
    this.stats.limitedReason = reason;
    if (this.limitedTimer) clearTimeout(this.limitedTimer);
    this.limitedTimer = setTimeout(() => {
      this.limitedTimer = null;
      this.stats.limitedReason = null;
      void this.pump();
    }, until - Date.now());
  }

  /** Text and control first; bulk (assets) waits while the relay is limited. */
  private nextOutgoing(): Outgoing | undefined {
    const sync = this.queues.sync[0];
    if (sync) return sync;
    return this.limited ? undefined : this.queues.bulk[0];
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.closed) return;
        const out = this.nextOutgoing();
        if (!out) return;
        const off = out.next * FRAGMENT_SIZE;
        const chunk = out.data.subarray(off, Math.min(off + FRAGMENT_SIZE, out.data.length));
        // Bulk cannot occupy the entire window: a text edit must not wait for an asset's ACK/retry.
        const ceiling = out.channel === 'bulk' ? Math.max(FRAGMENT_SIZE, this.window - Math.min(FRAGMENT_SIZE, this.window / 4)) : this.window;
        if (this.inflight.size > 0 && this.inflightBytes + chunk.length > ceiling) return; // resumed by ACKs
        const ctx: RelayFrameContext = { kind: 'data', channel: out.channel, message: out.message, fragment: out.next, fragments: out.fragments };
        let envelope: RelayEnvelope;
        try {
          envelope = await this.o.session.seal(ctx, chunk);
        } catch (e) {
          this.fail(e instanceof Error ? e : new Error('relay seal failed'));
          return;
        }
        if (this.closed) return;
        const env = encodeRelayFrame(envelope);
        const f: Inflight = { env, bytes: chunk.length, tries: 0, timer: null };
        this.inflight.set(envelope.counter, f);
        this.inflightBytes += chunk.length;
        this.stats.inflightBytes = this.inflightBytes;
        this.stats.sentFragments++;
        this.transmit(envelope.counter, f);
        out.next++;
        if (out.next === out.fragments) {
          this.queues[out.channel].shift();
          this.queued -= out.data.length;
          this.stats.queuedBytes = this.queued;
          out.resolve();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private transmit(counter: number, f: Inflight) {
    if (this.closed) return;
    this.o.post(f.env);
    const wait = this.limited ? Math.max(this.stats.limitedUntil - Date.now(), this.rto) : this.rto * 2 ** f.tries;
    f.timer = setTimeout(() => {
      f.timer = null;
      if (this.closed || this.inflight.get(counter) !== f) return;
      // While the server refuses forwarding the retry waits for its window instead of exhausting the retry budget.
      if (!this.limited && ++f.tries > this.maxRetries) return this.fail(new Error('relay delivery stalled'));
      this.stats.retransmits++;
      this.transmit(counter, f);
    }, wait);
  }

  /** An authenticated envelope of this session (the caller routes by session id). */
  async receive(envelope: RelayEnvelope): Promise<void> {
    if (this.closed) return;
    let opened: Awaited<ReturnType<RelaySession['open']>>;
    try {
      opened = await this.o.session.open(envelope);
    } catch (e) {
      // Forged, stale or wrong-context input is dropped; a full decrypt queue means the peer outran every bound.
      if (e instanceof Error && e.message.includes('queue exceeded')) this.fail(e);
      return;
    }
    if (this.closed) return;
    const { context: c, plaintext, duplicate } = opened;
    if (c.kind === 'ack') {
      if (duplicate) return;
      let list: unknown;
      try {
        list = (JSON.parse(fromUtf8(plaintext)) as { a?: unknown }).a;
      } catch {
        return;
      }
      if (!Array.isArray(list)) return;
      for (const n of list.slice(0, 1024)) this.acked(Number(n));
      void this.pump();
      return;
    }
    if (c.kind === 'control') {
      if (duplicate) return;
      try {
        if ((JSON.parse(fromUtf8(plaintext)) as { close?: unknown }).close === true) this.finish();
      } catch {
        /* unknown control: ignored */
      }
      return;
    }
    // Data: acknowledge every authenticated copy (the first ACK may have been lost), apply it once.
    this.queueAck(envelope.counter);
    if (duplicate) {
      this.stats.duplicateFragments++;
      return;
    }
    this.accept(c, plaintext);
  }

  private acked(counter: number) {
    const f = this.inflight.get(counter);
    if (!f) return;
    if (f.timer) clearTimeout(f.timer);
    this.inflight.delete(counter);
    this.inflightBytes -= f.bytes;
    this.stats.inflightBytes = this.inflightBytes;
    this.stats.ackedFragments++;
  }

  private queueAck(counter: number) {
    this.acks.push(counter);
    if (this.acks.length >= 256) return void this.flushAcks();
    this.ackTimer ??= setTimeout(() => void this.flushAcks(), this.ackDelay);
  }
  private async flushAcks() {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    const a = this.acks.splice(0);
    if (!a.length || this.closed) return;
    try {
      const env = await this.o.session.seal({ kind: 'ack', channel: 'sync', message: 0, fragment: 0, fragments: 1 }, utf8(JSON.stringify({ a })));
      if (!this.closed) this.o.post(encodeRelayFrame(env));
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error('relay ack failed'));
    }
  }

  private accept(c: RelayFrameContext, plaintext: Uint8Array) {
    const channel = c.channel;
    const expected = this.expect[channel];
    if (c.message < expected) return; // already delivered (a retransmission under a new counter cannot happen)
    if (c.message > expected + MAX_MESSAGE_AHEAD || plaintext.length > FRAGMENT_SIZE) return this.fail(new Error('relay framing violation'));
    const map = this.assemblies[channel];
    let a = map.get(c.message);
    if (!a) {
      a = { parts: new Array(c.fragments), got: 0, bytes: 0 };
      map.set(c.message, a);
    } else if (a.parts.length !== c.fragments) return this.fail(new Error('relay fragment count changed'));
    if (a.parts[c.fragment]) return;
    a.parts[c.fragment] = plaintext.slice();
    a.got++;
    a.bytes += plaintext.length;
    if (c.message === expected) {
      if (a.bytes > MAX_MESSAGE_BYTES) return this.fail(new Error('relay message exceeds the assembly budget'));
    } else {
      this.reorder += plaintext.length;
      if (this.reorder > this.reorderMax) return this.fail(new Error('relay reorder budget exceeded'));
    }
    this.deliverReady(channel);
    this.watchGap();
  }

  private deliverReady(channel: ChannelName) {
    const map = this.assemblies[channel];
    for (;;) {
      const a = map.get(this.expect[channel]);
      if (!a || a.got < a.parts.length) break;
      map.delete(this.expect[channel]);
      this.expect[channel]++;
      const out = new Uint8Array(a.bytes);
      let o = 0;
      for (const p of a.parts as Uint8Array[]) {
        out.set(p, o);
        o += p.length;
      }
      // The next message is now the in-order one: its bytes leave the reorder budget.
      const next = map.get(this.expect[channel]);
      if (next) this.reorder -= next.bytes;
      this.emit(channel, out);
      if (this.closed) return;
    }
  }

  private emit(channel: ChannelName, data: Uint8Array) {
    if (this.msgCb) return this.msgCb(channel, data);
    if (this.earlyBytes + data.length > this.reorderMax) return this.fail(new Error('relay early-delivery budget exceeded'));
    this.early.push([channel, data]);
    this.earlyBytes += data.length;
  }

  /** A gap that does not close within the assembly timeout fails the generation (the sender gave up or the path broke). */
  private watchGap() {
    const pending = this.assemblies.sync.size + this.assemblies.bulk.size > 0;
    if (!pending) {
      if (this.gapTimer) clearTimeout(this.gapTimer);
      this.gapTimer = null;
      return;
    }
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = setTimeout(() => this.fail(new Error('relay message incomplete')), this.assemblyTimeout);
  }

  private fail(_e: Error) {
    this.close();
  }

  /** Closes this generation; the peer is told so it does not wait for its retransmission budget. */
  close() {
    if (this.closed) return;
    const session = this.o.session;
    void session
      .seal({ kind: 'control', channel: 'sync', message: 0, fragment: 0, fragments: 1 }, utf8(JSON.stringify({ close: true })))
      .then((env) => this.o.post(encodeRelayFrame(env)))
      .catch(() => {})
      .finally(() => session.close());
    this.finish(false);
  }

  private finish(closeSession = true) {
    if (this.closed) return;
    this.closed = true;
    if (closeSession) this.o.session.close();
    for (const t of [this.gapTimer, this.ackTimer, this.limitedTimer]) if (t) clearTimeout(t);
    for (const f of this.inflight.values()) if (f.timer) clearTimeout(f.timer);
    this.inflight.clear();
    this.inflightBytes = this.reorder = this.queued = 0;
    this.stats.inflightBytes = this.stats.queuedBytes = 0;
    const err = new Error('relay transport closed');
    for (const q of Object.values(this.queues)) for (const out of q.splice(0)) out.reject(err);
    for (const m of Object.values(this.assemblies)) m.clear();
    this.early = [];
    this.closeCb();
    for (const cb of this.closeListeners) cb();
    this.closeListeners.clear();
  }
}
