import { describe, expect, it } from 'vitest';
import type { Candidate } from '@hivetex/sync';
import type { PeerProbeResult } from '@hivetex/sync';
import { type NetEnv, buildReport, formatProbe, parseCandidate, peerRows, platformOf, runChecks, splitServers } from '../src/lib/netdiag.js';

const SECRET = 'turn-secret-credential-123';
const TURN = { urls: ['turn:relay.example.org:3478?transport=udp', 'turns:relay.example.org:443?transport=tcp'], username: 'user-abc', credential: SECRET };
const STUN = { urls: ['stun:stun.a.example:3478', 'stun:stun.b.example:3478'] };

function env(over: Partial<NetEnv> = {}): NetEnv {
  return {
    fetchIce: async () => ({ iceServers: [STUN, TURN], relay: { available: true, reason: 'ok' } }),
    gather: async (s, o) => (o.relayOnly ? { types: ['relay'], srflx: [] } : { types: ['host', 'srflx'], srflx: [{ ip: '203.0.113.9', port: 40000 }] }),
    signalingOpen: () => true,
    mapping: async () => null,
    ...over,
  };
}
const status = (rs: Awaited<ReturnType<typeof runChecks>>) => Object.fromEntries(rs.map((r) => [r.id, r.status]));

describe('network checks', () => {
  it('parses candidate lines and splits server lists', () => {
    expect(parseCandidate('candidate:1 1 udp 1677729535 203.0.113.9 6000 typ srflx raddr 0.0.0.0 rport 0')).toEqual({ type: 'srflx', ip: '203.0.113.9', port: 6000 });
    expect(parseCandidate('nonsense')).toBeNull();
    const s = splitServers([STUN, TURN]);
    expect(s.stun).toHaveLength(2);
    expect(s.turn).toHaveLength(2);
    expect(s.turnTcpOrTls).toBe(true);
  });

  it('a healthy network passes every applicable check and port mapping is not applicable in a browser', async () => {
    const r = await runChecks(env());
    expect(status(r)).toEqual({ signaling: 'pass', 'ice-config': 'pass', stun: 'pass', relay: 'pass', 'port-mapping': 'na' });
  });

  it('reports each step as it completes', async () => {
    const seen: string[] = [];
    await runChecks(env(), (rs) => seen.push(rs.map((x) => x.status).join(',')));
    expect(seen.length).toBeGreaterThan(4);
    expect(seen[0]).toContain('pass,idle');
  });

  it('says plainly that no relay is configured', async () => {
    const r = await runChecks(env({ fetchIce: async () => ({ iceServers: [STUN], relay: { available: false, reason: 'not_configured' } }) }));
    expect(status(r)['ice-config']).toBe('warn');
    expect(status(r).relay).toBe('warn');
    expect(r.find((x) => x.id === 'relay')?.detail).toMatch(/No relay is configured/);
  });

  it('reports blocked UDP when STUN does not answer', async () => {
    const r = await runChecks(env({ gather: async () => ({ types: [], srflx: [], error: 'timed out' }) }));
    expect(status(r).stun).toBe('fail');
    expect(r.find((x) => x.id === 'stun')?.detail).toMatch(/UDP appears blocked/);
    expect(status(r).relay).toBe('fail');
  });

  it('warns about a symmetric NAT when two STUN servers see different ports', async () => {
    let n = 0;
    const r = await runChecks(env({ gather: async (_s, o) => (o.relayOnly ? { types: ['relay'], srflx: [] } : { types: ['srflx'], srflx: [{ ip: '203.0.113.9', port: 40000 + n++ }] }) }));
    expect(status(r).stun).toBe('warn');
    expect(r.find((x) => x.id === 'stun')?.detail).toMatch(/symmetric/);
  });

  it('a failing credentials request is a failed check, not a crash', async () => {
    const r = await runChecks(env({ fetchIce: async () => { throw new Error('offline'); } }));
    expect(status(r)['ice-config']).toBe('fail');
    expect(r.find((x) => x.id === 'relay')?.detail).toMatch(/could not be loaded/);
  });

  it('shows desktop port mapping and the signaling socket state', async () => {
    const r = await runChecks(env({ signalingOpen: () => false, mapping: async () => ({ state: 'mapped', external: '203.0.113.9:1', lease_secs: 3600 }) }));
    expect(status(r)['port-mapping']).toBe('pass');
    expect(status(r).signaling).toBe('fail');
    expect(status(await runChecks(env({ signalingOpen: () => null })))['signaling']).toBe('na');
  });
});

