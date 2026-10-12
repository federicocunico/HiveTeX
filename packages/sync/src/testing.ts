import type { WebSocketLike } from './connect.js';
import type { RtcFactory, RtcPeerLike } from './rtc.js';
import { FakeDataChannel } from './transport.js';

/** In-memory stand-in for the browser's WebRTC stack. Establishes data channels when SDP has been exchanged. */
export class FakeRtcNetwork {
  private pcs = new Map<string, FakePc>();
  /** Process-wide, so peers of separate fake networks never share an id. */
  private static counter = 0;
  readonly factory: RtcFactory = () => new FakePc(this, `pc${++FakeRtcNetwork.counter}`);
  /** When set, SDP fingerprints are rewritten to simulate a signaling-server MITM. */
  tamper: ((sdp: string) => string) | null = null;
  /** The next N connection attempts silently never complete (lost signal / ICE stuck), without a failure event. */
  stallNext = 0;
  register(pc: FakePc) {
    this.pcs.set(pc.id, pc);
  }
  get(id: string) {
    return this.pcs.get(id);
  }
}

type Desc = { type: string; sdp?: string };

export class FakePc implements RtcPeerLike {
  connectionState = 'new';
  localDescription: Desc | null = null;
  remoteDescription: Desc | null = null;
  onicecandidate: RtcPeerLike['onicecandidate'] = null;
  ondatachannel: RtcPeerLike['ondatachannel'] = null;
  onconnectionstatechange: RtcPeerLike['onconnectionstatechange'] = null;
  private created: FakeDataChannel[] = [];
  readonly fingerprint: string;
  constructor(
    private net: FakeRtcNetwork,
    readonly id: string,
  ) {
    this.fingerprint = `FP:${id}:${Math.random().toString(16).slice(2, 10)}`;
    net.register(this);
  }

  private sdp(kind: string) {
    return `v=0\na=x-${kind}\na=x-pcid:${this.id}\na=fingerprint:sha-256 ${this.fingerprint}\n`;
  }
  createDataChannel(label: string) {
    const dc = new FakeDataChannel() as FakeDataChannel & { label: string };
    dc.label = label;
    dc.readyState = 'connecting';
    this.created.push(dc);
    return dc;
  }
  async createOffer() {
    return { type: 'offer', sdp: this.sdp('offer') };
  }
  async createAnswer() {
    return { type: 'answer', sdp: this.sdp('answer') };
  }
  async setLocalDescription(d?: Desc) {
    this.localDescription = d ?? null;
    queueMicrotask(() => this.onicecandidate?.({ candidate: { candidate: `candidate:${this.id}` } }));
  }
  async setRemoteDescription(d: Desc) {
    const sdp = this.net.tamper ? this.net.tamper(d.sdp ?? '') : (d.sdp ?? '');
    this.remoteDescription = { ...d, sdp };
    if (d.type === 'answer') {
      if (this.net.stallNext > 0) {
        this.net.stallNext--;
        return;
      }
      const otherId = /a=x-pcid:(\S+)/.exec(d.sdp ?? '')?.[1] ?? '';
      const other = this.net.get(otherId);
      if (!other) return;
      for (const mine of this.created) {
        const theirs = new FakeDataChannel() as FakeDataChannel & { label: string };
        theirs.label = (mine as unknown as { label: string }).label;
        mine.peer = theirs;
        theirs.peer = mine;
        mine.readyState = 'open';
        theirs.readyState = 'open';
        queueMicrotask(() => {
          other.ondatachannel?.({ channel: theirs });
          mine.onopen?.();
          theirs.onopen?.();
        });
      }
      this.connectionState = other.connectionState = 'connected';
    }
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = 'closed';
    for (const c of this.created) c.close();
  }
}

/** WebSocket facade over a server-side session factory (used to run the real signaling hub in-process). */
export function inProcessSocket(
  attach: (sock: { send(d: string): void; close(code?: number, reason?: string): void }) => {
    onMessage(d: string): void | Promise<void>;
    onClose(): void | Promise<void>;
  },
): WebSocketLike {
  let handlers: ReturnType<typeof attach>;
  const ws: WebSocketLike = {
    readyState: 0,
    send: (d) => void handlers.onMessage(d),
    close: () => {
      if (ws.readyState === 3) return;
      ws.readyState = 3;
      void handlers.onClose();
      queueMicrotask(() => ws.onclose?.());
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  handlers = attach({
    send: (d) => queueMicrotask(() => ws.onmessage?.({ data: d })),
    close: () => ws.close(),
  });
  queueMicrotask(() => {
    ws.readyState = 1;
    ws.onopen?.();
  });
  return ws;
}
