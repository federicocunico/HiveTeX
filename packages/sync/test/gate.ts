import type { ChannelName, PeerTransport } from '../src/transport.js';

/**
 * Wraps a transport's outgoing side so tests can withhold, count, reorder and release frames: the delayed and
 * replayed replies that real networks produce.
 */
export class Gate implements PeerTransport {
  closed = false;
  /** Frames sent through while `bypass` is set are never withheld. */
  bypass = false;
  held: Array<{ channel: ChannelName; data: Uint8Array }> = [];
  sent = 0;
  sentTypes = new Map<number, number>();
  constructor(private inner: PeerTransport) {}
  get authenticationBinding() {
    return this.inner.authenticationBinding;
  }
  get localFingerprint() {
    return this.inner.localFingerprint;
  }
  get remoteFingerprint() {
    return this.inner.remoteFingerprint;
  }
  async send(channel: ChannelName, data: Uint8Array) {
    this.sent++;
    const type = (data[0] ?? 0) & 0x7f;
    this.sentTypes.set(type, (this.sentTypes.get(type) ?? 0) + 1);
    if (this.closed && !this.bypass) {
      this.held.push({ channel, data });
      return;
    }
    return this.inner.send(channel, data);
  }
  onMessage(cb: (channel: ChannelName, data: Uint8Array) => void) {
    this.inner.onMessage(cb);
  }
  onClose(cb: () => void) {
    this.inner.onClose(cb);
  }
  close() {
    this.inner.close();
  }
  /** Removes and returns what is withheld so far. */
  take() {
    return this.held.splice(0);
  }
  async deliver(items: Array<{ channel: ChannelName; data: Uint8Array }>) {
    for (const i of items) await this.inner.send(i.channel, i.data);
  }
  /** Opens the gate and delivers everything withheld, in order. */
  async release() {
    this.closed = false;
    await this.deliver(this.take());
  }
}