/** A connection test whose messages the service accepted but never delivered. */
const probe = (): PeerProbeResult => ({
  dev: 'd2d2d2d2d2d2d2d2',
  startedAt: Date.parse('2026-10-13T12:00:00Z'),
  durationMs: 31000,
  role: 'offerer',
  socketOpen: true,
  known: true,
  onServer: true,
  connectedBefore: false,
  signaling: { delivery: { via: 'server', accepted: true, targetOnline: true, delivered: false }, replyMs: null },
  remote: null,
  attempt: { outcome: 'timeout', route: null, pair: null, cause: 'no-setup-reply', error: 'connection attempt timed out', link: null, ms: 25000 },
  steps: [
    { at: 3, label: 'Setup message sent', ok: true, detail: 'to the signaling service' },
    { at: 40, label: 'Accepted by the service', ok: true, detail: 'accepted; the other device is connected to the service' },
    { at: 6040, label: 'Delivered to the other device', ok: false, detail: 'the service accepted it but did not hand it over' },
  ],
  verdict: 'The signaling service accepted the message but did not deliver it to the co-author: a problem in the service (message forwarding between its instances).',
  trace: [
    { t: 1000, self: 'a1a1a1a1a1a1a1a1', ev: 'sig.send', dev: 'd2d2d2d2d2d2d2d2', data: { k: 'probe', via: 'server' } },
    { t: 7040, self: 'a1a1a1a1a1a1a1a1', ev: 'sig.not-delivered', dev: 'd2d2d2d2d2d2d2d2', data: { k: 'probe', accepted: true } },
  ],
});

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  dev: 'd2', uname: 'bea', attempts: 2, linking: false, lastError: 'connection attempt timed out', cause: 'checks-failed', onRelay: true,
  link: { state: 'checking', offerReceived: true, offerSent: false, answerReceived: false, localCandidates: ['host', 'srflx', 'srflx'], remoteCandidates: ['host'] },
  ...over,
});

