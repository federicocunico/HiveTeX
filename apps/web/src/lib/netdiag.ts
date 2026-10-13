import type { AttemptCause, Candidate, IceInfo, LinkDiag, RouteState } from '@hivetex/sync';
import { type MappingState, mappingText } from './sync-view.js';

/** One ICE server as returned by the service. Credentials are only ever passed to the probes, never shown or copied. */
export interface IceServerCfg {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type CheckId = 'signaling' | 'ice-config' | 'stun' | 'relay' | 'port-mapping';
export type CheckStatus = 'idle' | 'running' | 'pass' | 'warn' | 'fail' | 'na';

export interface CheckResult {
  id: CheckId;
  label: string;
  status: CheckStatus;
  /** Plain-language outcome, free of credentials. */
  detail: string;
  ms?: number;
}

export const CHECKS: Array<{ id: CheckId; label: string }> = [
  { id: 'signaling', label: 'Signaling service' },
  { id: 'ice-config', label: 'Connection servers (STUN / relay)' },
  { id: 'stun', label: 'UDP and public address (STUN)' },
  { id: 'relay', label: 'Relay (TURN)' },
  { id: 'port-mapping', label: 'Router port mapping' },
];

export interface GatherResult {
  /** Candidate types seen, in order (host, srflx, prflx, relay). */
  types: string[];
  /** Server-reflexive address and port, when one was found. Shown on the page, left out of the report. */
  srflx: Array<{ ip: string; port: number }>;
  error?: string;
}

/** Everything the checks need from the outside world, so they can be tested without a network. */
export interface NetEnv {
  fetchIce(): Promise<{ iceServers: IceServerCfg[]; relay?: { available: boolean; reason: string } }>;
  /** Gathers candidates against the given servers; `relayOnly` forces relay candidates. */
  gather(servers: IceServerCfg[], opts: { relayOnly: boolean; timeoutMs: number }): Promise<GatherResult>;
  /** The live signaling socket state of the open project: open, 'idle' (opens on demand), closed, or null with no project open. */
  signalingOpen(): boolean | 'idle' | null;
  /** Router port mapping (desktop only); null when the platform has none. */
  mapping(): Promise<MappingState | null>;
}

const urlsOf = (s: IceServerCfg): string[] => (Array.isArray(s.urls) ? s.urls : [s.urls]);
const isStun = (u: string) => u.startsWith('stun:') || u.startsWith('stuns:');
const isTurn = (u: string) => u.startsWith('turn:') || u.startsWith('turns:');

/** Splits the configured servers into those that only help discover addresses and those that relay traffic. */
export function splitServers(servers: IceServerCfg[]): { stun: string[]; turn: string[]; turnTcpOrTls: boolean } {
  const all = servers.flatMap(urlsOf);
  const turn = all.filter(isTurn);
  return {
    stun: all.filter(isStun),
    turn,
    turnTcpOrTls: turn.some((u) => u.startsWith('turns:') || /transport=tcp/.test(u)),
  };
}

/** Parses the address out of an SDP candidate line (`... udp <prio> <ip> <port> typ srflx ...`). */
export function parseCandidate(line: string): { type: string; ip: string; port: number } | null {
  const m = /candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ (host|srflx|prflx|relay)/.exec(line);
  return m ? { type: m[3] as string, ip: m[1] as string, port: Number(m[2]) } : null;
}

const RELAY_REASON: Record<string, string> = {
  not_configured: 'No relay is configured on the service. Peers behind strict NATs or firewalls may be unable to connect.',
  mint_failed: 'The service has a relay but could not issue credentials. Peers behind strict NATs may be unable to connect.',
  config_unavailable: 'The connection servers could not be loaded, so only public STUN servers are used.',
};

const time = async <T>(fn: () => Promise<T>): Promise<{ v: T; ms: number }> => {
  const t = Date.now();
  const v = await fn();
  return { v, ms: Date.now() - t };
};

/** Runs every check in order, reporting each result as soon as it is known. */
export async function runChecks(env: NetEnv, onUpdate: (r: CheckResult[]) => void = () => {}): Promise<CheckResult[]> {
  const out: CheckResult[] = CHECKS.map((c) => ({ ...c, status: 'idle', detail: '' }));
  const set = (id: CheckId, patch: Partial<CheckResult>) => {
    const r = out.find((x) => x.id === id) as CheckResult;
    Object.assign(r, patch);
    onUpdate(out.map((x) => ({ ...x })));
  };
  const open = env.signalingOpen();
  set('signaling', open === null
    ? { status: 'na', detail: 'Open a project to check the live signaling connection.' }
    : open === 'idle'
      ? { status: 'pass', detail: 'Connects on demand: nobody else is online to meet right now.' }
      : open
      ? { status: 'pass', detail: 'Connected to the signaling service.' }
      : { status: 'fail', detail: 'Not connected to the signaling service. Co-authors cannot find this device.' });

  set('ice-config', { status: 'running', detail: 'Asking the service for connection servers…' });
  let servers: IceServerCfg[] = [];
  let relayInfo: { available: boolean; reason: string } | undefined;
  try {
    const { v, ms } = await time(() => env.fetchIce());
    servers = v.iceServers;
    relayInfo = v.relay;
    const s = splitServers(servers);
    const relayKnown = s.turn.length > 0;
    set('ice-config', {
      status: relayKnown ? 'pass' : 'warn',
      ms,
      detail: `${s.stun.length} STUN address${s.stun.length === 1 ? '' : 'es'}, ${relayKnown ? 'relay credentials issued' : `no relay available${relayInfo ? `: ${RELAY_REASON[relayInfo.reason] ?? relayInfo.reason}` : ''}`}.`,
    });
  } catch (e) {
    set('ice-config', { status: 'fail', detail: `Could not load connection servers (${e instanceof Error ? e.message : 'error'}). Only public STUN servers are used.` });
    relayInfo = { available: false, reason: 'config_unavailable' };
  }

  const { stun, turn, turnTcpOrTls } = splitServers(servers);
  const stunServers: IceServerCfg[] = stun.length ? stun.map((u) => ({ urls: u })) : [{ urls: 'stun:stun.l.google.com:19302' }];
  set('stun', { status: 'running', detail: 'Contacting STUN servers…' });
  const probes = await time(() => Promise.all(stunServers.slice(0, 2).map((s) => env.gather([s], { relayOnly: false, timeoutMs: 4000 }))));
  const reflexive = probes.v.flatMap((p) => p.srflx);
  if (reflexive.length === 0) {
    set('stun', { status: 'fail', ms: probes.ms, detail: `No STUN answer: UDP appears blocked on this network.${turnTcpOrTls ? ' A TCP/TLS relay route is configured.' : ''}` });
  } else {
    const ports = new Set(probes.v.map((p) => p.srflx[0]?.port).filter((p) => p !== undefined));
    const mapping = probes.v.length < 2 || probes.v.some((p) => p.srflx.length === 0)
      ? 'mapping type not determined'
      : ports.size === 1
        ? 'the router keeps the same port for different destinations (direct connections likely)'
        : 'the router uses a different port per destination (symmetric NAT: direct connections often fail without a relay)';
    set('stun', {
      status: ports.size > 1 ? 'warn' : 'pass',
      ms: probes.ms,
      detail: `Public address ${reflexive[0]?.ip}: ${mapping}.`,
    });
  }

  if (turn.length === 0) {
    set('relay', { status: 'warn', detail: relayInfo ? (RELAY_REASON[relayInfo.reason] ?? 'No relay available.') : 'No relay available.' });
  } else {
    set('relay', { status: 'running', detail: 'Contacting the relay…' });
    const r = await time(() => env.gather(servers, { relayOnly: true, timeoutMs: 6000 }));
    set('relay', r.v.types.includes('relay')
      ? { status: 'pass', ms: r.ms, detail: 'The relay answered: peers that cannot connect directly can still be reached.' }
      : { status: 'fail', ms: r.ms, detail: `The relay did not answer${r.v.error ? ` (${r.v.error})` : ''}. It may be blocked on this network.` });
  }

  const m = await env.mapping().catch(() => null);
  set('port-mapping', m === null
    ? { status: 'na', detail: 'Only the desktop app maps router ports.' }
    : { status: m.state === 'mapped' || m.state === 'renewing' ? 'pass' : m.state === 'failed' ? 'warn' : 'na', detail: mappingText(m) });
  return out;
}

export type PeerVerdict =
  | { ok: true; route: string; pair: string | null }
  | { ok: false; reason: 'offline' | 'timeout'; cause: AttemptCause | null; detail: string };

/** Plain-language explanation for a recorded failure stage. */
export function causeText(cause: AttemptCause | null, link: LinkDiag | null, error: string | null): string {
  switch (cause) {
    case 'no-setup-reply': return 'The other device never answered the connection request. It may be offline, asleep, or unable to reach the signaling service.';
    case 'no-candidates': return 'No network candidates were received from the other device. Connection setup messages may be getting lost.';
    case 'checks-failed': return `Both devices exchanged addresses but no network path worked${link ? ` (here: ${list(link.localCandidates)}; there: ${list(link.remoteCandidates)})` : ''}. A relay is usually needed.`;
    case 'link-error': return error ? `The connection failed: ${error}.` : 'The connection failed.';
    default: return error ?? 'No attempt result yet.';
  }
}

const list = (types: string[]): string => {
  if (types.length === 0) return 'none';
  const n = new Map<string, number>();
  for (const t of types) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].map(([t, c]) => (c > 1 ? `${t}×${c}` : t)).join(', ');
};
export { list as candidateSummary };

