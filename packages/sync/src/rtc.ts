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

  constructor(
    private o: {
      factory: RtcFactory;
      iceServers: unknown[];
      initiator: boolean;
      send: (s: LinkSignal) => void;
      onTransport: (t: PeerTransport) => void;
      onFail: (why: string) => void;
    },
  ) {
    this.pc = o.factory(o.iceServers);
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) o.send({ k: 'ice', candidate: ev.candidate });
    };
    this.pc.onconnectionstatechange = () => {
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
    this.o.onTransport(new DataChannelTransport(s, b, local, remote, () => this.pc.close()));
  }

  async start() {
    if (!this.o.initiator) return;
    this.adopt('sync', this.pc.createDataChannel('sync', { ordered: true }));
    this.adopt('bulk', this.pc.createDataChannel('bulk', { ordered: true }));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.o.send({ k: 'offer', sdp: this.pc.localDescription?.sdp ?? offer.sdp ?? '' });
  }

  async handle(s: LinkSignal) {
    try {
      if (s.k === 'offer' && !this.o.initiator) {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
        this.remoteSet = true;
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.o.send({ k: 'answer', sdp: this.pc.localDescription?.sdp ?? '' });
        await this.flushIce();
      } else if (s.k === 'answer' && this.o.initiator) {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
        this.remoteSet = true;
        await this.flushIce();
        this.maybeReady();
      } else if (s.k === 'ice') {
        if (this.remoteSet) await this.pc.addIceCandidate(s.candidate);
        else this.pendingIce.push(s.candidate);
      }
    } catch (e) {
      if (!this.done) {
        this.done = true;
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