describe('per-peer details, peer test and report', () => {
  it('describes connected and stuck peers', () => {
    const rows = peerRows([{ dev: 'd1', uname: 'ann' }], [cand()], { d1: { route: 'turn', limited: null, pair: { local: 'host', remote: 'relay' } } });
    expect(rows[0]).toMatchObject({ name: 'ann', state: 'connected', route: 'through the relay (TURN)', pair: 'host ↔ relay' });
    expect(rows[1]).toMatchObject({ name: 'bea', state: 'connecting', cause: 'checks-failed', local: 'host, srflx×2', remote: 'host' });
    expect(rows[1]?.explanation).toMatch(/no network path worked/);
    expect(peerRows([], [cand({ cause: 'no-candidates' })], {})[0]?.explanation).toMatch(/No network candidates were received/);
  });

  it('formats a connection test: verdict, marked steps, the other side\'s view, the attempt and its steps', () => {
    const lines = formatProbe('bea', probe());
    const text = lines.join('\n');
    expect(lines[0]).toMatch(/^Connection test with bea \(d2d2d2d2\)/);
    expect(text).toContain('Verdict: The signaling service accepted the message but did not deliver it');
    expect(text).toContain('[OK  ] +3 ms Setup message sent');
    expect(text).toContain('[FAIL] +6040 ms Delivered to the other device');
    expect(text).toContain('Signaling: via server, accepted true, target online true, delivered false, reply none');
    expect(text).toContain('The other device did not report its state.');
    expect(text).toContain('Attempt: timeout in 25000 ms, stopped at no-setup-reply');
    expect(text).toContain('a1a1a1a1 -> d2d2d2d2 sig.not-delivered k=probe');
  });

  it('describes the platform without account or address details', () => {
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0')).toBe('Windows NT 10.0; Edg/140');
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBe('Mac OS X 10.15.7; Version/18.0 Safari');
  });

  it('the report carries results and causes but no credential, token or public address', async () => {
    const results = await runChecks(env());
    const text = buildReport({
      results,
      ice: { state: 'ok', relay: { available: true, reason: 'ok' }, servers: 3 },
      rows: peerRows([], [cand()], {}),
      app: 'web',
      when: new Date('2026-10-13T12:00:00Z'),
    });
    expect(text).toContain('bea (d2): not connected');
    expect(text).toContain('cause checks-failed');
    expect(text).toContain('Public address (hidden)');
    for (const forbidden of [SECRET, 'user-abc', '203.0.113.9', 'relay.example.org']) expect(text).not.toContain(forbidden);
  });

  it('the full report carries environment, this device, the connection tests and the trace, and still no secret', async () => {
    const text = buildReport({
      results: await runChecks(env()),
      ice: { state: 'ok', relay: { available: true, reason: 'ok' }, servers: 3 },
      rows: peerRows([], [cand()], {}),
      app: 'desktop',
      when: new Date('2026-10-13T12:00:00Z'),
      environment: { app: 'desktop', version: '0.7.2', platform: 'Windows NT 10.0; Edg/140' },
      self: { dev: 'a1a1a1a1a1a1a1a1', client: 'desktop 0.7.2', socketOpen: true, doorbellMode: false, meshPeers: 0, knownDevices: 1, onServer: 1, stats: { socketOpens: 2, signalsViaServer: 14, signalsViaMesh: 0, relaySetups: 0, relayFailures: 0, rings: 0, answers: 0 } },
      probes: [{ name: 'bea', result: probe() }],
      trace: probe().trace,
    });
    expect(text).toContain('App desktop 0.7.2; Windows NT 10.0; Edg/140');
    expect(text).toContain('This device a1a1a1a1: desktop 0.7.2; signaling connected');
    expect(text).toContain('setup messages via service 14');
    expect(text).toContain('seen on the service');
    expect(text).toContain('Connection test with bea');
    expect(text).toContain('Connection trace (last 2 of 2 steps');
    for (const forbidden of [SECRET, 'user-abc', '203.0.113.9', 'relay.example.org', 'a1a1a1a1a1a1a1a1']) expect(text).not.toContain(forbidden);
  });

  it('the report ends with the connection trace, device ids shortened, so a stuck pair shows where it stopped', async () => {
    const text = buildReport({
      results: [],
      ice: null,
      rows: [],
      app: 'desktop',
      when: new Date('2026-10-13T12:00:00Z'),
      trace: [
        { t: 1000, self: 'abcdef0123456789', ev: 'socket.opened' },
        { t: 1050, self: 'abcdef0123456789', ev: 'sig.send', dev: '123456fedcba9876', data: { k: 'offer', via: 'server' } },
        { t: 1200, self: 'abcdef0123456789', ev: 'link.timeout', dev: '123456fedcba9876', data: { cause: 'no-setup-reply' } },
      ],
    });
    expect(text).toContain('Connection trace (last 3 of 3 steps');
    expect(text).toContain('+     50 ms abcdef01 -> 123456fe sig.send k=offer via=server');
    expect(text).toContain('link.timeout cause=no-setup-reply');
    expect(text).not.toContain('abcdef0123456789');
  });
});
