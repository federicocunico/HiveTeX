import type { RtcFactory, RtcPeerLike } from './rtc.js';
import type { DataChannelLike } from './transport.js';

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type Listen = (event: string, cb: (payload: BridgeEvent) => void) => Promise<() => void>;

export type BridgeEvent =
  | { kind: 'ice'; candidate: unknown }
  | { kind: 'state'; state: string }
  | { kind: 'datachannel'; label: string }
  | { kind: 'open'; label: string }
  | { kind: 'close'; label: string }
  | { kind: 'message'; label: string; b64: string }
  | { kind: 'bufferedlow'; label: string };

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let counter = 0;

class BridgeChannel implements DataChannelLike {
  readyState: DataChannelLike['readyState'] = 'connecting';
  /** Bytes not yet handed to Rust plus Rust's own send buffer. */
  get bufferedAmount() {
    return this.pending + this.rustBuffered;
  }
  private pending = 0;
  rustBuffered = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  onmessage: DataChannelLike['onmessage'] = null;
  onclose: DataChannelLike['onclose'] = null;
  onbufferedamountlow: DataChannelLike['onbufferedamountlow'] = null;
  onopen: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly label: string,
    private peer: TauriPeer,
  ) {}

  send(data: Uint8Array) {
    // The IPC is asynchronous: count bytes that have not reached Rust yet so back-pressure keeps working.
    this.pending += data.length;
    const copy = data.slice();
    this.chain = this.chain
      .then(async () => {
        this.rustBuffered = await this.peer.call<number>('rtc_send', { label: this.label, b64: toB64(copy) });
        this.pending -= copy.length;
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) queueMicrotask(() => this.onbufferedamountlow?.());
      })
      .catch(() => {
        this.pending = 0;
        this.rustBuffered = 0;
      });
  }

  close() {
    this.readyState = 'closed';
    void this.peer.call('rtc_close', {}).catch(() => {});
  }
}

/** RTCPeerConnection-shaped wrapper over the Rust `rtc_*` commands. */
class TauriPeer implements RtcPeerLike {
  connectionState = 'new';
  localDescription: RtcPeerLike['localDescription'] = null;
  remoteDescription: RtcPeerLike['remoteDescription'] = null;
  onicecandidate: RtcPeerLike['onicecandidate'] = null;
  ondatachannel: RtcPeerLike['ondatachannel'] = null;
  onconnectionstatechange: RtcPeerLike['onconnectionstatechange'] = null;
  private channels = new Map<string, BridgeChannel>();
  private ready: Promise<void>;
  private unlisten: (() => void) | null = null;
  private closed = false;
  readonly id = `p${Date.now().toString(36)}${(counter++).toString(36)}`;

  constructor(
    private invoke: Invoke,
    listen: Listen,
    iceServers: unknown[],
  ) {
    this.ready = (async () => {
      this.unlisten = await listen(`rtc://${this.id}`, (e) => this.onEvent(e));
      await this.invoke('rtc_create', { id: this.id, ice: iceServers });
    })();
    this.ready.catch(() => {});
  }

  call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    return this.ready.then(() => this.invoke<T>(cmd, { id: this.id, ...args }));
  }

  private onEvent(e: BridgeEvent) {
    if (e.kind === 'ice') this.onicecandidate?.({ candidate: e.candidate });
    else if (e.kind === 'state') {
      this.connectionState = e.state.toLowerCase();
      this.onconnectionstatechange?.();
    } else if (e.kind === 'datachannel') {
      const ch = this.channels.get(e.label) ?? new BridgeChannel(e.label, this);
      this.channels.set(e.label, ch);
      this.ondatachannel?.({ channel: ch });
    } else {
      const ch = this.channels.get(e.label);
      if (!ch) return;
      if (e.kind === 'open') {
        ch.readyState = 'open';
        ch.onopen?.();
      } else if (e.kind === 'close') {
        ch.readyState = 'closed';
        ch.onclose?.();
      } else if (e.kind === 'message') ch.onmessage?.({ data: fromB64(e.b64) });
      else if (e.kind === 'bufferedlow') {
        ch.rustBuffered = 0;
        ch.onbufferedamountlow?.();
      }
    }
  }

  createDataChannel(label: string) {
    const ch = new BridgeChannel(label, this);
    this.channels.set(label, ch);
    void this.call('rtc_create_data_channel', { label });
    return ch;
  }

  async createOffer() {
    return { type: 'offer', sdp: await this.call<string>('rtc_create_offer', {}) };
  }
  async createAnswer() {
    return { type: 'answer', sdp: await this.call<string>('rtc_create_answer', {}) };
  }
  async setLocalDescription(d?: { type: string; sdp?: string }) {
    if (!d?.sdp) throw new Error('setLocalDescription needs a description');
    await this.call('rtc_set_local', { kind: d.type, sdp: d.sdp });
    this.localDescription = { type: d.type, sdp: d.sdp };
  }
  async setRemoteDescription(d: { type: string; sdp?: string }) {
    await this.call('rtc_set_remote', { kind: d.type, sdp: d.sdp ?? '' });
    this.remoteDescription = { type: d.type, ...(d.sdp ? { sdp: d.sdp } : {}) };
  }
  async addIceCandidate(c: unknown) {
    await this.call('rtc_add_ice', { candidate: c });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    void this.call('rtc_close', {}).catch(() => {});
    this.unlisten?.();
  }
}

/** An RtcFactory backed by the Rust WebRTC stack (used when the webview lacks `RTCPeerConnection`). */
export function tauriRtcFactory(invoke: Invoke, listen: Listen): RtcFactory {
  return (iceServers) => new TauriPeer(invoke, listen, iceServers);
}
