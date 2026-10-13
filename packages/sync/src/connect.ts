import { type RelayHello, RelayHandshake, type RelaySession, type StoredDeviceKeys, fromB64u, open, seal, sign, toB64u, verifyTicket } from '@hivetex/crypto';
import { APPLICATION_RELAY_CAPABILITY, RELAY_SESSION_PREFIX, type TicketClaims, type TrustedKey, signalAuthMessage } from '@hivetex/protocol';
import { fromUtf8, utf8 } from './frames.js';
import type { Mesh, PeerInfo } from './mesh.js';
import { decodeRelayWire, encodeRelayHandshake, RelayTransport, type RelayTransportOptions } from './relay-transport.js';
import { type LinkDiag, type LinkSignal, RtcLink, type RtcFactory } from './rtc.js';

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
  /** Receives every connection step (see TraceEvent). Never gets credentials, keys, addresses or content. */
  trace?: (e: TraceEvent) => void;
  /** "desktop 0.7.2", "web 0.7.2": reported to a co-author's connection test so version mismatches are visible. */
  clientInfo?: string;
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
  /**
   * Offer the application relay to the signaling server. It is used only when the server and the peer negotiated it,
   * and only while no direct (or TURN) link works. Default true.
   */
  applicationRelay?: boolean;
  /** No usable direct link this long after learning a relay-capable peer: start relay setup (D12: within 10 s). Default 8 s. */
  relayAfterMs?: number;
  /** While a peer is only reachable through the relay, direct link attempts repeat at most this often. Default 60 s. */
  directRetryMs?: number;
  /** Relay transport tuning (tests). */
  relayTransport?: Omit<RelayTransportOptions, 'session' | 'post'>;
  /**
   * Doorbell mode (D14): no gatekeeper socket. The signaling socket opens only to introduce this device, after ringing the
   * project (`ring`, which publishes a server-signed ring token) or when answering a ring (`answerRing()`), and closes
   * once the devices seen on the server are connected or the introduction window ends. While the push channel is
   * unavailable (`setDoorbellAvailable(false)`) the manager keeps the gatekeeper behaviour so it stays reachable.
   */
  doorbell?: { ring: () => Promise<boolean> };
  /** Desktop seeds must not replace a broken push subscription with an idle gatekeeper socket. */
  zeroIdle?: boolean;
  /** Called before a socket opens in doorbell mode, so a device that slept without renewing gets a fresh ticket. */
  ensureTicket?: () => Promise<void>;
  /** How long an introduction keeps the socket at most (default 30 s) and at least (default 8 s). */
  introductionWindowMs?: number;
  introductionMinMs?: number;
  /** Random delay before answering a ring, so a burst of answers is spread (default up to 1.5 s). */
  answerJitterMs?: number;
}

/** The path carrying a connected peer, as reported to the UI. */
export type PeerRoute = 'direct' | 'turn' | 'relay';
export interface RouteState {
  route: PeerRoute;
  /** Relay only: the server refused forwarding (budget, accounting, rate); queued traffic waits with this reason. */
  limited: string | null;
  /** Direct/TURN links: candidate types of the selected pair, once the RTC implementation reports them. */
  pair?: { local: string; remote: string } | null;
}

interface RelayAttempt {
  gen: number;
  /** The initiator's handshake generation: every handshake message carries it. */
  id: string;
  role: 'initiator' | 'responder';
  /** The signaling session of the peer this attempt is bound to. */
  peerSid: string;
  handshake: RelayHandshake | null;
  transport: RelayTransport | null;
  timer: ReturnType<typeof setTimeout> | null;
}
interface RelayStep {
  g?: unknown;
  hello?: RelayHello;
  proof?: unknown;
  confirm?: unknown;
}
const RELAY_LIMIT_CODES = new Set(['relay_limited', 'relay_accounting_unavailable', 'relay_rate_limited', 'relay_backpressure', 'relay_unavailable']);

export interface IceConfig {
  iceServers: unknown[];
  /** Epoch ms after which the relay credentials in `iceServers` no longer work. */
  expiresAt?: number;
  /** Whether relay credentials were issued and, if not, why (older services omit it). */
  relay?: { available: boolean; reason: string };
}

/** One step of the connection layer, for tests and the diagnostics report. `dev` is the other device, when there is one. */
export interface TraceEvent {
  /** Epoch ms from the manager's clock. */
  t: number;
  /** This device. */
  self: string;
  ev: string;
  dev?: string;
  data?: Record<string, string | number | boolean>;
}

/** How a setup message left this device and what the signaling service said about it (diagnostics only). */
export interface SignalDelivery {
  via: 'server' | 'mesh' | 'unsent';
  /** Why it could not be sent (via 'unsent'). */
  reason?: string;
  /** Server path: the service acknowledged it (null: no acknowledgement, e.g. an older service or a lost message). */
  accepted: boolean | null;
  /** Server path: whether the service saw the target device connected when it accepted the message. */
  targetOnline: boolean | null;
  /** Server path: the service handed the message to the target device's connection. */
  delivered: boolean;
}

/** What a device reports about itself and its view of the asking device, in answer to a connection test. */
export interface PeerSelfReport {
  client: string | null;
  socketOpen: boolean;
  /** It holds a valid ticket of the asking device. */
  knowsYou: boolean;
  /** It sees the asking device connected to the signaling service. */
  seesYouOnServer: boolean;
  /** Its role towards the asking device: the lower device id offers. */
  role: 'offerer' | 'answerer';
  connected: boolean;
  route: PeerRoute | null;
  linking: boolean;
  attempts: number;
  lastError: string | null;
  cause: AttemptCause | null;
  link: LinkDiag | null;
  ice: IceInfo;
  meshPeers: number;
}

export interface PeerProbeStep {
  /** Milliseconds since the test started. */
  at: number;
  label: string;
  /** true: fine, false: the problem, null: information. */
  ok: boolean | null;
  detail: string;
}

/** The outcome of a connection test towards one co-author device. */
export interface PeerProbeResult {
  dev: string;
  startedAt: number;
  durationMs: number;
  role: 'offerer' | 'answerer';
  socketOpen: boolean;
  known: boolean;
  onServer: boolean;
  connectedBefore: boolean;
  signaling: { delivery: SignalDelivery | null; replyMs: number | null };
  remote: PeerSelfReport | null;
  attempt: {
    outcome: 'connected' | 'failed' | 'timeout' | 'skipped';
    route: PeerRoute | null;
    pair: { local: string; remote: string } | null;
    cause: AttemptCause | null;
    error: string | null;
    link: LinkDiag | null;
    ms: number | null;
  };
  steps: PeerProbeStep[];
  /** One sentence: the most likely reason, or the route that works. */
  verdict: string;
  /** Every connection step towards this device (and of the signaling socket) during the test. */
  trace: TraceEvent[];
}

/** What this device itself looks like to the connection layer, for diagnostics. */
export interface SelfDiagnostics {
  dev: string;
  client: string | null;
  socketOpen: boolean;
  doorbellMode: boolean;
  meshPeers: number;
  knownDevices: number;
  onServer: number;
  stats: ConnectionManager['stats'];
}

/** A signaling-only round trip (connection test): independent of WebRTC, carried exactly like the setup messages. */
type ProbeSignal = { k: 'probe'; id: string; retry: boolean } | { k: 'probe-reply'; id: string; state: PeerSelfReport };
type WireSignal = LinkSignal | ProbeSignal;

