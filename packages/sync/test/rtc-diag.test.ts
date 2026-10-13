import { describe, expect, it, vi } from 'vitest';
import { type LinkSignal, RtcLink, candidateType, selectedPair, selectedPath, type RtcPeerLike } from '../src/rtc.js';
import { FakeRtcNetwork } from '../src/testing.js';
import type { PeerTransport } from '../src/transport.js';

/** Two links connected through the fake network; `pcA` is the offering side's connection. */
async function linked(disconnectGraceMs = 30) {
  const net = new FakeRtcNetwork();
  const pcs: RtcPeerLike[] = [];
  const factory = (s: unknown[]) => {
    const pc = net.factory(s);
    pcs.push(pc);
    return pc;
  };
  const trace: string[] = [];
  let ta: PeerTransport | undefined;
  let tb: PeerTransport | undefined;
  const b: { link?: RtcLink } = {};
  const a = new RtcLink({
    factory, iceServers: [], initiator: true, send: (s) => void b.link?.handle(s), onTransport: (t) => (ta = t), onFail: () => {},
    trace: (ev) => trace.push(ev), disconnectGraceMs,
  });
  b.link = new RtcLink({ factory, iceServers: [], initiator: false, send: (s) => void a.handle(s), onTransport: (t) => (tb = t), onFail: () => {} });
  await a.start();
  await vi.waitFor(() => expect(ta && tb).toBeTruthy());
  const pcA = pcs[0] as RtcPeerLike & { connectionState: string };
  const closed = vi.fn();
  (ta as PeerTransport).onClose(closed);
  const setState = (s: string) => {
    pcA.connectionState = s;
    pcA.onconnectionstatechange?.();
  };
  return { ta: ta as PeerTransport, closed, setState, trace };
}

describe('a link that was up', () => {
  it('ends its transport when the connection stays disconnected, so the peer leaves and is connected again', async () => {
    const { closed, setState, trace } = await linked();
    setState('disconnected');
    expect(closed).not.toHaveBeenCalled(); // a short interruption is allowed
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(trace).toContain('lost');
  });

  it('keeps it when the connection comes back within the grace period, and ends it at once when it fails', async () => {
    const { closed, setState } = await linked(40);
    setState('disconnected');
    setState('connected');
    await new Promise((r) => setTimeout(r, 80));
    expect(closed).not.toHaveBeenCalled();
    setState('failed');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('a transport closed on purpose is not reported lost', async () => {
    const { ta, setState, trace } = await linked();
    ta.close();
    setState('closed');
    await new Promise((r) => setTimeout(r, 60));
    expect(trace).not.toContain('lost');
  });
});

describe('connection diagnostics data', () => {
  it('reads the type of a candidate without exposing its address', () => {
    expect(candidateType({ candidate: 'candidate:1 1 udp 2113937151 192.0.2.1 5000 typ host generation 0' })).toBe('host');
    expect(candidateType('candidate:2 1 udp 1677729535 203.0.113.9 6000 typ srflx raddr 0.0.0.0 rport 0')).toBe('srflx');
    expect(candidateType({ candidate: 'candidate:3 1 udp 41885439 198.51.100.7 3478 typ relay' })).toBe('relay');
    expect(candidateType({ type: 'prflx' })).toBe('prflx');
    expect(candidateType({ candidate: 'garbled' })).toBe('unknown');
    expect(candidateType(null)).toBe('unknown');
  });

  it('reports the selected pair types and derives the route from them', async () => {
    const stats = (local: string, remote: string) =>
      ({
        getStats: async () => ({
          forEach: (cb: (s: Record<string, unknown>) => void) => {
            cb({ id: 'T', type: 'transport', selectedCandidatePairId: 'P' });
            cb({ id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' });
            cb({ id: 'L', type: 'local-candidate', candidateType: local, ip: '192.0.2.1' });
            cb({ id: 'R', type: 'remote-candidate', candidateType: remote, ip: '203.0.113.9' });
          },
        }),
      }) as unknown as RtcPeerLike;
    expect(await selectedPair(stats('host', 'srflx'))).toEqual({ local: 'host', remote: 'srflx' });
    expect(await selectedPath(stats('srflx', 'srflx'))).toBe('direct');
    expect(await selectedPath(stats('host', 'relay'))).toBe('turn');
    expect(await selectedPair({} as RtcPeerLike)).toBeNull();
  });

  it('a link records what it saw: setup messages, candidate types and state', async () => {
    const net = new FakeRtcNetwork();
    const sent: LinkSignal[] = [];
    const link = new RtcLink({ factory: net.factory, iceServers: [], initiator: true, send: (s) => sent.push(s), onTransport: () => {}, onFail: () => {} });
    expect(link.diag()).toMatchObject({ offerSent: false, answerReceived: false, localCandidates: [], remoteCandidates: [] });
    await link.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(link.diag().offerSent).toBe(true);
    expect(link.diag().localCandidates.length).toBeGreaterThan(0);
    await link.handle({ k: 'ice', candidate: { candidate: 'candidate:9 1 udp 1 192.0.2.5 1 typ srflx' } });
    expect(link.diag().remoteCandidates).toEqual(['srflx']);
    link.close();
  });
});
