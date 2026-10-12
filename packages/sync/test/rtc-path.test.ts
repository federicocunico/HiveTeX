import { describe, expect, it } from 'vitest';
import { type RtcPeerLike, selectedPath } from '../src/rtc.js';

const pc = (stats: Record<string, unknown>[] | null) => ({ getStats: stats ? async () => stats : undefined }) as unknown as RtcPeerLike;
describe('selected ICE path (3.6)', () => {
  it('tells TURN from direct pairs using the transport-selected pair', async () => {
    const base = [
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
      { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' },
      { id: 'R', type: 'remote-candidate', candidateType: 'srflx' },
    ];
    expect(await selectedPath(pc([...base, { id: 'L', type: 'local-candidate', candidateType: 'relay' }]))).toBe('turn');
    expect(await selectedPath(pc([...base, { id: 'L', type: 'local-candidate', candidateType: 'host' }]))).toBe('direct');
  });
  it('falls back to the nominated succeeded pair and reports unknown without stats', async () => {
    const stats = [
      { id: 'P', type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R' },
      { id: 'L', type: 'local-candidate', candidateType: 'host' },
      { id: 'R', type: 'remote-candidate', candidateType: 'relay' },
    ];
    expect(await selectedPath(pc(stats))).toBe('turn');
    expect(await selectedPath(pc(null))).toBe('unknown');
    expect(await selectedPath(pc([]))).toBe('unknown');
  });
});
