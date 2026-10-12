import { describe, expect, it } from 'vitest';
import { MemorySignalBackend, meterSignalBackend, presenceRenewer, type SignalBackend, UsageMeter } from '../src/signal/hub.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('batched heartbeat renewal (2.5)', () => {
  it('coalesces co-located sessions into one backend call with one result per session', async () => {
    const meter = new UsageMeter();
    const backend = meterSignalBackend(new MemorySignalBackend(), meter);
    for (const d of ['a', 'b', 'c']) await backend.setPresence('p', d, `s${d}|t`, 90);
    await backend.setPresence('p', 'z', 'newer|t', 90);
    const renew = presenceRenewer(backend, 20);
    const results = await Promise.all([
      renew({ projectId: 'p', deviceId: 'a', sid: 'sa' }),
      renew({ projectId: 'p', deviceId: 'b', sid: 'sb' }),
      renew({ projectId: 'p', deviceId: 'c', sid: 'sc' }),
      renew({ projectId: 'p', deviceId: 'z', sid: 'older' }),
    ]);
    expect(results).toEqual([true, true, true, false]);
    expect(meter.snapshot()['signal.renewPresenceMany']).toBe(1);
    expect(meter.snapshot()['signal.renewPresence']).toBeUndefined();
    expect(await backend.getPresence('p')).toMatchObject({ z: 'newer|t' });
  });

  it('a renewal queued before its session closed cannot resurrect the removed entry', async () => {
    const backend = new MemorySignalBackend();
    await backend.setPresence('p', 'a', 'sa|t', 90);
    const pending = presenceRenewer(backend, 20)({ projectId: 'p', deviceId: 'a', sid: 'sa' });
    expect(await backend.removePresence('p', 'a', 'sa')).toBe(true); // session cleanup runs first
    expect(await pending).toBe(false);
    expect(await backend.getPresence('p')).toEqual({});
  });

  it('falls back to individual renewals for backends without batching and propagates failures', async () => {
    const memory = new MemorySignalBackend();
    await memory.setPresence('p', 'a', 'sa|t', 90);
    const plain: SignalBackend = {
      publish: memory.publish.bind(memory), subscribe: memory.subscribe.bind(memory), setPresence: memory.setPresence.bind(memory),
      renewPresence: memory.renewPresence.bind(memory), removePresence: memory.removePresence.bind(memory), getPresence: memory.getPresence.bind(memory),
    };
    expect(await presenceRenewer(plain, 5)({ projectId: 'p', deviceId: 'a', sid: 'sa' })).toBe(true);
    const failing: SignalBackend = { ...plain, renewPresenceMany: async () => { throw new Error('down'); } };
    const renew = presenceRenewer(failing, 5);
    await expect(Promise.all([renew({ projectId: 'p', deviceId: 'a', sid: 'sa' }), renew({ projectId: 'p', deviceId: 'b', sid: 'sb' })])).rejects.toThrow('down');
  });

  it('counts commands for co-located versus distributed sessions', async () => {
    // Four always-on projects of one device, three heartbeat rounds.
    const colocated = new UsageMeter();
    const shared = meterSignalBackend(new MemorySignalBackend(), colocated);
    const renewShared = presenceRenewer(shared, 20);
    const distributed = new UsageMeter();
    const instances = Array.from({ length: 4 }, () => presenceRenewer(meterSignalBackend(new MemorySignalBackend(), distributed), 20));
    for (let round = 0; round < 3; round++) {
      await Promise.all([0, 1, 2, 3].map(i => renewShared({ projectId: 'p' + i, deviceId: 'd', sid: 's' })));
      await Promise.all(instances.map((renew, i) => renew({ projectId: 'p' + i, deviceId: 'd', sid: 's' })));
      await sleep(5);
    }
    expect(colocated.snapshot()['signal.renewPresenceMany']).toBe(3);
    expect(colocated.snapshot()['signal.renewPresenceMany.entries']).toBe(12);
    // A single entry per instance is renewed directly: no batching gain, and no extra command either.
    expect(distributed.snapshot()['signal.renewPresence']).toBe(12);
    expect(distributed.snapshot()['signal.renewPresenceMany']).toBeUndefined();
  });
});
