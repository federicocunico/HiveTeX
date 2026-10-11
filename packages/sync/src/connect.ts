import { type StoredDeviceKeys, fromB64u, open, seal, sign, toB64u, verifyTicket } from '@hivetex/crypto';
import { type TicketClaims, type TrustedKey, signalAuthMessage } from '@hivetex/protocol';
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
  /**
   * Connection configuration (STUN/TURN servers). Either a bare list, or the control plane's answer with the expiry of
   * its relay credentials: the manager then asks again before they expire. May reject (e.g. rate limited, with an
   * optional `status` and `retryAfterMs` on the error): the attempt goes ahead without the relay and a later one asks again.
   */
  getIceServers: () => Promise<unknown[] | IceConfig>;
  /** Longest wait for `getIceServers` before an attempt goes ahead without it. Default 5 s. */
  iceTimeoutMs?: number;
  /** Jitter source for the credential retry backoff (tests). */
  random?: () => number;
  now?: () => Date;
  /** The relay closes sockets after ~300 s; reconnect slightly earlier. */
  reconnectAfterMs?: number;
  idleCloseMs?: number;
  /** A link that has not produced a transport within this time is abandoned and retried. Default 20 s. */
  linkTimeoutMs?: number;
  /** Upper bound of the retry backoff towards a device that is online but not connected. Default 30 s. */
  maxBackoffMs?: number;
  /**
   * How often an open signaling socket renews this device's presence lease (the relay expires it after 90 s).
   * Default 30 s.
   */
  heartbeatMs?: number;
}

export interface IceConfig {
  iceServers: unknown[];
  /** Epoch ms after which the relay credentials in `iceServers` no longer work. */
  expiresAt?: number;
}

/** Credentials are refreshed this long before they expire, and when the expiry is unknown they are kept this long. */
const ICE_REFRESH_MARGIN_MS = 60_000;
const ICE_DEFAULT_TTL_MS = 10 * 60_000;

/** An online co-author device we know of but are not linked to (yet). */
export interface Candidate {
  dev: string;
  uname: string;
  /** Failed or stalled link attempts since the last connection. */
  attempts: number;
  /** A link attempt is in progress right now. */
  linking: boolean;
  lastError: string | null;
  /** Visible on the signaling relay (as opposed to only announced by a peer). */
  onRelay: boolean;
}

/** When each stage of reaching a device happened (epoch ms), for diagnosing slow joins. */
export interface DeviceStages {
  firstSeenAt: number;
  relaySeenAt?: number;
  firstAttemptAt?: number;
  linkUpAt?: number;
  attempts: number;
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
  private lastErrors = new Map<string, string>();
  /** Devices that left the relay (and are not linked): not retried until they are announced again. */
  private gone = new Set<string>();
  private stages = new Map<string, DeviceStages>();
  private stateCbs = new Set<() => void>();
  /** The last configuration obtained, with its expiry. Failures are never stored here. */
  private ice: { servers: unknown[]; expiresAt: number } | null = null;
  /** The acquisition in flight, shared by every attempt that starts meanwhile. */
  private iceFetch: Promise<unknown[]> | null = null;
  private iceFailures = 0;
  /** No new request before this time (epoch ms): backoff after failures and rate limits. */
  private iceRetryAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private stopped = true;
  /** Bumped by every stop: continuations of older setup (awaited configuration, crypto, sockets) check it. */
  private gen = 0;
  /** Every timer this manager owns, so stop() can cancel them all (including per-device retries). */
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** Connection attempts in setup (configuration, link creation), per device: reserved before the first await. */
  private opening = new Map<string, Promise<RtcLink | null>>();
  /** Devices whose transport is being authenticated by the mesh: the attempt still owns them. */
  private authenticating = new Set<string>();
  private unsubs: Array<() => void> = [];
  /** (Re)starts the heartbeat of the current socket; set by openSocket. */
  private beat: (() => void) | null = null;
  private selfDev: string;
  readonly stats = { socketOpens: 0, signalsViaServer: 0, signalsViaMesh: 0 };

  constructor(private o: ManagerOptions) {
    this.selfDev = JSON.parse(fromUtf8(fromB64u(o.getTicket().split('.')[1] ?? ''))).dev as string;
  }