export interface PeerRow {
  dev: string;
  name: string;
  state: 'connected' | 'connecting';
  route?: string;
  pair?: string | null;
  attempts?: number;
  cause?: AttemptCause | null;
  explanation?: string;
  linkState?: string | undefined;
  local?: string | undefined;
  remote?: string | undefined;
}

const ROUTE_NAME: Record<string, string> = { direct: 'direct', turn: 'through the relay (TURN)', relay: 'through the application relay' };

/** One row per co-author, from the live connection diagnostics. */
export function peerRows(
  peers: Array<{ dev: string; uname: string; route?: string }>,
  connecting: Candidate[],
  routes: Record<string, RouteState>,
): PeerRow[] {
  const rows: PeerRow[] = peers.map((p) => {
    const r = routes[p.dev];
    const route = r?.route ?? p.route ?? 'direct';
    return { dev: p.dev, name: p.uname, state: 'connected', route: ROUTE_NAME[route] ?? route, pair: r?.pair ? `${r.pair.local} ↔ ${r.pair.remote}` : null };
  });
  for (const c of connecting) {
    rows.push({
      dev: c.dev,
      name: c.uname,
      state: 'connecting',
      attempts: c.attempts,
      cause: c.cause,
      linkState: c.link?.state,
      local: c.link ? list(c.link.localCandidates) : undefined,
      remote: c.link ? list(c.link.remoteCandidates) : undefined,
      explanation: causeText(c.cause, c.link, c.lastError),
    });
  }
  return rows;
}

