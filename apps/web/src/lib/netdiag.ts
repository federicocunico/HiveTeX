import type { AttemptCause, Candidate, IceInfo, LinkDiag, PeerProbeResult, RouteState, SelfDiagnostics, TraceEvent } from '@hivetex/sync';
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
  /** Seen connected to the signaling service (as opposed to known only through another co-author). */
  onServer?: boolean;
  linking?: boolean;
  lastError?: string | null;
}

const ROUTE_NAME: Record<string, string> = { direct: 'direct', turn: 'through the relay (TURN)', relay: 'through the HiveTeX server (application relay, encrypted)' };

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
      onServer: c.onRelay,
      linking: c.linking,
      lastError: c.lastError,
      linkState: c.link?.state,
      local: c.link ? list(c.link.localCandidates) : undefined,
      remote: c.link ? list(c.link.remoteCandidates) : undefined,
      explanation: causeText(c.cause, c.link, c.lastError),
    });
  }
  return rows;
}

const shortId = (id: string) => id.slice(0, 8);

/** One trace line: `+  1234 ms a1b2c3d4 -> e5f6a7b8 sig.send k=offer via=server`. */
export function traceLine(e: TraceEvent, start: number): string {
  const data = e.data ? ` ${Object.entries(e.data).map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
  return `+${String(e.t - start).padStart(7)} ms ${shortId(e.self)}${e.dev ? ` -> ${shortId(e.dev)}` : ''} ${e.ev}${data}`;
}

const MARK = (ok: boolean | null) => (ok === true ? 'OK  ' : ok === false ? 'FAIL' : 'INFO');

/** The connection test towards one co-author, as text: verdict, steps, the other side's view, the attempt and its trace. */
export function formatProbe(name: string, p: PeerProbeResult): string[] {
  const lines = [`Connection test with ${name} (${shortId(p.dev)}), ${new Date(p.startedAt).toISOString()}, ${p.durationMs} ms`, `  Verdict: ${p.verdict}`];
  lines.push(`  This device: role ${p.role}, signaling ${p.socketOpen ? 'connected' : 'not connected'}, co-author ${p.known ? (p.onServer ? 'seen on the service' : 'known only through another co-author') : 'not known'}, ${p.connectedBefore ? 'already connected' : 'not connected'} before the test`);
  for (const st of p.steps) lines.push(`  [${MARK(st.ok)}] +${st.at} ms ${st.label}: ${st.detail}`);
  const d = p.signaling.delivery;
  if (d) lines.push(`  Signaling: via ${d.via}${d.reason ? ` (${d.reason})` : ''}, accepted ${d.accepted ?? 'no ack'}, target online ${d.targetOnline ?? 'unknown'}, delivered ${d.delivered}, reply ${p.signaling.replyMs === null ? 'none' : `${p.signaling.replyMs} ms`}`);
  const r = p.remote;
  if (r) {
    lines.push(`  The other device reports: app ${r.client ?? 'unknown'}; signaling ${r.socketOpen ? 'connected' : 'NOT connected'}; knows this device ${r.knowsYou}; sees this device on the service ${r.seesYouOnServer}; role ${r.role}; connected ${r.connected}${r.route ? ` (${r.route})` : ''}; setting up ${r.linking}; failed attempts ${r.attempts}; last cause ${r.cause ?? 'none'}${r.lastError ? ` (${r.lastError})` : ''}; connection servers ${r.ice.state}, ${r.ice.servers} server(s), relay ${r.ice.relay ? `${r.ice.relay.available ? 'available' : 'unavailable'} (${r.ice.relay.reason})` : 'unknown'}; connected co-authors ${r.meshPeers}`);
    if (r.link) lines.push(`    its link: ICE ${r.link.state}, offer sent ${r.link.offerSent}, offer received ${r.link.offerReceived}, answer received ${r.link.answerReceived}, candidates there ${list(r.link.localCandidates)}, received from this device ${list(r.link.remoteCandidates)}`);
  } else {
    lines.push('  The other device did not report its state.');
  }
  const a = p.attempt;
  lines.push(`  Attempt: ${a.outcome}${a.ms !== null ? ` in ${a.ms} ms` : ''}${a.route ? `, route ${a.route}` : ''}${a.pair ? `, selected pair ${a.pair.local} to ${a.pair.remote}` : ''}${a.cause ? `, stopped at ${a.cause}` : ''}${a.error ? ` (${a.error})` : ''}`);
  if (a.link) lines.push(`    this link: ICE ${a.link.state}, offer sent ${a.link.offerSent}, offer received ${a.link.offerReceived}, answer received ${a.link.answerReceived}, candidates here ${list(a.link.localCandidates)}, received ${list(a.link.remoteCandidates)}`);
  if (p.trace.length) {
    lines.push(`  Steps during the test (${p.trace.length}):`);
    const t0 = p.trace[0]?.t ?? 0;
    for (const e of p.trace) lines.push(`    ${traceLine(e, t0)}`);
  }
  if (p.nativeLog?.length) {
    const last = p.nativeLog.slice(-NATIVE_LINES);
    lines.push(`  Native connection stack during the test (${last.length} of ${p.nativeLog.length} lines):`);
    for (const l of last) lines.push(`    ${maskAddresses(l)}`);
  }
  return lines;
}

/** Native stack lines in a report: the latest ones (the app keeps more). */
const NATIVE_LINES = 80;

/**
 * IPv4 and IPv6 addresses as `<ip>`. The native log is masked where it is written; this is the report's own guarantee.
 * Times such as 12:30:45 are kept (two colons and no "::").
 */
export function maskAddresses(line: string): string {
  return line
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>')
    .replace(/\[?\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:%\w+)?\]?(?::\d+)?/gi, (m) => (m.includes('::') || (m.match(/:/g) ?? []).length >= 3 ? '<ip>' : m));
}

/** Where the report comes from: app, version and platform (no account, project or address). */
export interface ReportEnvironment {
  app: string;
  version: string;
  platform: string;
}

/** A short platform description from a user agent: OS and engine only. */
export function platformOf(ua: string): string {
  const os = /Windows NT [\d.]+|Mac OS X [\d_]+|Android [\d.]+|iPhone OS [\d_]+|Linux/.exec(ua)?.[0] ?? 'unknown OS';
  // Edge also says Chrome, and Chrome also says Safari: the most specific name first.
  const engine = /Edg\/\d+/.exec(ua)?.[0] ?? /Firefox\/\d+|Chrome\/\d+|Version\/[\d.]+ Safari/.exec(ua)?.[0] ?? 'unknown engine';
  return `${os.replace(/_/g, '.')}; ${engine}`;
}

/** Text for *Copy report*. Built from an allow-list of fields: no credentials, tokens, keys, addresses or content. */
export function buildReport(input: {
  results: CheckResult[];
  ice: IceInfo | null;
  rows: PeerRow[];
  app: string;
  when: Date;
  environment?: ReportEnvironment;
  self?: SelfDiagnostics | null;
  probes?: Array<{ name: string; result: PeerProbeResult }>;
  /** The latest connection steps (types and counts only, no addresses or credentials). */
  trace?: TraceEvent[];
  traceLimit?: number;
}): string {
  const lines = [`HiveTeX network report (${input.app})`, input.when.toISOString()];
  if (input.environment) lines.push(`App ${input.environment.app} ${input.environment.version}; ${input.environment.platform}`);
  const s = input.self;
  if (s) {
    lines.push(
      `This device ${shortId(s.dev)}: ${s.client ?? 'unknown app'}; signaling ${s.socketOpen ? 'connected' : 'not connected'}${s.doorbellMode ? ' (on demand)' : ''}; connected co-authors ${s.meshPeers}; known devices ${s.knownDevices}, seen on the service ${s.onServer}`,
      `  Counters: signaling connections opened ${s.stats.socketOpens}, setup messages via service ${s.stats.signalsViaServer}, via co-authors ${s.stats.signalsViaMesh}, relay setups ${s.stats.relaySetups} (failed ${s.stats.relayFailures}), rings ${s.stats.rings}, answers ${s.stats.answers}`,
    );
  }
  lines.push('', 'Checks');
  for (const r of input.results) lines.push(`- ${r.label}: ${r.status}${r.ms !== undefined ? ` (${r.ms} ms)` : ''}. ${r.detail.replace(/Public address \S+:/, 'Public address (hidden):')}`);
  if (input.ice) lines.push('', `Connection servers: ${input.ice.state}, ${input.ice.servers} server(s), relay ${input.ice.relay ? `${input.ice.relay.available ? 'available' : 'unavailable'} (${input.ice.relay.reason})` : 'unknown'}`);
  lines.push('', 'Co-authors');
  if (input.rows.length === 0) lines.push('- none online');
  for (const p of input.rows) {
    lines.push(p.state === 'connected'
      ? `- ${p.name} (${shortId(p.dev)}): connected ${p.route}${p.pair ? ` [${p.pair}]` : ''}`
      : `- ${p.name} (${shortId(p.dev)}): not connected, attempt ${(p.attempts ?? 0) + 1}${p.linking ? ' (in progress)' : ''}, ${p.onServer ? 'seen on the service' : 'NOT seen on the service (known through another co-author)'}, state ${p.linkState ?? 'n/a'}, cause ${p.cause ?? 'none yet'}${p.lastError ? `, last error "${p.lastError}"` : ''}; local candidates: ${p.local ?? 'n/a'}; remote candidates: ${p.remote ?? 'n/a'}. ${p.explanation ?? ''}`);
  }
  for (const pr of input.probes ?? []) lines.push('', ...formatProbe(pr.name, pr.result));
  if (s?.nativeLog?.length) {
    const last = s.nativeLog.slice(-NATIVE_LINES);
    lines.push('', `Native connection stack (desktop; last ${last.length} lines, addresses masked)`);
    for (const l of last) lines.push(maskAddresses(l));
  }
  if (input.trace && input.trace.length > 0) {
    const last = input.trace.slice(-(input.traceLimit ?? 400));
    const start = last[0]?.t ?? 0;
    lines.push('', `Connection trace (last ${last.length} of ${input.trace.length} steps; device ids shortened)`);
    for (const e of last) lines.push(traceLine(e, start));
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
