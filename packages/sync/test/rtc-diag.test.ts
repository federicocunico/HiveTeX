import { describe, expect, it } from 'vitest';
import { type LinkSignal, RtcLink, candidateType, selectedPair, selectedPath, type RtcPeerLike } from '../src/rtc.js';
import { FakeRtcNetwork } from '../src/testing.js';

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