  /** A timer owned by this manager: cancelled by stop(), and a no-op if the manager was stopped meanwhile. */
  private later(ms: number, fn: () => void) {
    const gen = this.gen;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped && gen === this.gen) fn();
    }, ms);
    this.timers.add(t);
    return t;
  }
  private cancel(t: ReturnType<typeof setTimeout> | null) {
    if (!t) return;
    clearTimeout(t);
    this.timers.delete(t);
  }

  get socketOpen() {
    return this.ws?.readyState === WS_OPEN;
  }

  /** Fires when the set of reachable-but-unconnected devices or their attempt state changes. */
  onState(cb: () => void) {
    this.stateCbs.add(cb);
  }
  private emitState() {
    for (const cb of this.stateCbs) cb();
  }

  /** Online co-author devices we are not connected to yet, with the state of our attempts to reach them. */
  candidates(): Candidate[] {
    const out: Candidate[] = [];
    for (const [dev, k] of this.known) {
      if (this.connected(dev) || this.gone.has(dev)) continue;
      out.push({
        dev,
        uname: k.claims.uname,
        attempts: this.attempts.get(dev) ?? 0,
        linking: this.links.has(dev),
        lastError: this.lastErrors.get(dev) ?? null,
        onRelay: this.onRelay.has(dev),
      });
    }
    return out;
  }

  /** Timestamps of the stages reached per device (relay seen, first attempt, link up), for diagnostics. */
  diagnostics(): Record<string, DeviceStages> {
    return Object.fromEntries(this.stages);
  }

  /**
   * "Sync now": forget failed-attempt backoff, abandon links that may be stalled, reopen the relay socket if needed and
   * try every known device again. Only the device with the lower id offers, so against a higher-id device this
   * resets our side and relies on its own (uncapped) retries to offer.
   */
  reconnectNow() {
    if (this.stopped) return;
    this.attempts.clear();
    this.lastErrors.clear();
    for (const [dev, l] of this.links) {
      l.close();
      this.links.delete(dev);
    }
    this.cancel(this.retryTimer);
    this.retryTimer = null;
    this.backoff = 1000;
    this.evaluate();
    for (const k of this.known.values()) if (!this.gone.has(k.claims.dev)) this.maybeConnect(k);
    this.emitState();
  }

  private stage(dev: string): DeviceStages {
    let st = this.stages.get(dev);
    if (!st) {
      st = { firstSeenAt: Date.now(), attempts: 0 };
      this.stages.set(dev, st);
    }
    return st;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const mesh = this.o.mesh;
    this.unsubs.push(
      mesh.onPeerJoin((p) => this.onPeerJoin(p)),
      mesh.onPeerLeave((p) => {
        this.evaluate();
        this.emitState();
        // The peer may simply have restarted: try to reach it again shortly (bounded by the link attempt itself).
        this.later(1500, () => {
          const known = this.known.get(p.deviceId);
          const back = this.onRelay.has(p.deviceId) || this.reannounced.delete(p.deviceId);
          if (known && back) this.maybeConnect(known);
        });
      }),
      mesh.onApp('pex', (from, body) => void this.onPex(from, body as { tickets: string[] })),
      mesh.onApp('rtc', (from, body) => void this.onRtcViaMesh(from, body as RtcEnvelope)),
    );
    this.evaluate();
  }

  /** Cancels everything this manager owns: timers, socket, links, pending setup and mesh handlers. */
  stop() {
    this.stopped = true;
    this.gen++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.idleTimer = this.rotateTimer = this.retryTimer = null;
    for (const u of this.unsubs.splice(0)) u();
    const ws = this.ws;
    this.ws = null;
    this.onRelay.clear();
    ws?.close();
    for (const l of this.links.values()) l.close();
    this.links.clear();
    this.opening.clear();
    this.authenticating.clear();
    this.iceFetch = null;
  }

  private nowMs() {
    return (this.o.now ?? (() => new Date()))().getTime();
  }

  /** STUN entries of the last configuration (credential-less), usable while relay credentials cannot be had. */
  private stunOnly() {
    return (this.ice?.servers ?? []).filter((s) => (s as { credential?: unknown }).credential === undefined);
  }

  /**
   * The connection configuration for a new attempt: the cached one until shortly before its expiry, otherwise one shared
   * acquisition. A failure or a stall never blocks the attempt (it proceeds without relay credentials) and is never cached:
   * a later attempt asks again once the backoff has passed.
   */
  private iceConfig(): Promise<unknown[]> {
    const now = this.nowMs();
    if (this.ice && now < this.ice.expiresAt - ICE_REFRESH_MARGIN_MS) return Promise.resolve(this.ice.servers);
    if (this.iceFetch) return this.iceFetch;
    if (now < this.iceRetryAt) return Promise.resolve(this.stunOnly());
    const gen = this.gen;
    const p: Promise<unknown[]> = new Promise<unknown[]>((resolve) => {
      let settled = false;
      const done = (servers: unknown[]) => {
        if (settled) return;
        settled = true;
        this.cancel(timer);
        resolve(servers);
      };
      const timer = this.later(this.o.iceTimeoutMs ?? 5000, () => {
        this.iceFailed();
        done(this.stunOnly());
      });
      this.o.getIceServers().then(
        (r) => {
          const cfg: IceConfig = Array.isArray(r) ? { iceServers: r } : r;
          // Credentials that arrive after the deadline are still good for the next attempt.
          if (gen === this.gen) {
            this.ice = { servers: cfg.iceServers, expiresAt: cfg.expiresAt ?? this.nowMs() + ICE_DEFAULT_TTL_MS };
            this.iceFailures = 0;
            this.iceRetryAt = 0;
          }
          done(cfg.iceServers);
        },
        (e: unknown) => {
          if (gen === this.gen) this.iceFailed(e);
          done(this.stunOnly());
        },
      );
    }).finally(() => {
      if (this.iceFetch === p) this.iceFetch = null;
    });
    this.iceFetch = p;
    return p;
  }

  /** Exponential backoff with jitter (1 s ... 60 s), at least the rate limit's advised delay when there is one. */
  private iceFailed(e?: unknown) {
    const n = ++this.iceFailures;
    const jitter = 0.75 + 0.5 * (this.o.random ?? Math.random)();
    let wait = Math.min(60_000, 1000 * 2 ** Math.min(n - 1, 10)) * jitter;
    const err = e as { status?: number; retryAfterMs?: number } | undefined;
    if (err?.status === 429) wait = Math.max(wait, 30_000);
    if (typeof err?.retryAfterMs === 'number') wait = Math.max(wait, err.retryAfterMs);
    this.iceRetryAt = this.nowMs() + wait;
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
      this.cancel(this.idleTimer);
      this.idleTimer = null;
      if (!this.ws) this.openSocket();
    } else if (this.ws && !this.idleTimer) {
      this.idleTimer = this.later(this.o.idleCloseMs ?? 3000, () => {
        this.idleTimer = null;
        if (!this.wantSocket()) {
          const ws = this.ws;
          this.ws = null;
          ws?.close();
        }
      });
    }
  }

  private openSocket() {
    const ws = this.o.wsFactory(this.o.signalUrl);
    this.ws = ws;
    this.stats.socketOpens++;
    // Events of a socket that is no longer the current one (stopped, rotated, replaced) are ignored, and the timers
    // belong to the socket that started them.
    let rotate: ReturnType<typeof setTimeout> | null = null;
    let beat: ReturnType<typeof setTimeout> | null = null;
    // Presence is a lease: renew it while this socket is the live, authenticated one (see the `ready` message).
    this.beat = () => {
      this.cancel(beat);
      const every = this.o.heartbeatMs ?? 30_000;
      beat = this.later(every, () => {
        if (this.ws !== ws || ws.readyState !== WS_OPEN) return;
        ws.send(JSON.stringify({ t: 'ping' }));
        this.beat?.();
      });
    };
    const cancelBeat = () => this.cancel(beat);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // Authentication happens when the relay's challenge arrives (see onServerMessage).
      this.backoff = 1000;
      // proactive rotation before the platform cuts the connection
      rotate = this.later(this.o.reconnectAfterMs ?? 280_000, () => ws.close());
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) void this.onServerMessage(String(ev.data), ws);
    };
    const lost = () => {
      this.cancel(rotate);
      cancelBeat();
      if (this.ws !== ws) return;
      this.ws = null;
      this.onRelay.clear();
      if (this.stopped || !this.wantSocket()) return;
      this.cancel(this.retryTimer);
      this.retryTimer = this.later(this.backoff, () => {
        this.retryTimer = null;
        this.evaluate();
      });
      this.backoff = Math.min(this.backoff * 2, 30_000);
    };
    ws.onclose = lost;
    ws.onerror = () => ws.close();
  }

  private async onServerMessage(raw: string, ws?: WebSocketLike) {
    let m: { t: string; nonce?: string; tickets?: string[]; sessions?: Record<string, unknown>; ticket?: string; dev?: string; sid?: string; from?: string; fromTicket?: string; env?: string };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'challenge' && typeof m.nonce === 'string') {
      // Prove we hold the device key named in our ticket (a copied ticket alone must not be enough).
      const gen = this.gen;
      const ticket = this.o.getTicket();
      const sig = await sign(this.o.keys, utf8(signalAuthMessage(this.o.projectId, this.selfDev, m.nonce)));
      if (this.stopped || gen !== this.gen || (ws && this.ws !== ws)) return;
      (ws ?? this.ws)?.send(JSON.stringify({ t: 'auth', ticket, sig: toB64u(sig) }));
      return;
    }
    if (m.t === 'ready') {
      this.onRelay.clear();
      this.sessions.clear();
      this.beat?.();
      // `sessions` is additive (older relays omit it): it lets us tell a later leave of an older session from a departure.
      for (const [dev, sid] of Object.entries(m.sessions ?? {})) if (typeof sid === 'string') this.sessions.set(dev, sid);
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
        this.gone.add(m.dev);
        this.attempts.delete(m.dev);
        this.lastErrors.delete(m.dev);
        this.emitState();
      }
    }
    else if (m.t === 'sig' && m.fromTicket && m.env) {
      this.stats.signalsViaServer++;
      await this.onEnvelope(m.fromTicket, unb64(m.env));
    }
  }

  // ---- peers we know about ----

  private async learn(raw: string, viaRelay = false): Promise<Known | null> {
    const gen = this.gen;
    let claims: TicketClaims;
    try {
      claims = await verifyTicket(raw, this.o.trusted, this.o.now ? { now: this.o.now() } : {});
    } catch {
      return null;
    }
    if (claims.pid !== this.o.projectId || claims.dev === this.selfDev) return null;
    if (this.stopped || gen !== this.gen) return null;
    const k = { claims, raw };
    // A linked device announced with another ticket than its link's: a new session of it (routine peer exchange repeats
    // the ticket we already have).
    const linked = this.o.mesh.peers.find((p) => p.deviceId === claims.dev);
    if (linked && linked.ticket !== raw) this.reannounced.add(claims.dev);
    this.known.set(claims.dev, k);
    this.gone.delete(claims.dev);
    const st = this.stage(claims.dev);
    if (viaRelay) {
      this.onRelay.add(claims.dev);
      st.relaySeenAt ??= Date.now();
    }
    this.maybeConnect(k);
    this.emitState();
    return k;
  }

  private connected(dev: string) {
    return this.o.mesh.peers.some((p) => p.deviceId === dev);
  }

  /** An attempt towards `dev` already exists: connected, being set up, linking, or authenticating. */
  private busy(dev: string) {
    return this.connected(dev) || this.links.has(dev) || this.opening.has(dev) || this.authenticating.has(dev);
  }

  /** The device with the lower id initiates, so exactly one side offers. */
  private maybeConnect(k: Known) {
    const dev = k.claims.dev;
    if (this.stopped || this.busy(dev)) return;
    if (this.selfDev < dev) {
      void this.attempt(dev, true)
        .then((l) => l?.start())
        .catch(() => this.retryLater(dev));
    }
  }

  /** The one current attempt towards `dev`: reserved before anything is awaited, so every caller shares it. */
  private attempt(dev: string, initiator: boolean): Promise<RtcLink | null> {
    const current = this.opening.get(dev);
    if (current) return current;
    const gen = this.gen;
    const p: Promise<RtcLink | null> = this.createLink(dev, initiator, gen).finally(() => {
      if (this.opening.get(dev) === p) this.opening.delete(dev);
    });
    this.opening.set(dev, p);
    return p;
  }

  /** Resolves null when the manager was stopped while the configuration loaded. */
  private async createLink(dev: string, initiator: boolean, gen: number): Promise<RtcLink | null> {
    const ice = await this.iceConfig();
    if (this.stopped || gen !== this.gen) return null;
    // A connection attempt can stall without ever failing (a lost signaling message, ICE stuck on a loaded
    // machine): without a deadline the stale entry would block every later attempt towards that device.
    const timer = this.later(this.o.linkTimeoutMs ?? 20_000, () => {
      if (this.links.get(dev) !== link) return;
      link.close();
      this.links.delete(dev);
      this.lastErrors.set(dev, 'connection attempt timed out');
      this.retryLater(dev);
    });
    this.stage(dev).firstAttemptAt ??= Date.now();
    const link = new RtcLink({
      factory: this.o.rtcFactory,
      iceServers: ice,
      initiator,
      send: (s) => void this.sendSignal(dev, s),
      onTransport: (t) => {
        this.cancel(timer);
        if (this.links.get(dev) === link) this.links.delete(dev);
        if (this.stopped || gen !== this.gen) return void t.close();
        // The attempt keeps owning the device until the mesh has authenticated (or refused) the transport.
        this.authenticating.add(dev);
        this.o.mesh
          .addTransport(t)
          .catch(() => this.retryLater(dev))
          .finally(() => {
            if (gen === this.gen) this.authenticating.delete(dev);
          });
      },
      onFail: (why) => {
        this.cancel(timer);
        if (this.links.get(dev) === link) this.links.delete(dev);
        this.lastErrors.set(dev, why);
        this.retryLater(dev);
      },
    });
    this.links.set(dev, link);
    this.emitState();
    return link;
  }

  /**
   * Tries a device again with exponential backoff (1 s, 2 s, 4 s ... capped at 30 s). There is no attempt limit: a
   * device that is still online must be reached without the user doing anything. Retrying stops when the device leaves
   * the relay (see `gone`) or the manager stops.
   */
  private retryLater(dev: string) {
    if (this.stopped) return;
    const n = (this.attempts.get(dev) ?? 0) + 1;
    this.attempts.set(dev, n);
    this.stage(dev).attempts = n;
    this.emitState();
    const cap = this.o.maxBackoffMs ?? 30_000;
    const base = Math.min(cap, (this.o.linkTimeoutMs ?? 20_000) < 1000 ? 100 * 2 ** Math.min(n, 20) : 1000 * 2 ** Math.min(n - 1, 20));
    this.later(base, () => {
      const k = this.known.get(dev);
      if (k && !this.gone.has(dev)) this.maybeConnect(k);
    });
  }

  // ---- encrypted signaling ----

  private aad(from: string, to: string) {
    return `${this.o.projectId}|${from}|${to}`;
  }

  private async sendSignal(to: string, sig: LinkSignal) {
    const peer = this.known.get(to);
    if (!peer || this.stopped) return;
    const gen = this.gen;
    const env = await seal(this.o.keys, peer.claims.devX, utf8(JSON.stringify(sig)), this.aad(this.selfDev, to));
    if (this.stopped || gen !== this.gen) return; // stopped while sealing: transmit nothing
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
    const gen = this.gen;
    const k = await this.learn(fromTicket);
    if (!k || this.stopped || gen !== this.gen) return;
    let sig: LinkSignal;
    try {
      sig = JSON.parse(fromUtf8(await open(this.o.keys, k.claims.devX, env, this.aad(k.claims.dev, this.selfDev)))) as LinkSignal;
    } catch {
      return; // not for us / tampered
    }
    if (this.stopped || gen !== this.gen) return;
    let link: RtcLink | null | undefined = this.links.get(k.claims.dev);
    // An offer from a device we still think is connected means it restarted: answer it; the mesh replaces the old link.
    // (An attempt already in setup is shared, not duplicated.)
    if (!link && sig.k === 'offer') link = await this.attempt(k.claims.dev, false);
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
    this.lastErrors.delete(p.deviceId);
    this.gone.delete(p.deviceId);
    this.stage(p.deviceId).linkUpAt = Date.now();
    this.emitState();
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