/** What the last credential request told us, for the diagnostics page. */
export interface IceInfo {
  /** Never asked yet, answered, or failed/timed out (then only STUN servers are used). */
  state: 'unknown' | 'ok' | 'failed';
  relay: { available: boolean; reason: string } | null;
  /** Number of servers offered, STUN and relay together. */
  servers: number;
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
  /** Why the last attempt failed, in terms the diagnostics page can explain. */
  cause: AttemptCause | null;
  /** What the last attempt (or the one in progress) had seen: candidate types and setup messages, never addresses. */
  link: LinkDiag | null;
  /** Visible on the signaling relay (as opposed to only announced by a peer). */
  onRelay: boolean;
}

/** The stage at which a connection attempt stopped. */
export type AttemptCause =
  /** The other device never answered our offer. */
  | 'no-setup-reply'
  /** Setup was exchanged but no candidates came from the other device. */
  | 'no-candidates'
  /** Candidates were exchanged but no working path was found. */
  | 'checks-failed'
  /** The link failed for another reason (the error text says which). */
  | 'link-error';

const routeName = (r: PeerRoute | null | undefined) => (r === 'turn' ? 'through the TURN relay' : r === 'relay' ? 'through the application relay' : 'directly');

/** One line about the other device's own view, for a connection test. */
function describeRemote(r: PeerSelfReport): string {
  const parts = [
    r.client ?? 'unknown app version',
    r.socketOpen ? 'connected to the signaling service' : 'NOT connected to the signaling service',
    r.knowsYou ? 'knows this device' : 'does NOT know this device',
    r.seesYouOnServer ? 'sees this device on the service' : 'does not see this device on the service',
    `role ${r.role}`,
    r.connected ? `connected ${routeName(r.route)}` : `${r.attempts} failed attempt(s)${r.cause ? `, last stopped at ${r.cause}` : ''}${r.lastError ? ` (${r.lastError})` : ''}`,
    `connection servers ${r.ice.state}${r.ice.relay ? `, relay ${r.ice.relay.available ? 'available' : `unavailable (${r.ice.relay.reason})`}` : ''}`,
  ];
  return parts.join('; ');
}

/** The most likely explanation of a connection test, in one sentence. */
export function probeVerdict(p: PeerProbeResult): string {
  if (p.attempt.outcome === 'connected') return `Connected ${routeName(p.attempt.route)}.`;
  if (!p.known) return 'The co-author is not online for this device.';
  const d = p.signaling.delivery;
  if (d?.via === 'unsent') return `Setup messages cannot leave this device (${d.reason}): ${p.socketOpen ? 'the co-author is not seen on the signaling service' : 'this device is not connected to the signaling service'}.`;
  if (d?.via === 'server' && d.accepted && d.targetOnline === false) return 'The signaling service does not see the co-author connected: their app is closed, offline, or connected to a different server.';
  if (d?.via === 'server' && d.accepted && !d.delivered) return 'The signaling service accepted the message but did not deliver it to the co-author: a problem in the service (message forwarding between its instances).';
  if (!p.remote) {
    if (d?.via === 'server' && d.delivered) return 'The co-author\'s connection received the message but their app did not answer: they run an older version, or their app drops messages from this device (their report shows why).';
    if (d?.via === 'mesh') return 'Setup messages go through another co-author and get no answer: this device does not see the co-author on the signaling service.';
    return 'No answer from the co-author and no confirmation from the signaling service (service older than 0.7.2, or messages are lost).';
  }
  const r = p.remote;
  if (!r.knowsYou) return 'The co-author\'s app does not know this device (it rejected or has not received this device\'s ticket).';
  if (!r.socketOpen && d?.via !== 'mesh') return 'The co-author answered, but is not connected to the signaling service right now.';
  switch (p.attempt.cause) {
    case 'no-setup-reply': return 'Signaling works both ways, but the WebRTC offer got no answer: the answering side failed to set up its connection (see its report and trace).';
    case 'no-candidates': return 'Offer and answer were exchanged but no network candidates arrived from the co-author.';
    case 'checks-failed': return 'Both sides exchanged addresses and none worked, including the relay: a firewall blocks UDP and TCP to the relay on at least one side.';
    case 'link-error': return `The connection failed with an error: ${p.attempt.error ?? 'unknown'}.`;
    default: return p.attempt.outcome === 'timeout' ? 'Signaling works, but no connection attempt finished in time.' : 'The connection did not come up.';
  }
}

