import { type StoredDeviceKeys, fromB64u, open, seal, sign, toB64u, verifyTicket } from '@p2platex/crypto';
import { type TicketClaims, type TrustedKey, signalAuthMessage } from '@p2platex/protocol';
import { fromUtf8, utf8 } from './frames.js';
import type { Mesh, PeerInfo } from './mesh.js';
import { type LinkSignal, RtcLink, type RtcFactory } from './rtc.js';

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface ManagerOptions {
  mesh: Mesh;
  projectId: string;
  keys: StoredDeviceKeys;
  trusted: TrustedKey[];
  getTicket: () => string;
  signalUrl: string;
  wsFactory: (url: string) => WebSocketLike;
  rtcFactory: RtcFactory;
  getIceServers: () => Promise<unknown[]>;
  now?: () => Date;
  /** The relay closes sockets after ~300 s; reconnect slightly earlier. */
  reconnectAfterMs?: number;
  idleCloseMs?: number;
  /** A link that has not produced a transport within this time is abandoned and retried. Default 20 s. */
  linkTimeoutMs?: number;
}

const WS_OPEN = 1;

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

interface Known {
  claims: TicketClaims;
  raw: string;
}

/**
 * Finds and connects peers with minimal use of the control plane:
 *  - a device with no peers opens the signaling socket (only then);
 *  - one "gatekeeper" per connected mesh (lowest device id) keeps a socket open so newcomers can reach it;
 *  - everyone else is introduced through the mesh (peer exchange) and negotiates over existing links,
 *    so SDP/ICE for most connections never touches the server.
 * All signaling payloads are end-to-end encrypted between the two devices.
 */
export class ConnectionManager {
  private ws: WebSocketLike | null = null;
  private known = new Map<string, Known>();
  /** Devices currently attached to the relay (so we only use it for targets that can hear us there). */
  private onRelay = new Set<string>();
  /** Latest signaling session id seen joining, per device (to ignore leaves of older sessions). */
  private sessions = new Map<string, string>();
  /**
   * Devices announced again (relay join, peer exchange) while we still had a mesh link to them: that device most likely
   * restarted (a reloaded tab) and our link is stale. Once the stale link drops, we must reach it again even if we no
   * longer listen on the relay, or neither side would ever offer.
   */
  private reannounced = new Set<string>();
  private links = new Map<string, RtcLink>();
  /** Failed or stalled link attempts per device, for retry backoff (reset when the peer connects). */
  private attempts = new Map<string, number>();
  private iceServers: Promise<unknown[]> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private stopped = true;
  private selfDev: string;
  readonly stats = { socketOpens: 0, signalsViaServer: 0, signalsViaMesh: 0 };

  constructor(private o: ManagerOptions) {
    this.selfDev = JSON.parse(fromUtf8(fromB64u(o.getTicket().split('.')[1] ?? ''))).dev as string;
    o.mesh.onPeerJoin((p) => this.onPeerJoin(p));
    o.mesh.onPeerLeave((p) => {
      this.evaluate();
      // The peer may simply have restarted: try to reach it again shortly (bounded by the link attempt itself).
      setTimeout(() => {
        const known = this.known.get(p.deviceId);
        const back = this.onRelay.has(p.deviceId) || this.reannounced.delete(p.deviceId);
        if (known && !this.stopped && back) this.maybeConnect(known);
      }, 1500);
    });
    o.mesh.onApp('pex', (from, body) => void this.onPex(from, body as { tickets: string[] }));
    o.mesh.onApp('rtc', (from, body) => void this.onRtcViaMesh(from, body as RtcEnvelope));
  }

  get socketOpen() {
    return this.ws?.readyState === WS_OPEN;
  }

  start() {
    this.stopped = false;
    this.evaluate();
  }

  stop() {
    this.stopped = true;
    for (const t of [this.idleTimer, this.rotateTimer, this.retryTimer]) if (t) clearTimeout(t);
    this.ws?.close();
    this.ws = null;
    for (const l of this.links.values()) l.close();
    this.links.clear();
  }

  // ---- when do we need the control plane? ----

  private amGatekeeper() {
    const peers = this.o.mesh.peers;
    return peers.length > 0 && peers.every((p) => p.deviceId > this.selfDev);
  }

  private wantSocket() {
    return this.o.mesh.peers.length === 0 || this.amGatekeeper();
  }