/**
 * The outcome of a peer test, judged from the live state: connected if the device is among the peers, otherwise the
 * failure stage of its latest attempt. `waitedMs` is how long the test has been running.
 */
export function peerVerdict(dev: string, peers: Array<{ dev: string }>, connecting: Candidate[], routes: Record<string, RouteState>, waitedMs: number, timeoutMs: number): PeerVerdict | null {
  if (peers.some((p) => p.dev === dev)) {
    const r = routes[dev];
    return { ok: true, route: ROUTE_NAME[r?.route ?? 'direct'] ?? 'direct', pair: r?.pair ? `${r.pair.local} ↔ ${r.pair.remote}` : null };
  }
  const c = connecting.find((x) => x.dev === dev);
  if (!c) return { ok: false, reason: 'offline', cause: null, detail: 'That co-author is not online.' };
  if (waitedMs >= timeoutMs) return { ok: false, reason: 'timeout', cause: c.cause, detail: causeText(c.cause, c.link, c.lastError) };
  return null;
}

/** Text for *Copy report*. Built from an allow-list of fields: no credentials, tokens, keys, addresses or content. */
export function buildReport(input: {
  results: CheckResult[];
  ice: IceInfo | null;
  rows: PeerRow[];
  app: string;
  when: Date;
  /** The latest connection steps (types and counts only, no addresses or credentials). */
  trace?: Array<{ t: number; self: string; ev: string; dev?: string; data?: Record<string, string | number | boolean> }>;
}): string {
  const lines = [`HiveTeX network report (${input.app})`, input.when.toISOString(), ''];
  lines.push('Checks');
  for (const r of input.results) lines.push(`- ${r.label}: ${r.status}${r.ms !== undefined ? ` (${r.ms} ms)` : ''}. ${r.detail.replace(/Public address \S+:/, 'Public address (hidden):')}`);
  if (input.ice) lines.push('', `Connection servers: ${input.ice.state}, ${input.ice.servers} server(s), relay ${input.ice.relay ? `${input.ice.relay.available ? 'available' : 'unavailable'} (${input.ice.relay.reason})` : 'unknown'}`);
  lines.push('', 'Co-authors');
  if (input.rows.length === 0) lines.push('- none online');
  for (const p of input.rows) {
    lines.push(p.state === 'connected'
      ? `- ${p.name}: connected ${p.route}${p.pair ? ` [${p.pair}]` : ''}`
      : `- ${p.name}: not connected, attempt ${(p.attempts ?? 0) + 1}, state ${p.linkState ?? 'n/a'}, cause ${p.cause ?? 'none yet'}; local candidates: ${p.local ?? 'n/a'}; remote candidates: ${p.remote ?? 'n/a'}. ${p.explanation ?? ''}`);
  }
  if (input.trace && input.trace.length > 0) {
    const short = (id: string) => id.slice(0, 6);
    const last = input.trace.slice(-100);
    const start = last[0]?.t ?? 0;
    lines.push('', `Connection trace (last ${last.length} steps; device ids shortened)`);
    for (const e of last) {
      const data = e.data ? ` ${Object.entries(e.data).map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
      lines.push(`+${String(e.t - start).padStart(6)} ms ${short(e.self)}${e.dev ? ` -> ${short(e.dev)}` : ''} ${e.ev}${data}`);
    }
  }
  return lines.join('\n');
}

/** Browser implementation of `NetEnv.gather`: a throwaway peer connection that only gathers candidates. */
export function browserGather(PC: typeof RTCPeerConnection = RTCPeerConnection): NetEnv['gather'] {
  return (servers, { relayOnly, timeoutMs }) =>
    new Promise<GatherResult>((resolve) => {
      const res: GatherResult = { types: [], srflx: [] };
      let pc: RTCPeerConnection;
      try {
        pc = new PC({ iceServers: servers as RTCIceServer[], iceTransportPolicy: relayOnly ? 'relay' : 'all' });
      } catch (e) {
        return resolve({ ...res, error: e instanceof Error ? e.message : 'unsupported' });
      }
      let done = false;
      const finish = (error?: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pc.close();
        resolve(error ? { ...res, error } : res);
      };
      const timer = setTimeout(() => finish(res.types.length ? undefined : 'timed out'), timeoutMs);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return finish();
        const c = parseCandidate(ev.candidate.candidate);
        if (!c) return;
        res.types.push(c.type);
        if (c.type === 'srflx') res.srflx.push({ ip: c.ip, port: c.port });
        if (relayOnly && c.type === 'relay') finish();
      };
      pc.createDataChannel('probe');
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e: unknown) => finish(e instanceof Error ? e.message : 'error'));
    });
}
