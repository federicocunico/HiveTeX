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
  private links = new Map<string, RtcLink>();
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
        if (known && !this.stopped && this.onRelay.has(p.deviceId)) this.maybeConnect(known);
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
    let m: { t: string; nonce?: string; tickets?: string[]; ticket?: string; dev?: string; from?: string; fromTicket?: string; env?: string };
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
      if (k) this.onRelay.add(k.claims.dev);
    } else if (m.t === 'leave' && m.dev) {
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
    const link = new RtcLink({
      factory: this.o.rtcFactory,
      iceServers: ice,
      initiator,
      send: (s) => void this.sendSignal(dev, s),
      onTransport: (t) => {
        this.links.delete(dev);
        this.o.mesh.addTransport(t).catch(() => {});
      },
      onFail: () => {
        if (this.links.get(dev) === link) this.links.delete(dev);
      },
    });
    this.links.set(dev, link);
    return link;
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
    // No socket: relay through any connected peer (they forward to the target if they are linked to it).
    const via = this.o.mesh.peers.find((p) => p.deviceId !== to) ?? this.o.mesh.peers[0];
    if (!via) return;
    this.stats.signalsViaMesh++;
    await this.o.mesh.sendApp(via.deviceId, 'rtc', { to, from: this.selfDev, fromTicket: this.o.getTicket(), env: b64(env) } satisfies RtcEnvelope);
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
    }
  }

  // ---- peer exchange ----

  private onPeerJoin(p: PeerInfo) {
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
}