  private evaluate() {
    if (this.stopped) return;
    if (this.wantSocket()) {
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
      if (!this.ws) this.openSocket();
    } else if (this.ws && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (!this.wantSocket()) {
          this.ws?.close();
          this.ws = null;
        }
      }, this.o.idleCloseMs ?? 3000);
    }
  }

  private openSocket() {
    const ws = this.o.wsFactory(this.o.signalUrl);
    this.ws = ws;
    this.stats.socketOpens++;
    ws.onopen = () => {
      // Authentication happens when the relay's challenge arrives (see onServerMessage).
      this.backoff = 1000;
      this.rotateTimer = setTimeout(() => {
        // proactive rotation before the platform cuts the connection
        ws.close();
      }, this.o.reconnectAfterMs ?? 280_000);
    };
    ws.onmessage = (ev) => void this.onServerMessage(String(ev.data), ws);
    const lost = () => {
      if (this.ws === ws) {
        this.ws = null;
        this.onRelay.clear();
      }
      if (this.rotateTimer) clearTimeout(this.rotateTimer);
      if (this.stopped || !this.wantSocket()) return;
      this.retryTimer = setTimeout(() => this.evaluate(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    ws.onclose = lost;
    ws.onerror = () => ws.close();
  }

  private async onServerMessage(raw: string, ws?: WebSocketLike) {
    let m: { t: string; nonce?: string; tickets?: string[]; ticket?: string; dev?: string; sid?: string; from?: string; fromTicket?: string; env?: string };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'challenge' && typeof m.nonce === 'string') {
      // Prove we hold the device key named in our ticket (a copied ticket alone must not be enough).
      const ticket = this.o.getTicket();
      const sig = await sign(this.o.keys, utf8(signalAuthMessage(this.o.projectId, this.selfDev, m.nonce)));
      (ws ?? this.ws)?.send(JSON.stringify({ t: 'auth', ticket, sig: toB64u(sig) }));
      return;
    }
    if (m.t === 'ready') {
      this.onRelay.clear();
      for (const t of m.tickets ?? []) {
        const k = await this.learn(t, true);
        if (k) this.onRelay.add(k.claims.dev);
      }
    } else if (m.t === 'join' && m.ticket) {
      const k = await this.learn(m.ticket, true);
      if (k) {
        this.onRelay.add(k.claims.dev);
        if (m.sid) this.sessions.set(k.claims.dev, m.sid);
      }
    } else if (m.t === 'leave' && m.dev) {
      // The leave of an older session of a device that already reconnected (quick reload): not a departure.
      const latest = this.sessions.get(m.dev);
      if (latest && m.sid && m.sid !== latest) return;
      this.sessions.delete(m.dev);
      this.onRelay.delete(m.dev);
      if (!this.connected(m.dev)) {
        this.links.get(m.dev)?.close();
        this.links.delete(m.dev);
      }
    }
    else if (m.t === 'sig' && m.fromTicket && m.env) {
      this.stats.signalsViaServer++;
      await this.onEnvelope(m.fromTicket, unb64(m.env));
    }
  }

  // ---- peers we know about ----

  private async learn(raw: string, viaRelay = false): Promise<Known | null> {
    let claims: TicketClaims;
    try {
      claims = await verifyTicket(raw, this.o.trusted, this.o.now ? { now: this.o.now() } : {});
    } catch {
      return null;
    }
    if (claims.pid !== this.o.projectId || claims.dev === this.selfDev) return null;
    const k = { claims, raw };
    // A linked device announced with another ticket than its link's: a new session of it (routine peer exchange repeats
    // the ticket we already have).
    const linked = this.o.mesh.peers.find((p) => p.deviceId === claims.dev);
    if (linked && linked.ticket !== raw) this.reannounced.add(claims.dev);
    this.known.set(claims.dev, k);
    if (viaRelay) this.onRelay.add(claims.dev);
    this.maybeConnect(k);
    return k;
  }

  private connected(dev: string) {
    return this.o.mesh.peers.some((p) => p.deviceId === dev);
  }

  /** The device with the lower id initiates, so exactly one side offers. */
  private maybeConnect(k: Known) {
    const dev = k.claims.dev;
    if (this.stopped || this.connected(dev) || this.links.has(dev)) return;
    if (this.selfDev < dev) void this.createLink(dev, true).then((l) => l.start());
  }

  private async createLink(dev: string, initiator: boolean): Promise<RtcLink> {
    this.iceServers ??= this.o.getIceServers().catch(() => []);
    const ice = await this.iceServers;
    // A connection attempt can stall without ever failing (a lost signaling message, ICE stuck on a loaded
    // machine): without a deadline the stale entry would block every later attempt towards that device.
    const timer = setTimeout(() => {
      if (this.links.get(dev) !== link) return;
      link.close();
      this.links.delete(dev);
      this.retryLater(dev);
    }, this.o.linkTimeoutMs ?? 20_000);
    const link = new RtcLink({
      factory: this.o.rtcFactory,
      iceServers: ice,
      initiator,
      send: (s) => void this.sendSignal(dev, s),
      onTransport: (t) => {
        clearTimeout(timer);
        this.links.delete(dev);
        this.o.mesh.addTransport(t).catch(() => this.retryLater(dev));
      },
      onFail: () => {
        clearTimeout(timer);
        if (this.links.get(dev) === link) this.links.delete(dev);
        this.retryLater(dev);
      },
    });
    this.links.set(dev, link);
    return link;
  }

  /** Tries a device again with exponential backoff (1 s, 2 s, 4 s ... capped at 30 s, at most 8 attempts). */
  private retryLater(dev: string) {
    if (this.stopped) return;
    const n = (this.attempts.get(dev) ?? 0) + 1;
    if (n > 8) return;
    this.attempts.set(dev, n);
    const base = Math.min(30_000, (this.o.linkTimeoutMs ?? 20_000) < 1000 ? 100 * 2 ** n : 1000 * 2 ** (n - 1));
    setTimeout(() => {
      const k = this.known.get(dev);
      if (k && !this.stopped && !this.connected(dev) && !this.links.has(dev)) this.maybeConnect(k);
    }, base);
  }

  // ---- encrypted signaling ----

  private aad(from: string, to: string) {
    return `${this.o.projectId}|${from}|${to}`;
  }

  private async sendSignal(to: string, sig: LinkSignal) {
    const peer = this.known.get(to);
    if (!peer) return;
    const env = await seal(this.o.keys, peer.claims.devX, utf8(JSON.stringify(sig)), this.aad(this.selfDev, to));
    if (this.socketOpen && (this.onRelay.has(to) || this.o.mesh.peers.length === 0)) {
      this.stats.signalsViaServer++;
      this.ws?.send(JSON.stringify({ t: 'sig', to, env: b64(env) }));
      return;
    }
    // No socket: relay through a peer. Prefer one that announced a direct link to the target; any other peer
    // passes it one more hop (see onRtcViaMesh). An arbitrary peer that is not linked to the target would drop it.
    const via = this.o.mesh.peersLinkedTo(to)[0] ?? this.o.mesh.peers.find((p) => p.deviceId !== to)?.deviceId;
    if (!via) return;
    this.stats.signalsViaMesh++;
    await this.o.mesh.sendApp(via, 'rtc', { to, from: this.selfDev, fromTicket: this.o.getTicket(), env: b64(env), hops: RTC_HOPS } satisfies RtcEnvelope);
  }

  private async onEnvelope(fromTicket: string, env: Uint8Array) {
    const k = await this.learn(fromTicket);
    if (!k) return;
    let sig: LinkSignal;
    try {
      sig = JSON.parse(fromUtf8(await open(this.o.keys, k.claims.devX, env, this.aad(k.claims.dev, this.selfDev)))) as LinkSignal;
    } catch {
      return; // not for us / tampered
    }
    let link = this.links.get(k.claims.dev);
    // An offer from a device we still think is connected means it restarted: answer it; the mesh replaces the old link.
    if (!link && sig.k === 'offer') link = await this.createLink(k.claims.dev, false);
    await link?.handle(sig);
  }

  private async onRtcViaMesh(_from: PeerInfo, body: RtcEnvelope) {
    if (body.to === this.selfDev) {
      this.stats.signalsViaMesh++;
      await this.onEnvelope(body.fromTicket, unb64(body.env));
    } else if (this.connected(body.to)) {
      await this.o.mesh.sendApp(body.to, 'rtc', body);
    } else {
      // Not linked to the target: pass it to a peer that is (bounded, so a stale neighbour list cannot loop it).
      const hops = Math.min(RTC_HOPS, Number(body.hops ?? 0)) - 1;
      const next = this.o.mesh.peersLinkedTo(body.to).find((d) => d !== _from.deviceId && d !== body.from);
      if (hops > 0 && next) await this.o.mesh.sendApp(next, 'rtc', { ...body, hops });
    }
  }

  // ---- peer exchange ----

  private onPeerJoin(p: PeerInfo) {
    this.attempts.delete(p.deviceId);
    this.reannounced.delete(p.deviceId);
    this.links.get(p.deviceId)?.close();
    this.links.delete(p.deviceId);
    this.known.set(p.deviceId, { claims: p.claims, raw: p.ticket });
    const others = this.o.mesh.peers.filter((x) => x.deviceId !== p.deviceId);
    if (others.length) void this.o.mesh.sendApp(p.deviceId, 'pex', { tickets: others.map((x) => x.ticket) });
    for (const x of others) void this.o.mesh.sendApp(x.deviceId, 'pex', { tickets: [p.ticket] });
    this.evaluate();
  }

  private async onPex(_from: PeerInfo, body: { tickets: string[] }) {
    for (const t of body.tickets ?? []) await this.learn(t);
  }
}

interface RtcEnvelope {
  to: string;
  from: string;
  fromTicket: string;
  env: string;
  /** Remaining forwards (older clients omit it: then only a directly linked peer delivers). */
  hops?: number;
}

/** A signal may cross at most this many intermediate peers. */
const RTC_HOPS = 2;

