import { DataChannelTransport, type DataChannelLike, type PeerTransport } from './transport.js';

/** The subset of RTCPeerConnection we use; the browser/webview implementation satisfies it. */
export interface RtcPeerLike {
  connectionState: string;
  localDescription: { type: string; sdp?: string } | null;
  remoteDescription: { type: string; sdp?: string } | null;
  createDataChannel(label: string, opts?: { ordered?: boolean }): DataChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(d?: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(d: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(c: unknown): Promise<void>;
  close(): void;
  onicecandidate: ((ev: { candidate: unknown | null }) => void) | null;
  ondatachannel: ((ev: { channel: DataChannelLike & { label: string } }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  /** ICE agent state, when the implementation reports it. */
  iceConnectionState?: string;
  /** Standard RTCPeerConnection statistics, when the implementation has them (used to tell TURN from direct). */
  getStats?(): Promise<{ forEach(cb: (s: Record<string, unknown>) => void): void }>;
}

/**
 * Whether the selected ICE candidate pair runs through a TURN server ('turn'), directly ('direct'), or cannot be told.
 * Reads only candidate types, never addresses.
 */
export async function selectedPath(pc: RtcPeerLike): Promise<'direct' | 'turn' | 'unknown'> {
  const pair = await selectedPair(pc);
  if (!pair) return 'unknown';
  if (pair.local === 'relay' || pair.remote === 'relay') return 'turn';
  return pair.local !== 'unknown' && pair.remote !== 'unknown' ? 'direct' : 'unknown';
}

/** The candidate types (host, srflx, prflx, relay) of the selected pair, or null when not reported. No addresses. */
export async function selectedPair(pc: RtcPeerLike): Promise<{ local: string; remote: string } | null> {
  if (!pc.getStats) return null;
  try {
    const report = await pc.getStats();
    const byId = new Map<string, Record<string, unknown>>();
    let selectedId: unknown;
    report.forEach((s) => {
      byId.set(String(s.id), s);
      if (s.type === 'transport' && s.selectedCandidatePairId) selectedId = s.selectedCandidatePairId;
    });
    let pair = selectedId ? byId.get(String(selectedId)) : undefined;
    if (!pair) for (const s of byId.values()) if (s.type === 'candidate-pair' && (s.selected === true || (s.nominated === true && s.state === 'succeeded'))) pair = s;
    if (!pair) return null;
    const type = (id: unknown) => {
      const t = byId.get(String(id))?.candidateType;
      return typeof t === 'string' ? t : 'unknown';
    };
    return { local: type(pair.localCandidateId), remote: type(pair.remoteCandidateId) };
  } catch {
    return null;
  }
}

/** What one link has seen so far: enough to say why it did not come up. Types only, never addresses. */
export interface LinkDiag {
  /** ICE agent state when the implementation reports it, else the connection state. */
  state: string;
  offerReceived: boolean;
  offerSent: boolean;
  answerReceived: boolean;
  /** Candidate types (host, srflx, prflx, relay, unknown) gathered here / received from the other device, in order. */
  localCandidates: string[];
  remoteCandidates: string[];
}

/** The type of a candidate object or SDP line: host, srflx, prflx or relay; 'unknown' when it cannot be told. */
export function candidateType(c: unknown): string {
  const o = c as { type?: unknown; candidate?: unknown } | string | null;
  const line = typeof o === 'string' ? o : typeof o?.candidate === 'string' ? o.candidate : '';
  const m = /\btyp (host|srflx|prflx|relay)\b/.exec(line);
  if (m) return m[1] as string;
  return typeof o === 'object' && o && typeof o.type === 'string' ? o.type : 'unknown';
}

export type RtcFactory = (iceServers: unknown[]) => RtcPeerLike;

export type LinkSignal =
  | { k: 'offer'; sdp: string }
  | { k: 'answer'; sdp: string }
  | { k: 'ice'; candidate: unknown };

const FP_RE = /a=fingerprint:(\S+) (\S+)/;
export const fingerprintOf = (sdp?: string): string => FP_RE.exec(sdp ?? '')?.[2] ?? '';

/**
 * One WebRTC link to one remote device. The initiator creates the two data channels
 * (`sync`, `bulk`) and the offer; the other side answers. When both channels are open, the
 * DTLS fingerprints from the two SDPs are handed to the transport so the application-layer
 * handshake can bind the peer's identity to *this* encrypted connection.
 */
export class RtcLink {
  private pc: RtcPeerLike;
  private channels = new Map<string, DataChannelLike>();
  private pendingIce: unknown[] = [];
  private remoteSet = false;
  private done = false;
  private seen: LinkDiag = { state: 'new', offerReceived: false, offerSent: false, answerReceived: false, localCandidates: [], remoteCandidates: [] };

  /** What this link has seen so far (for the attempt's failure cause and the diagnostics page). */
  diag(): LinkDiag {
    return { ...this.seen, state: this.pc.iceConnectionState ?? this.pc.connectionState, localCandidates: [...this.seen.localCandidates], remoteCandidates: [...this.seen.remoteCandidates] };
  }

  constructor(
    private o: {
      factory: RtcFactory;
      iceServers: unknown[];
      initiator: boolean;
      send: (s: LinkSignal) => void;
      onTransport: (t: PeerTransport) => void;
      onFail: (why: string) => void;
      /** Optional trace of this link's steps (see ConnectionManager's trace option). */
      trace?: (ev: string, data?: Record<string, string | number | boolean>) => void;
    },
  ) {
    this.pc = o.factory(o.iceServers);
    this.pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      this.seen.localCandidates.push(candidateType(ev.candidate));
      o.trace?.('ice.local', { type: candidateType(ev.candidate) });
      o.send({ k: 'ice', candidate: ev.candidate });
    };
    this.pc.onconnectionstatechange = () => {
      o.trace?.('state', { connection: this.pc.connectionState, ice: this.pc.iceConnectionState ?? 'n/a' });
      if (['failed', 'closed', 'disconnected'].includes(this.pc.connectionState) && !this.done) {
        this.done = true;
        o.onFail(`connection ${this.pc.connectionState}`);
      }
    };
    this.pc.ondatachannel = (ev) => this.adopt(ev.channel.label, ev.channel);
  }

  private adopt(label: string, dc: DataChannelLike) {
    this.channels.set(label, dc);
    const check = () => this.maybeReady();
    dc.onopen = check;
    check();
  }

  private maybeReady() {
    const s = this.channels.get('sync');
    const b = this.channels.get('bulk');
    if (this.done || !s || !b || s.readyState !== 'open' || b.readyState !== 'open') return;
    const local = fingerprintOf(this.pc.localDescription?.sdp);
    const remote = fingerprintOf(this.pc.remoteDescription?.sdp);
    this.done = true;
    const t = new DataChannelTransport(s, b, local, remote, () => this.pc.close());
    this.o.trace?.('channels.open');
    void selectedPair(this.pc).then((p) => {
      this.o.trace?.('route', { local: p?.local ?? 'n/a', remote: p?.remote ?? 'n/a' });
      t.pair = p;
      t.path = !p ? 'unknown' : p.local === 'relay' || p.remote === 'relay' ? 'turn' : p.local !== 'unknown' && p.remote !== 'unknown' ? 'direct' : 'unknown';
    });
    this.o.onTransport(t);
  }

  async start() {
    if (!this.o.initiator) return;
    this.adopt('sync', this.pc.createDataChannel('sync', { ordered: true }));
    this.adopt('bulk', this.pc.createDataChannel('bulk', { ordered: true }));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.seen.offerSent = true;
    this.o.trace?.('offer.sent');
    this.o.send({ k: 'offer', sdp: this.pc.localDescription?.sdp ?? offer.sdp ?? '' });
  }

  async handle(s: LinkSignal) {
    try {
      if (s.k === 'offer' && !this.o.initiator) {
        this.seen.offerReceived = true;
        this.o.trace?.('offer.received');
        await this.pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
        this.remoteSet = true;
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.o.send({ k: 'answer', sdp: this.pc.localDescription?.sdp ?? '' });
        this.o.trace?.('answer.sent');
        await this.flushIce();
      } else if (s.k === 'answer' && this.o.initiator) {
        this.seen.answerReceived = true;
        this.o.trace?.('answer.received');
        await this.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
        this.remoteSet = true;
        await this.flushIce();
        this.maybeReady();
      } else if (s.k === 'ice') {
        this.seen.remoteCandidates.push(candidateType(s.candidate));
        this.o.trace?.('ice.remote', { type: candidateType(s.candidate), applied: this.remoteSet });
        if (this.remoteSet) await this.pc.addIceCandidate(s.candidate);
        else this.pendingIce.push(s.candidate);
      }
    } catch (e) {
      if (!this.done) {
        this.done = true;
        this.o.trace?.('signal.error', { message: e instanceof Error ? e.message.slice(0, 120) : 'error' });
        this.o.onFail(e instanceof Error ? e.message : 'signal error');
      }
    }
  }

  private async flushIce() {
    for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c);
  }

  close() {
    this.done = true;
    this.pc.close();
  }
}