/** Names the stage an unsuccessful link stopped at from what it saw. */
export function attemptCause(d: LinkDiag, initiator: boolean): AttemptCause {
  if (initiator && !d.answerReceived) return 'no-setup-reply';
  if (d.remoteCandidates.length === 0) return 'no-candidates';
  return 'checks-failed';
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
/** Most candidates kept for one device while its link is being created. */
const EARLY_SIGNALS_MAX = 64;
/** Connection steps kept in memory for diagnostics and connection tests. */
const TRACE_KEEP = 800;
const shortId = (id: string) => id.slice(0, 8);

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
  private iceInfoValue: IceInfo = { state: 'unknown', relay: null, servers: 0 };
  private lastCauses = new Map<string, { cause: AttemptCause; link: LinkDiag; at: number }>();
  /** Recent connection steps (always kept, whether or not a trace sink is set), numbered for slicing. */
  private recent: Array<{ seq: number; e: TraceEvent }> = [];
  private traceSeq = 0;
  /** Server acknowledgements awaited for setup messages and probes, by ack id. */
  private acks = new Map<string, { onAck: (online: boolean | null) => void; onDelivered: () => void }>();
  /** Connection-test replies awaited, by probe id. */
  private probes = new Map<string, (r: PeerSelfReport) => void>();
  /** Devices for which "waiting for their offer" was already traced. */
  private waitTraced = new Set<string>();
  /** Candidates that reached us before the link they belong to exists (its configuration is still loading). */
  private earlySignals = new Map<string, LinkSignal[]>();
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
  /** This device's relay-capable signaling session, when the server negotiated the application relay. */
  private selfRelaySid: string | null = null;
  /** The socket carried relay work even if a peer's leave arrived just before its own duration cutoff. */
  private socketHadRelay = false;
  /** The one relay attempt or established relay generation per device. */
  private relays = new Map<string, RelayAttempt>();
  private relayFailures = new Map<string, number>();
  private relayChains = new Map<string, Promise<void>>();
  /** A relay check is scheduled for these devices. */
  private relayPending = new Set<string>();
  /** Doorbell mode: the push channel works, so the gatekeeper socket is not needed. */
  private doorbellUp = false;
  /** An introduction is in progress until this time (epoch ms); it may end earlier once every device seen is linked. */
  private introUntil = 0;
  private introMinUntil = 0;
  readonly stats = { socketOpens: 0, signalsViaServer: 0, signalsViaMesh: 0, relaySetups: 0, relayFailures: 0, rings: 0, answers: 0 };

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
        cause: this.lastCauses.get(dev)?.cause ?? null,
        link: this.links.get(dev)?.diag() ?? this.lastCauses.get(dev)?.link ?? null,
        onRelay: this.onRelay.has(dev),
      });
    }
    return out;
  }

  /** What the last ICE configuration request returned (STUN/relay availability), for diagnostics. */
  iceInfo(): IceInfo {
    return { ...this.iceInfoValue };
  }

  /** What this device reports about itself towards `dev` (answer to a connection test). */
  private selfReport(dev: string): PeerSelfReport {
    const cause = this.lastCauses.get(dev);
    return {
      client: this.o.clientInfo ?? null,
      socketOpen: this.socketOpen,
      knowsYou: this.known.has(dev),
      seesYouOnServer: this.onRelay.has(dev),
      role: this.selfDev < dev ? 'offerer' : 'answerer',
      connected: this.connected(dev),
      route: this.routes()[dev]?.route ?? null,
      linking: this.links.has(dev) || this.opening.has(dev),
      attempts: this.attempts.get(dev) ?? 0,
      lastError: this.lastErrors.get(dev) ?? null,
      cause: cause?.cause ?? null,
      link: this.links.get(dev)?.diag() ?? cause?.link ?? null,
      ice: this.iceInfo(),
      meshPeers: this.o.mesh.peers.length,
    };
  }

  private async answerProbe(dev: string, p: { id: string; retry: boolean }) {
    this.tr('probe.received', dev, { retry: p.retry });
    if (p.retry) this.retryNow(dev);
    const { delivery } = await this.sendSignal(dev, { k: 'probe-reply', id: p.id, state: this.selfReport(dev) });
    this.tr('probe.replied', dev, { via: delivery.via });
  }

  /**
   * Retry `dev` right now: forget its backoff and drop a link that is still being set up (a connection test). The
   * offering side starts a new attempt; the answering side waits for the next offer.
   */
  retryNow(dev: string): boolean {
    const k = this.known.get(dev);
    if (!k || this.stopped) return false;
    this.attempts.delete(dev);
    this.earlySignals.delete(dev);
    if (!this.connectedDirect(dev)) {
      const stale = this.links.get(dev);
      if (stale && !this.authenticating.has(dev)) {
        stale.close();
        this.links.delete(dev);
        this.tr('link.abandoned', dev, { reason: 'connection test' });
      }
    }
    this.gone.delete(dev);
    this.tr('attempt.retry-now', dev, { role: this.selfDev < dev ? 'offerer' : 'answerer' });
    this.maybeConnect(k);
    this.emitState();
    return true;
  }

  /**
   * Connection test towards one co-author device. 1) Signaling round trip: a probe sealed and carried exactly like
   * an offer; the other device answers with its own state and, when it offers, starts a fresh attempt. 2) A fresh
   * WebRTC attempt, watched until it connects, fails or times out. Every step is reported with what it means.
   */
  async probePeer(dev: string, o: { attemptTimeoutMs?: number; replyTimeoutMs?: number } = {}): Promise<PeerProbeResult> {
    const t0 = Date.now();
    const firstSeq = this.traceSeq + 1;
    const steps: PeerProbeStep[] = [];
    const step = (label: string, ok: boolean | null, detail: string) => steps.push({ at: Date.now() - t0, label, ok, detail });
    const role: 'offerer' | 'answerer' = this.selfDev < dev ? 'offerer' : 'answerer';
    const known = this.known.has(dev);
    const onServer = this.onRelay.has(dev);
    const connectedBefore = this.connected(dev);
    this.tr('probe.start', dev, { role, known, onServer, connectedBefore, socketOpen: this.socketOpen });
    const result: PeerProbeResult = {
      dev,
      startedAt: t0,
      durationMs: 0,
      role,
      socketOpen: this.socketOpen,
      known,
      onServer,
      connectedBefore,
      signaling: { delivery: null, replyMs: null },
      remote: null,
      attempt: { outcome: 'skipped', route: null, pair: null, cause: null, error: null, link: null, ms: null },
      steps,
      verdict: '',
      trace: [],
    };
    const finish = (verdict: string) => {
      result.verdict = verdict;
      result.durationMs = Date.now() - t0;
      this.tr('probe.end', dev, { verdict: verdict.slice(0, 120) });
      result.trace = this.recent.filter((r) => r.seq >= firstSeq && (!r.e.dev || r.e.dev === dev)).map((r) => r.e);
      return result;
    };

    step('This device and the signaling service', this.socketOpen, this.socketOpen
      ? 'connected'
      : `not connected${this.doorbellMode ? ' (connects on demand)' : ''}; setup messages can only go through a connected co-author (${this.o.mesh.peers.length} connected)`);
    if (!known) {
      step('Co-author device known', false, 'this device holds no valid ticket for it: it is offline, or its credentials were rejected (see device.rejected in the trace)');
      return finish('This device does not see that co-author online, so there is nothing to connect to.');
    }
    step('Co-author device known', true, onServer ? 'seen connected to the signaling service' : 'known only through another co-author, not seen on the signaling service');
    step('Who offers', null, role === 'offerer' ? 'this device sends the offer (lower device id)' : 'the other device sends the offer (lower device id)');

    // 1) signaling round trip
    const id = Math.random().toString(36).slice(2, 12);
    const replyTimeout = o.replyTimeoutMs ?? 8000;
    const reply = new Promise<PeerSelfReport | null>((resolve) => {
      this.probes.set(id, resolve);
      setTimeout(() => {
        if (this.probes.delete(id)) resolve(null);
      }, replyTimeout);
    });
    const sentAt = Date.now();
    const { delivery, settled } = await this.sendSignal(dev, { k: 'probe', id, retry: !connectedBefore });
    result.signaling.delivery = delivery;
    const remote = await reply;
    // Acknowledgement and delivery receipt: at most the delivery timeout, already elapsed when the reply timed out.
    await Promise.race([settled, new Promise((r) => setTimeout(r, remote ? 6500 : 1500))]);
    if (delivery.via === 'unsent') {
      step('Setup message sent', false, `could not be sent: ${delivery.reason}`);
    } else if (delivery.via === 'mesh') {
      step('Setup message sent', null, 'through a connected co-author (the signaling service is not used for this device)');
    } else {
      step('Setup message sent', true, 'to the signaling service');
      step('Accepted by the service', delivery.accepted, delivery.accepted === null
        ? 'no acknowledgement (service older than 0.7.2, or the message was lost before reaching it)'
        : delivery.targetOnline === false ? 'accepted, but the service does not see the other device connected' : 'accepted; the other device is connected to the service');
      if (delivery.accepted !== null || delivery.delivered) {
        step('Delivered to the other device', delivery.delivered, delivery.delivered
          ? 'the service handed it to the other device\'s connection'
          : 'the service accepted it but did not hand it to the other device\'s connection');
      }
    }
    if (remote) {
      result.remote = remote;
      result.signaling.replyMs = Date.now() - sentAt;
      step('Answer from the other device', true, `in ${result.signaling.replyMs} ms; ${describeRemote(remote)}`);
    } else {
      step('Answer from the other device', false, delivery.delivered
        ? 'none: its connection got the message but its app did not answer (older app version, or it dropped the message; its own report says why)'
        : `none within ${replyTimeout / 1000} s`);
    }

    // 2) a fresh connection attempt
    if (connectedBefore || this.connected(dev)) {
      const r = this.routes()[dev];
      result.attempt = { outcome: 'connected', route: r?.route ?? null, pair: r?.pair ?? null, cause: null, error: null, link: null, ms: 0 };
      step('Connection', true, `already connected ${routeName(r?.route)}${r?.pair ? ` (${r.pair.local} to ${r.pair.remote})` : ''}`);
    } else {
      const attemptStart = Date.now();
      if (!remote) this.retryNow(dev); // the probe did not reach it: still try from this side
      const limit = o.attemptTimeoutMs ?? (this.o.linkTimeoutMs ?? 20_000) + 5000;
      const outcome = await new Promise<'connected' | 'failed' | 'timeout'>((resolve) => {
        const tick = () => {
          if (this.stopped) return resolve('failed');
          if (this.connected(dev)) return resolve('connected');
          const c = this.lastCauses.get(dev);
          if (c && c.at >= attemptStart) return resolve('failed');
          if (Date.now() - attemptStart > limit) return resolve('timeout');
          setTimeout(tick, 200);
        };
        tick();
      });
      const r = this.routes()[dev];
      const c = this.lastCauses.get(dev);
      result.attempt = {
        outcome,
        route: outcome === 'connected' ? (r?.route ?? null) : null,
        pair: outcome === 'connected' ? (r?.pair ?? null) : null,
        cause: outcome === 'connected' ? null : (c?.cause ?? null),
        error: outcome === 'connected' ? null : (this.lastErrors.get(dev) ?? null),
        link: outcome === 'connected' ? null : (this.links.get(dev)?.diag() ?? c?.link ?? null),
        ms: Date.now() - attemptStart,
      };
      if (outcome === 'connected') {
        step('Connection', true, `connected ${routeName(r?.route)} in ${result.attempt.ms} ms${r?.pair ? ` (${r.pair.local} to ${r.pair.remote})` : ''}`);
      } else {
        const l = result.attempt.link;
        step('Connection', false, `${outcome === 'timeout' ? 'no result' : 'failed'} after ${result.attempt.ms} ms; stage: ${result.attempt.cause ?? 'not started'}${l ? `; offer sent ${l.offerSent}, offer received ${l.offerReceived}, answer received ${l.answerReceived}, candidates here ${l.localCandidates.length}, from them ${l.remoteCandidates.length}, ICE ${l.state}` : ''}`);
      }
    }
    return finish(probeVerdict(result));
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
    this.lastCauses.clear();
    for (const [dev, l] of this.links) {
      l.close();
      this.links.delete(dev);
    }
    this.cancel(this.retryTimer);
    this.retryTimer = null;
    this.backoff = 1000;
    if (this.doorbellActive() || (this.o.doorbell && this.o.zeroIdle)) void this.introduce(true);
    this.evaluate();
    for (const k of this.known.values()) if (!this.gone.has(k.claims.dev)) this.maybeConnect(k);
    this.emitState();
  }

  /** The push channel state changed: with it down, fall back to keeping a gatekeeper socket (reachable while open). */
  setDoorbellAvailable(up: boolean) {
    if (!this.o.doorbell || this.doorbellUp === up) return;
    this.doorbellUp = up;
    // Coming up while alone: introduce ourselves once, so devices rung meanwhile can find us.
    if (up && !this.stopped && this.o.mesh.peers.length === 0) void this.introduce(true);
    this.evaluate();
    this.emitState();
  }

  /** True while the device relies on the doorbell (no gatekeeper socket). */
  get doorbellMode() {
    return this.doorbellActive();
  }

  /**
   * A verified ring for this project arrived. Devices not linked to anyone answer, and within an existing mesh only its
   * representative (lowest device id): the others are introduced to the newcomer through peer exchange.
   */
  answerRing() {
    if (this.stopped || !this.doorbellActive()) return;
    const peers = this.o.mesh.peers;
    if (peers.length > 0 && !peers.every((p) => p.deviceId > this.selfDev)) return;
    this.stats.answers++;
    const jitter = (this.o.random ?? Math.random)() * (this.o.answerJitterMs ?? 1500);
    this.later(jitter, () => void this.introduce(false));
  }

  private doorbellActive() {
    return Boolean(this.o.doorbell) && this.doorbellUp;
  }
  // Introduction windows are wall-clock timers (the injected clock is for ticket validity).
  private introducing() {
    return Date.now() < this.introUntil;
  }

  /** Opens the socket for one introduction window, ringing the project first when we are the one looking for peers. */
  private async introduce(ring: boolean) {
    if (this.stopped) return;
    const gen = this.gen;
    if (this.o.ensureTicket) {
      try {
        await this.o.ensureTicket();
      } catch {
        return; // no current authorization: nothing to introduce
      }
      if (this.stopped || gen !== this.gen) return;
    }
    const now = Date.now();
    const windowMs = this.o.introductionWindowMs ?? 30_000;
    this.introUntil = Math.max(this.introUntil, now + windowMs);
    this.introMinUntil = Math.max(this.introMinUntil, now + Math.min(windowMs, this.o.introductionMinMs ?? 8000));
    this.later(this.introMinUntil - now + 1, () => this.evaluate());
    this.later(this.introUntil - now + 1, () => this.evaluate());
    this.evaluate();
    if (ring && this.o.doorbell) {
      this.stats.rings++;
      void this.o.doorbell.ring().catch(() => false);
    }
  }

  /** Every device seen on the server is linked and nothing is still being set up. */
  private introductionDone() {
    if (Date.now() < this.introMinUntil) return false;
    if (this.links.size || this.opening.size || this.authenticating.size) return false;
    return this.o.mesh.peers.length > 0 && [...this.onRelay].every((d) => this.connected(d));
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
    this.tr('manager.start', undefined, { client: this.o.clientInfo ?? 'unknown', doorbell: Boolean(this.o.doorbell), zeroIdle: Boolean(this.o.zeroIdle) });
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
    // Doorbell mode, alone: ring the project and introduce ourselves; afterwards we wait for rings without a socket.
    if (this.doorbellActive() && mesh.peers.length === 0) void this.introduce(true);
    this.evaluate();
  }

  /** Cancels everything this manager owns: timers, socket, links, pending setup and mesh handlers. */
  stop() {
    if (!this.stopped) this.tr('manager.stop');
    this.stopped = true;
    this.gen++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.idleTimer = this.rotateTimer = this.retryTimer = null;
    for (const u of this.unsubs.splice(0)) u();
    const ws = this.ws;
    this.ws = null;
    this.onRelay.clear();
    this.closeRelays();
    this.relayPending.clear();
    ws?.close();
    for (const l of this.links.values()) l.close();
    this.links.clear();
    this.opening.clear();
    this.authenticating.clear();
    this.iceFetch = null;
    this.earlySignals.clear();
  }

  private tr(ev: string, dev?: string, data?: Record<string, string | number | boolean>) {
    const e: TraceEvent = { t: Date.now(), self: this.selfDev, ev, ...(dev !== undefined ? { dev } : {}), ...(data ? { data } : {}) };
    this.recent.push({ seq: ++this.traceSeq, e });
    if (this.recent.length > TRACE_KEEP) this.recent.splice(0, this.recent.length - TRACE_KEEP);
    if (!this.o.trace) return;
    try {
      this.o.trace(e);
    } catch {
      /* a broken trace sink must never affect connecting */
    }
  }

  /** The latest connection steps of this manager (oldest first). */
  trace(): TraceEvent[] {
    return this.recent.map((r) => r.e);
  }

  /** This device as the connection layer sees it. */
  selfDiagnostics(): SelfDiagnostics {
    return {
      dev: this.selfDev,
      client: this.o.clientInfo ?? null,
      socketOpen: this.socketOpen,
      doorbellMode: this.doorbellMode,
      meshPeers: this.o.mesh.peers.length,
      knownDevices: this.known.size,
      onServer: this.onRelay.size,
      stats: { ...this.stats },
    };
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
    if (this.ice && now < this.ice.expiresAt - ICE_REFRESH_MARGIN_MS) {
      this.tr('ice.cached', undefined, { servers: this.ice.servers.length, expiresInS: Math.round((this.ice.expiresAt - now) / 1000) });
      return Promise.resolve(this.ice.servers);
    }
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
      this.tr('ice.request');
      const timer = this.later(this.o.iceTimeoutMs ?? 5000, () => {
        this.tr('ice.timeout');
        this.iceFailed();
        if (!this.ice) this.iceInfoValue = { state: 'failed', relay: { available: false, reason: 'config_unavailable' }, servers: this.stunOnly().length };
        done(this.stunOnly());
      });
      this.o.getIceServers().then(
        (r) => {
          const cfg: IceConfig = Array.isArray(r) ? { iceServers: r } : r;
          // Credentials that arrive after the deadline are still good for the next attempt.
          if (gen === this.gen) {
            this.ice = { servers: cfg.iceServers, expiresAt: cfg.expiresAt ?? this.nowMs() + ICE_DEFAULT_TTL_MS };
            this.iceInfoValue = { state: 'ok', relay: cfg.relay ?? null, servers: cfg.iceServers.length };
            this.tr('ice.ok', undefined, { servers: cfg.iceServers.length, relay: cfg.relay ? `${cfg.relay.available ? 'available' : 'unavailable'}:${cfg.relay.reason}` : 'unknown' });
            this.iceFailures = 0;
            this.iceRetryAt = 0;
          }
          done(cfg.iceServers);
        },
        (e: unknown) => {
          if (gen === this.gen) {
            this.tr('ice.error', undefined, { status: String((e as { status?: unknown } | null)?.status ?? 'n/a') });
            this.iceFailed(e);
            this.iceInfoValue = { state: 'failed', relay: { available: false, reason: 'config_unavailable' }, servers: this.stunOnly().length };
          }
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
    // Relay frames travel over the signaling socket: it stays open while any relay attempt or generation exists.
    if (this.relays.size > 0) return true;
    // Doorbell mode: only while introducing, and no longer once every device seen there is linked.
    if (this.doorbellActive() || (this.o.doorbell && this.o.zeroIdle)) return this.introducing() && !this.introductionDone();
    // A device seen on the server that we are not linked to may be reachable only through the application relay, which
    // needs our socket too: keep it while one is waiting (otherwise a relay-only peer stays cut off from every device
    // that is not the gatekeeper). It closes again once that device is linked or leaves.
    if (this.o.applicationRelay !== false && [...this.onRelay].some((dev) => !this.connected(dev) && !this.gone.has(dev))) return true;
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
    this.tr('socket.opening');
    this.socketHadRelay = false;
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
      this.tr('socket.opened');
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
      this.tr('socket.closed', undefined, { backoffMs: this.backoff });
      this.ws = null;
      this.onRelay.clear();
      // Relay sessions are bound to this socket's session id: they end with it (fresh keys after reconnecting).
      this.selfRelaySid = null;
      const hadRelays = this.relays.size > 0 || this.socketHadRelay;
      this.closeRelays();
      // Relay peers lost their sessions with this socket: both sides introduce themselves again (no ring needed).
      if (hadRelays && this.doorbellActive()) {
        void this.introduce(false);
        return;
      }
      if (this.stopped || (!this.wantSocket() && !hadRelays)) return;
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
    let m: { t: string; nonce?: string; tickets?: string[]; sessions?: Record<string, unknown>; ticket?: string; dev?: string; sid?: string; from?: string; fromSid?: string; fromTicket?: string; env?: string; capabilities?: unknown; code?: string; retryAfterMs?: number; ack?: unknown; online?: unknown };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'err') this.tr('server.err', undefined, { code: String(m.code ?? 'unknown').slice(0, 40) });
    if (m.t === 'challenge' && typeof m.nonce === 'string') {
      this.tr('socket.challenge');
      // Prove we hold the device key named in our ticket (a copied ticket alone must not be enough).
      const gen = this.gen;
      const ticket = this.o.getTicket();
      const sig = await sign(this.o.keys, utf8(signalAuthMessage(this.o.projectId, this.selfDev, m.nonce)));
      if (this.stopped || gen !== this.gen || (ws && this.ws !== ws)) return;
      const capabilities = this.o.applicationRelay === false ? {} : { capabilities: [APPLICATION_RELAY_CAPABILITY] };
      (ws ?? this.ws)?.send(JSON.stringify({ t: 'auth', ticket, sig: toB64u(sig), ...capabilities }));
      return;
    }
    if (m.t === 'sig-ack' && typeof m.ack === 'string') {
      this.acks.get(m.ack)?.onAck(typeof m.online === 'boolean' ? m.online : null);
      return;
    }
    if (m.t === 'sig-delivered' && typeof m.ack === 'string') {
      this.acks.get(m.ack)?.onDelivered();
      return;
    }
    if (m.t === 'pong') return;
    if (m.t === 'app-relay') return void this.onRelayMessage(m);
    if (m.t === 'relay-error') {
      if (typeof m.code === 'string' && RELAY_LIMIT_CODES.has(m.code)) {
        for (const a of this.relays.values()) a.transport?.noteLimited(m.code, Number(m.retryAfterMs) || 30_000);
        this.emitState();
      }
      return;
    }
    if (m.t === 'ready') {
      this.tr('server.ready', undefined, {
        others: (m.tickets ?? []).length,
        session: String(m.sid ?? 'n/a').slice(0, 12),
        relayCapable: Array.isArray(m.capabilities) && m.capabilities.includes(APPLICATION_RELAY_CAPABILITY),
      });
      this.onRelay.clear();
      this.sessions.clear();
      const caps = Array.isArray(m.capabilities) && m.capabilities.includes(APPLICATION_RELAY_CAPABILITY);
      this.selfRelaySid = this.o.applicationRelay !== false && caps && typeof m.sid === 'string' && m.sid.startsWith(RELAY_SESSION_PREFIX) ? m.sid : null;
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
        this.tr('peer.join', k.claims.dev);
        this.onRelay.add(k.claims.dev);
        if (m.sid) {
          // A new signaling session of the peer: a relay generation bound to its old session is dead.
          const a = this.relays.get(k.claims.dev);
          if (a && a.peerSid !== m.sid) this.dropRelay(k.claims.dev, a);
          this.sessions.set(k.claims.dev, m.sid);
          this.scheduleRelay(k.claims.dev);
        }
      }
    } else if (m.t === 'leave' && m.dev) {
      // The leave of an older session of a device that already reconnected (quick reload): not a departure.
      const latest = this.sessions.get(m.dev);
      if (latest && m.sid && m.sid !== latest) return;
      this.tr('peer.leave', m.dev, { connected: this.connected(m.dev) });
      this.sessions.delete(m.dev);
      this.onRelay.delete(m.dev);
      const relay = this.relays.get(m.dev);
      if (relay) this.dropRelay(m.dev, relay);
      if (!this.connected(m.dev)) {
        this.links.get(m.dev)?.close();
        this.links.delete(m.dev);
        this.gone.add(m.dev);
        this.attempts.delete(m.dev);
        this.lastErrors.delete(m.dev);
        this.lastCauses.delete(m.dev);
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
    } catch (e) {
      this.tr('device.rejected', undefined, { reason: (e instanceof Error ? e.message : 'invalid').slice(0, 80), via: viaRelay ? 'server' : 'peer' });
      return null;
    }
    if (claims.pid !== this.o.projectId) {
      this.tr('device.rejected', claims.dev, { reason: 'other project', via: viaRelay ? 'server' : 'peer' });
      return null;
    }
    if (claims.dev === this.selfDev) return null;
    if (!this.known.has(claims.dev)) {
      this.tr('device.learned', claims.dev, {
        via: viaRelay ? 'server' : 'peer',
        role: this.selfDev < claims.dev ? 'offerer' : 'answerer',
        validForS: Math.round((claims.exp * 1000 - Date.now()) / 1000),
        memberRole: claims.role,
      });
    }
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
    this.scheduleRelay(claims.dev);
    this.emitState();
    return k;
  }

  private connected(dev: string) {
    return this.o.mesh.peers.some((p) => p.deviceId === dev);
  }
  /** Connected over a WebRTC data channel (host, STUN or TURN), not the application relay. */
  private connectedDirect(dev: string) {
    return this.o.mesh.peers.some((p) => p.deviceId === dev && p.conn.transportKind !== 'relay');
  }

  /**
   * An attempt towards `dev` already exists: directly connected, being set up, linking, or authenticating. A peer reached
   * only through the application relay still gets direct attempts, so the link moves back to a direct path when it can.
   */
  private busy(dev: string) {
    return this.connectedDirect(dev) || this.links.has(dev) || this.opening.has(dev) || this.authenticating.has(dev);
  }

  /** The route of every connected peer, for the UI. */
  routes(): Record<string, RouteState> {
    const out: Record<string, RouteState> = {};
    for (const p of this.o.mesh.peers) {
      const t = p.conn.transport;
      out[p.deviceId] = t instanceof RelayTransport
        ? { route: 'relay', limited: t.limited ? (t.stats.limitedReason ?? 'relay_limited') : null }
        : { route: (t as { path?: string }).path === 'turn' ? 'turn' : 'direct', limited: null, pair: (t as { pair?: { local: string; remote: string } | null }).pair ?? null };
    }
    return out;
  }

  /** The device with the lower id initiates, so exactly one side offers. */
  private maybeConnect(k: Known) {
    const dev = k.claims.dev;
    if (this.stopped || this.busy(dev)) return;
    if (this.selfDev > dev && !this.waitTraced.has(dev)) {
      this.waitTraced.add(dev);
      this.tr('attempt.wait', dev, { role: 'answerer', note: 'the other device sends the offer' });
    }
    if (this.selfDev < dev) {
      this.tr('attempt.start', dev, { role: 'offerer', attempt: (this.attempts.get(dev) ?? 0) + 1 });
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
      this.recordCause(dev, link, initiator, 'timeout');
      this.tr('link.timeout', dev, { cause: this.lastCauses.get(dev)?.cause ?? 'n/a' });
      this.retryLater(dev);
    });
    this.stage(dev).firstAttemptAt ??= Date.now();
    const link = new RtcLink({
      factory: this.o.rtcFactory,
      iceServers: ice,
      initiator,
      trace: (ev, data) => this.tr(`link.${ev}`, dev, data),
      send: (s) => void this.sendSignal(dev, s),
      onTransport: (t) => {
        this.cancel(timer);
        this.tr('link.up', dev);
        if (this.links.get(dev) === link) this.links.delete(dev);
        if (this.stopped || gen !== this.gen) return void t.close();
        // The attempt keeps owning the device until the mesh has authenticated (or refused) the transport.
        this.authenticating.add(dev);
        this.o.mesh
          .addTransport(t)
          .then(() => this.tr('mesh.auth-ok', dev, { route: (t as { path?: string }).path ?? 'unknown' }))
          .catch((e: unknown) => {
            this.tr('mesh.auth-failed', dev, { error: (e instanceof Error ? e.message : 'refused').slice(0, 120) });
            this.retryLater(dev);
          })
          .finally(() => {
            if (gen === this.gen) this.authenticating.delete(dev);
          });
      },
      onFail: (why) => {
        this.cancel(timer);
        if (this.links.get(dev) === link) this.links.delete(dev);
        this.lastErrors.set(dev, why);
        this.recordCause(dev, link, initiator, why);
        this.tr('link.failed', dev, { why: why.slice(0, 120), cause: this.lastCauses.get(dev)?.cause ?? 'n/a' });
        this.retryLater(dev);
      },
    });
    this.links.set(dev, link);
    this.tr('link.created', dev, { role: initiator ? 'offerer' : 'answerer' });
    this.emitState();
    return link;
  }

  /** Remembers where a failed attempt stopped; a thrown setup error keeps its own text instead of a stage. */
  private recordCause(dev: string, link: RtcLink, initiator: boolean, why: string) {
    const d = link.diag();
    const signalError = !/^(timeout|connection (failed|closed|disconnected))$/.test(why);
    this.lastCauses.set(dev, { cause: signalError ? 'link-error' : attemptCause(d, initiator), link: d, at: Date.now() });
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
    this.earlySignals.delete(dev);
    this.stage(dev).attempts = n;
    this.emitState();
    // Reached through the relay already: direct attempts continue, but rarely (each one costs signaling).
    const viaRelay = this.connected(dev);
    const cap = viaRelay ? Math.max(this.o.maxBackoffMs ?? 30_000, this.o.directRetryMs ?? 60_000) : this.o.maxBackoffMs ?? 30_000;
    if (!viaRelay) this.scheduleRelay(dev, 0);
    const base = Math.min(cap, (this.o.linkTimeoutMs ?? 20_000) < 1000 ? 100 * 2 ** Math.min(n, 20) : 1000 * 2 ** Math.min(n - 1, 20));
    this.tr('retry.scheduled', dev, { attempt: n, inMs: base, viaRelay });
    this.later(base, () => {
      const k = this.known.get(dev);
      if (k && !this.gone.has(dev)) this.maybeConnect(k);
    });
  }

  // ---- encrypted signaling ----

  private aad(from: string, to: string) {
    return `${this.o.projectId}|${from}|${to}`;
  }

  /**
   * Seals and sends one setup message. Offers, answers and probes ask the service for an acknowledgement and a delivery
   * receipt (diagnostics only: nothing waits for them except a connection test); `settled` resolves when both arrived
   * or timed out.
   */
  private async sendSignal(to: string, sig: WireSignal): Promise<{ delivery: SignalDelivery; settled: Promise<void> }> {
    const unsent = (reason: string) => {
      this.tr('sig.unsent', to, { k: sig.k, reason });
      return { delivery: { via: 'unsent' as const, reason, accepted: null, targetOnline: null, delivered: false }, settled: Promise.resolve() };
    };
    const peer = this.known.get(to);
    if (this.stopped) return { delivery: { via: 'unsent', reason: 'stopped', accepted: null, targetOnline: null, delivered: false }, settled: Promise.resolve() };
    if (!peer) return unsent('unknown-device');
    const gen = this.gen;
    const env = await seal(this.o.keys, peer.claims.devX, utf8(JSON.stringify(sig)), this.aad(this.selfDev, to));
    if (this.stopped || gen !== this.gen) return unsent('stopped'); // stopped while sealing: transmit nothing
    if (this.socketOpen && (this.onRelay.has(to) || this.o.mesh.peers.length === 0)) {
      this.stats.signalsViaServer++;
      const delivery: SignalDelivery = { via: 'server', accepted: null, targetOnline: null, delivered: false };
      const ack = sig.k === 'ice' ? undefined : `${sig.k}-${Math.random().toString(36).slice(2, 10)}`;
      this.tr('sig.send', to, { k: sig.k, via: 'server', targetSeenOnServer: this.onRelay.has(to), ...(ack ? { ack } : {}) });
      const settled = ack ? this.watchAck(ack, to, sig.k, delivery) : Promise.resolve();
      this.ws?.send(JSON.stringify({ t: 'sig', to, env: b64(env), ...(ack ? { ack } : {}) }));
      return { delivery, settled };
    }
    // No socket: relay through a peer. Prefer one that announced a direct link to the target; any other peer
    // passes it one more hop (see onRtcViaMesh). An arbitrary peer that is not linked to the target would drop it.
    const linkedVia = this.o.mesh.peersLinkedTo(to)[0];
    const via = linkedVia ?? this.o.mesh.peers.find((p) => p.deviceId !== to)?.deviceId;
    if (!via) return unsent(this.socketOpen ? 'target-not-seen-on-server-and-no-peer' : 'no-socket-and-no-peer');
    this.stats.signalsViaMesh++;
    this.tr('sig.send', to, {
      k: sig.k,
      via: 'mesh',
      peer: shortId(via),
      peerLinkedToTarget: Boolean(linkedVia),
      socketOpen: this.socketOpen,
      targetSeenOnServer: this.onRelay.has(to),
    });
    await this.o.mesh.sendApp(via, 'rtc', { to, from: this.selfDev, fromTicket: this.o.getTicket(), env: b64(env), hops: RTC_HOPS } satisfies RtcEnvelope);
    return { delivery: { via: 'mesh', accepted: null, targetOnline: null, delivered: false }, settled: Promise.resolve() };
  }

  /** Records the service's acknowledgement and delivery receipt of one message (or their absence). */
  private watchAck(ack: string, to: string, k: string, delivery: SignalDelivery): Promise<void> {
    // Settled once both the acknowledgement and the delivery receipt are known (arrived, or given up on). They may
    // arrive in either order: the service publishes the message before it answers the sender.
    return new Promise<void>((resolve) => {
      let ackKnown = false;
      let deliveryKnown = false;
      const settle = () => {
        if (!ackKnown || !deliveryKnown) return;
        this.acks.delete(ack);
        resolve();
      };
      const ackTimer = this.later(4000, () => {
        if (ackKnown) return;
        ackKnown = true;
        this.tr('sig.no-server-ack', to, { k, ack, note: 'older service, or the message was lost before the service' });
        settle();
      });
      const deliveryTimer = this.later(6000, () => {
        if (deliveryKnown) return;
        deliveryKnown = true;
        this.tr('sig.not-delivered', to, { k, ack, accepted: delivery.accepted ?? 'unknown', targetOnline: delivery.targetOnline ?? 'unknown' });
        settle();
      });
      this.acks.set(ack, {
        onAck: (online) => {
          if (ackKnown) return;
          ackKnown = true;
          this.cancel(ackTimer);
          delivery.accepted = true;
          delivery.targetOnline = online;
          this.tr('sig.server-ack', to, { k, ack, targetOnline: online ?? 'unknown' });
          settle();
        },
        onDelivered: () => {
          if (deliveryKnown) return;
          deliveryKnown = true;
          this.cancel(deliveryTimer);
          delivery.delivered = true;
          this.tr('sig.delivered', to, { k, ack });
          settle();
        },
      });
    });
  }

  private async onEnvelope(fromTicket: string, env: Uint8Array) {
    const gen = this.gen;
    const k = await this.learn(fromTicket);
    if (!k || this.stopped || gen !== this.gen) {
      if (!k && !this.stopped) this.tr('sig.dropped', undefined, { reason: 'sender-ticket-rejected' });
      return;
    }
    let wire: WireSignal;
    try {
      wire = JSON.parse(fromUtf8(await open(this.o.keys, k.claims.devX, env, this.aad(k.claims.dev, this.selfDev)))) as WireSignal;
    } catch {
      this.tr('sig.dropped', k.claims.dev, { reason: 'cannot-decrypt' });
      return; // not for us / tampered
    }
    if (this.stopped || gen !== this.gen) return;
    this.tr('sig.recv', k.claims.dev, { k: wire.k });
    if (wire.k === 'probe') return void this.answerProbe(k.claims.dev, wire);
    if (wire.k === 'probe-reply') {
      const waiter = this.probes.get(wire.id);
      if (waiter) {
        this.probes.delete(wire.id);
        waiter(wire.state);
      }
      return;
    }
    const sig: LinkSignal = wire;
    let link: RtcLink | null | undefined = this.links.get(k.claims.dev);
    // An offer from a device we still think is connected means it restarted: answer it; the mesh replaces the old link.
    // (An attempt already in setup is shared, not duplicated.)
    if (!link && sig.k === 'offer') link = await this.attempt(k.claims.dev, false);
    if (!link) {
      // The offerer trickles candidates right after its offer; the answering link may not exist yet. Keep them (bounded).
      if (sig.k === 'ice') {
        const early = this.earlySignals.get(k.claims.dev) ?? [];
        if (early.length < EARLY_SIGNALS_MAX) early.push(sig);
        this.tr('sig.held', k.claims.dev, { k: sig.k, held: early.length });
        this.earlySignals.set(k.claims.dev, early);
      }
      return;
    }
    await link.handle(sig);
    if (sig.k === 'offer') {
      const held = this.earlySignals.get(k.claims.dev)?.splice(0) ?? [];
      if (held.length) this.tr('sig.applied-held', k.claims.dev, { count: held.length });
      for (const e of held) await link.handle(e);
    }
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
      if (hops > 0 && next) {
        this.tr('sig.forwarded', body.to, { from: shortId(body.from), next: shortId(next), hops });
        await this.o.mesh.sendApp(next, 'rtc', { ...body, hops });
      } else {
        this.tr('sig.forward-dropped', body.to, { from: shortId(body.from), reason: hops > 0 ? 'no peer linked to the target' : 'hop limit' });
      }
    }
  }

  // ---- application relay (D11/D12) ----

  private relayCapable(dev: string) {
    return Boolean(this.selfRelaySid && this.socketOpen && this.onRelay.has(dev) && this.sessions.get(dev)?.startsWith(RELAY_SESSION_PREFIX));
  }

  /** Checks after `ms` whether `dev` still lacks a usable link and, if so, starts relay setup (initiator: lower id). */
  private scheduleRelay(dev: string, ms = this.o.relayAfterMs ?? 8000) {
    if (this.stopped || this.o.applicationRelay === false || this.selfDev > dev || this.relayPending.has(dev)) return;
    const failures = this.relayFailures.get(dev) ?? 0;
    const wait = failures ? Math.max(ms, Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 10))) : ms;
    this.relayPending.add(dev);
    this.later(wait, () => {
      this.relayPending.delete(dev);
      if (this.connected(dev) || this.relays.has(dev) || !this.relayCapable(dev)) return;
      // TURN costs the control plane nothing per byte, a relay session holds sockets: with TURN credentials configured,
      // wait until that WebRTC attempt failed or timed out (retryLater schedules the relay again then).
      if (this.turnConfigured() && (this.attempts.get(dev) ?? 0) === 0) return;
      void this.startRelay(dev);
    });
  }

  private turnConfigured() {
    return (this.ice?.servers ?? []).some((x) => (x as { credential?: unknown }).credential !== undefined);
  }

  private relayFailed(dev: string) {
    this.stats.relayFailures++;
    this.relayFailures.set(dev, (this.relayFailures.get(dev) ?? 0) + 1);
    if (!this.connected(dev)) this.scheduleRelay(dev, 0);
  }

  private postRelay(dev: string, sid: string, env: string) {
    const ws = this.ws;
    if (this.stopped || !ws || ws.readyState !== WS_OPEN || env.length > 60 * 1024) return false;
    ws.send(JSON.stringify({ t: 'app-relay', to: dev, sid, env }));
    return true;
  }

  private dropRelay(dev: string, a: RelayAttempt) {
    if (this.relays.get(dev) === a) this.relays.delete(dev);
    this.cancel(a.timer);
    a.handshake?.close();
    a.handshake = null;
    a.transport?.close();
    this.evaluate();
  }

  private closeRelays() {
    for (const [dev, a] of [...this.relays]) this.dropRelay(dev, a);
  }

  private relayTimeout(dev: string, a: RelayAttempt) {
    this.cancel(a.timer);
    a.timer = this.later(12_000, () => {
      if (this.relays.get(dev) !== a || a.transport) return;
      this.dropRelay(dev, a);
      this.relayFailed(dev);
    });
  }

  private async startRelay(dev: string) {
    const peerSid = this.sessions.get(dev);
    if (!peerSid) return;
    this.tr('relay.start', dev);
    const a: RelayAttempt = { gen: this.gen, id: '', role: 'initiator', peerSid, handshake: null, transport: null, timer: null };
    this.relays.set(dev, a); // reserved before any await
    try {
      const hs = await RelayHandshake.create({
        projectId: this.o.projectId, peerDeviceId: dev, ticket: this.o.getTicket(), keys: this.o.keys, trusted: this.o.trusted, role: 'initiator',
        ...(this.o.now ? { now: () => this.nowMs() } : {}),
      });
      if (this.relays.get(dev) !== a || a.gen !== this.gen) return void hs.close();
      a.handshake = hs;
      a.id = hs.hello.generation;
      this.stats.relaySetups++;
      this.relayTimeout(dev, a);
      if (!this.postRelay(dev, peerSid, encodeRelayHandshake({ g: a.id, hello: hs.hello }))) throw new Error('signaling socket closed');
    } catch {
      if (this.relays.get(dev) !== a) return;
      this.dropRelay(dev, a);
      this.relayFailed(dev);
    }
  }

  private onRelayMessage(m: { from?: string; fromSid?: string; env?: string }) {
    const from = m.from;
    const fromSid = m.fromSid;
    if (typeof from !== 'string' || typeof fromSid !== 'string' || typeof m.env !== 'string' || this.stopped) return;
    const w = decodeRelayWire(m.env);
    if (!w) return;
    if (w.kind === 'frame') {
      // Frames of an unknown or older session are dropped; the sender retransmits within its budget.
      const a = this.relays.get(from);
      if (a?.transport && a.peerSid === fromSid && w.envelope.session === a.transport.sessionId) void a.transport.receive(w.envelope);
      return;
    }
    const prev = this.relayChains.get(from) ?? Promise.resolve();
    const next = prev.then(() => this.onRelayHandshake(from, fromSid, w.body as RelayStep)).catch(() => {});
    this.relayChains.set(from, next);
    void next.finally(() => {
      if (this.relayChains.get(from) === next) this.relayChains.delete(from);
    });
  }

  private async onRelayHandshake(from: string, fromSid: string, b: RelayStep) {
    if (!b || typeof b.g !== 'string' || !this.selfRelaySid || this.stopped) return;
    const gen = this.gen;
    let a = this.relays.get(from);
    try {
      if (b.hello && b.proof === undefined && from < this.selfDev) {
        // The peer (lower id) starts a generation: answer it, replacing any older attempt of that device.
        if (a && a.id === b.g) return;
        if (this.connectedDirect(from)) return; // never downgrade a working direct link
        if (a) this.dropRelay(from, a);
        const own: RelayAttempt = { gen, id: b.g, role: 'responder', peerSid: fromSid, handshake: null, transport: null, timer: null };
        a = own;
        this.relays.set(from, own);
        this.relayTimeout(from, own);
        const hs = await RelayHandshake.create({
          projectId: this.o.projectId, peerDeviceId: from, ticket: this.o.getTicket(), keys: this.o.keys, trusted: this.o.trusted, role: 'responder',
          ...(this.o.now ? { now: () => this.nowMs() } : {}),
        });
        if (this.relays.get(from) !== own || gen !== this.gen) return void hs.close();
        own.handshake = hs;
        const proof = await hs.acceptHello(b.hello);
        if (this.relays.get(from) !== own || gen !== this.gen) return;
        this.postRelay(from, fromSid, encodeRelayHandshake({ g: own.id, hello: hs.hello, proof }));
        return;
      }
      if (!a || a.id !== b.g || !a.handshake || a.gen !== gen || a.peerSid !== fromSid) return;
      const cur = a;
      const hs = cur.handshake as RelayHandshake;
      if (cur.role === 'initiator' && b.hello && typeof b.proof === 'string') {
        const proof = await hs.acceptHello(b.hello);
        const confirm = await hs.acceptProof(b.proof);
        if (this.relays.get(from) !== cur) return;
        this.postRelay(from, fromSid, encodeRelayHandshake({ g: cur.id, proof, confirm }));
      } else if (cur.role === 'responder' && typeof b.proof === 'string' && typeof b.confirm === 'string') {
        const confirm = await hs.acceptProof(b.proof);
        const session = await hs.acceptConfirmation(b.confirm);
        if (this.relays.get(from) !== cur) return void session.close();
        this.postRelay(from, fromSid, encodeRelayHandshake({ g: cur.id, confirm }));
        this.relayEstablished(from, cur, session);
      } else if (cur.role === 'initiator' && typeof b.confirm === 'string' && b.proof === undefined) {
        const session = await hs.acceptConfirmation(b.confirm);
        this.relayEstablished(from, cur, session);
      }
    } catch {
      if (a && this.relays.get(from) === a) {
        this.dropRelay(from, a);
        this.relayFailed(from);
      }
    }
  }

  private relayEstablished(dev: string, a: RelayAttempt, session: RelaySession) {
    if (this.relays.get(dev) !== a || a.gen !== this.gen || this.stopped || this.connectedDirect(dev)) {
      session.close();
      if (this.relays.get(dev) === a) this.dropRelay(dev, a);
      return;
    }
    this.cancel(a.timer);
    a.timer = null;
    a.handshake = null;
    this.socketHadRelay = true;
    const t = new RelayTransport({ ...this.o.relayTransport, session, post: (env) => this.postRelay(dev, a.peerSid, env) });
    a.transport = t;
    t.onClosed(() => {
      if (this.relays.get(dev) !== a) return;
      this.relays.delete(dev);
      this.evaluate();
      this.emitState();
      if (!this.connected(dev) && this.onRelay.has(dev)) this.relayFailed(dev);
      else if (!this.connected(dev) && this.doorbellActive()) void this.introduce(false);
    });
    this.authenticating.add(dev);
    const gen = this.gen;
    this.o.mesh
      .addTransport(t)
      .then(() => {
        this.relayFailures.delete(dev);
        this.emitState();
      })
      .catch(() => t.close())
      .finally(() => {
        if (gen === this.gen) this.authenticating.delete(dev);
      });
  }

  // ---- peer exchange ----

  private onPeerJoin(p: PeerInfo) {
    const viaRelay = p.conn.transportKind === 'relay';
    if (!viaRelay) this.attempts.delete(p.deviceId);
    this.lastErrors.delete(p.deviceId);
    this.lastCauses.delete(p.deviceId);
    this.gone.delete(p.deviceId);
    this.stage(p.deviceId).linkUpAt = Date.now();
    this.emitState();
    this.reannounced.delete(p.deviceId);
    if (viaRelay) {
      // Keep trying a direct path: when it authenticates, the mesh replaces the relay connection (handover).
      const k = this.known.get(p.deviceId);
      if (k && !this.links.has(p.deviceId)) this.later(this.o.directRetryMs ?? 60_000, () => this.maybeConnect(k));
    } else {
      this.links.get(p.deviceId)?.close();
      this.links.delete(p.deviceId);
      // A direct link took over: the relay generation of this device ends (the mesh already closed its connection).
      const relay = this.relays.get(p.deviceId);
      if (relay) this.dropRelay(p.deviceId, relay);
    }
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

