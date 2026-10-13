import type { RtcFactory, RtcPeerLike } from './rtc.js';
import type { DataChannelLike } from './transport.js';

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type Listen = (event: string, cb: (payload: BridgeEvent) => void) => Promise<() => void>;

export type BridgeEvent =
  | { kind: 'ice'; candidate: unknown }
  | { kind: 'state'; state: string }
  /** The ICE agent's own state (checking, connected, disconnected, failed ...). */
  | { kind: 'ice-state'; state: string }
  /** The selected candidate pair changed: candidate types and protocol only. */
  | { kind: 'pair'; local: string; remote: string; protocol: string }
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
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private dead = false;

  constructor(
    readonly label: string,
    private peer: TauriPeer,
  ) {}

  send(data: Uint8Array) {
    if (this.dead) throw new Error('channel closed');
    // The IPC is asynchronous: count bytes that have not reached Rust yet so back-pressure keeps working.
    this.pending += data.length;
    const copy = data.slice();
    this.chain = this.chain
      .then(async () => {
        // After a failure nothing further may be sent: a gap would corrupt the fragment stream on the wire.
        if (this.dead) return;
        const buffered = await this.peer.call<number>('rtc_send', { label: this.label, b64: toB64(copy) });
        if (this.dead) return;
        this.rustBuffered = buffered;
        this.pending -= copy.length;
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) queueMicrotask(() => this.onbufferedamountlow?.());
      })
      // A failed IPC send means bytes were lost: close the channel so the owning connection and every pending send fail
      // instead of this message being treated as delivered.
      .catch(() => this.terminate(true));
  }

  /** Marks the channel dead (idempotent), drops queued IPC work and tells the owner via error then close. */
  terminate(notify: boolean) {
    if (this.dead) return;
    this.dead = true;
    this.readyState = 'closed';
    this.pending = 0;
    this.rustBuffered = 0;
    if (!notify) return;
    this.onerror?.();
    this.onclose?.();
  }

  close() {
    this.terminate(true);
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
  iceConnectionState = 'new';
  oniceconnectionstatechange: (() => void) | null = null;
  onselectedpairchange: ((p: { local: string; remote: string; protocol: string }) => void) | null = null;
  private channels = new Map<string, BridgeChannel>();
  private ready: Promise<void>;
  private unlisten: (() => void) | null = null;
  private closed = false;
  readonly id = `p${Date.now().toString(36)}${(counter++).toString(36)}`;

  constructor(
    private invoke: Invoke,
    listen: Listen,
    iceServers: unknown[],
    policy?: 'all' | 'relay',
  ) {
    this.ready = (async () => {
      this.unlisten = await listen(`rtc://${this.id}`, (e) => this.onEvent(e));
      if (this.closed) { this.unlisten(); return; }
      await this.invoke('rtc_create', { id: this.id, ice: iceServers, ...(policy === 'relay' ? { policy } : {}) });
      if (this.closed) await this.invoke('rtc_close', {id:this.id});
    })();
    this.ready.catch(() => this.fail());
  }

  private fail() {
    if (this.closed) return;
    this.connectionState = 'failed';
    this.terminateChannels();
    this.onconnectionstatechange?.();
  }

  call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
    return this.ready.then(() => {
      if (this.closed && cmd !== 'rtc_close') throw new Error('peer closed');
      return this.invoke<T>(cmd, { id: this.id, ...args });
    });
  }

  private onEvent(e: BridgeEvent) {
    if (this.closed) return;
    if (e.kind === 'ice') this.onicecandidate?.({ candidate: e.candidate });
    else if (e.kind === 'ice-state') {
      this.iceConnectionState = e.state.toLowerCase();
      this.oniceconnectionstatechange?.();
    } else if (e.kind === 'pair') this.onselectedpairchange?.({ local: e.local, remote: e.remote, protocol: e.protocol });
    else if (e.kind === 'state') {
      this.connectionState = e.state.toLowerCase();
      // The native connection is gone: nothing queued on its channels will ever be delivered.
      if (this.connectionState === 'failed' || this.connectionState === 'closed') this.terminateChannels();
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
        ch.terminate(true);
      } else if (e.kind === 'message') ch.onmessage?.({ data: fromB64(e.b64) });
      else if (e.kind === 'bufferedlow') {
        ch.rustBuffered = 0;
        ch.onbufferedamountlow?.();
      }
    }
  }

  private terminateChannels() {
    for (const ch of this.channels.values()) ch.terminate(true);
  }

  createDataChannel(label: string) {
    const ch = new BridgeChannel(label, this);
    this.channels.set(label, ch);
    void this.call('rtc_create_data_channel', { label }).catch(() => this.fail());
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
  /** The selected candidate pair as standard statistics (native: `rtc_stats`); an older native side has none. */
  async getStats() {
    const list = (await this.call<Record<string, unknown>[] | null>('rtc_stats', {}).catch(() => null)) ?? [];
    return { forEach: (cb: (s: Record<string, unknown>) => void) => list.forEach(cb) };
  }
  async addIceCandidate(c: unknown) {
    await this.call('rtc_add_ice', { candidate: c });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    this.terminateChannels();
    void this.call('rtc_close', {}).catch(() => {});
    this.unlisten?.();
  }
}

/** An RtcFactory backed by the Rust WebRTC stack (used when the webview lacks `RTCPeerConnection`). */
export function tauriRtcFactory(invoke: Invoke, listen: Listen): RtcFactory {
  return (iceServers, opts) => new TauriPeer(invoke, listen, iceServers, opts?.policy);
}
