import { describe, expect, it } from 'vitest';
import { MemorySignalBackend, type SignalBackend, createUpstashSignalBackend } from '../src/signal/hub.js';

/**
 * Backend parity (9.3): the lease and compare-and-set contract of the in-memory backend must hold on the production
 * (Upstash/Redis) backend. The Redis half needs a real instance and only runs when `UPSTASH_REDIS_REST_URL` and
 * `UPSTASH_REDIS_REST_TOKEN` are set (the docker stack provides them: `docker compose up -d redis srh upstash`);
 * otherwise it is reported as skipped, never as passed.
 */
const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let n = 0;
const proj = () => `parity-${Date.now()}-${n++}`;

/** A harness that moves time: the in-memory backend gets a fake clock, Redis really waits. */
interface Harness {
  backend: SignalBackend;
  advance(ms: number): Promise<void>;
}
function memory(): Harness {
  const clock = { ms: 1_000_000 };
  return { backend: new MemorySignalBackend({ now: () => clock.ms }), advance: async (ms) => {
      clock.ms += ms;
    },
  };
}
async function redis(): Promise<Harness> {
  return { backend: await createUpstashSignalBackend(url as string, token as string), advance: sleep };
}

function contract(name: string, make: () => Promise<Harness> | Harness, enabled: boolean) {
  const d = enabled ? describe : describe.skip;
  d(`signal backend lease contract: ${name}`, () => {
    it('a lease expires after its ttl and each device expires on its own', async () => {
      const { backend, advance } = await make();
      const p = proj();
      await backend.setPresence(p, 'x', 's1|t1', 2);
      await advance(1200);
      await backend.setPresence(p, 'y', 's2|t2', 2);
      await advance(1200); // x is 2.4 s old (expired), y 1.2 s
      expect(await backend.getPresence(p)).toEqual({ y: 's2|t2' });
      await advance(1200);
      expect(await backend.getPresence(p)).toEqual({});
    }, 15_000);

    it('renew is compare-and-set on the session and never resurrects an expired lease', async () => {
      const { backend, advance } = await make();
      const p = proj();
      await backend.setPresence(p, 'd', 's2|tok', 4);
      expect(await backend.renewPresence(p, 'd', 's1', 4)).toBe(false); // another session's entry
      await advance(1200);
      expect(await backend.renewPresence(p, 'd', 's2', 2)).toBe(true);
      await advance(1200);
      expect(await backend.getPresence(p)).toEqual({ d: 's2|tok' }); // renewed: 4.8 s old but alive (generous margins: real Redis under a loaded parallel run)
      await advance(1500);
      expect(await backend.renewPresence(p, 'd', 's2', 2)).toBe(false); // expired
      // Removing a lapsed entry is the one deliberate difference: Redis still holds it until a read prunes it (so it
      // returns true and the leave is announced), the memory backend dropped it when the renew above looked at it. Either
      // way nothing of it remains and a second removal finds nothing.
      await backend.removePresence(p, 'd', 's2');
      expect(await backend.removePresence(p, 'd', 's2')).toBe(false);
      expect(await backend.getPresence(p)).toEqual({});
    }, 30_000);

    it('batched renewal keeps per-entry session ownership and never resurrects', async () => {
      const { backend, advance } = await make();
      const p = proj(), q = proj();
      await backend.setPresence(p, 'a', 'sa|ta', 2);
      await backend.setPresence(p, 'b', 'new|tb', 2);
      await backend.setPresence(q, 'c', 'sc|tc', 2);
      await advance(1200);
      const renewed = await backend.renewPresenceMany!([
        { projectId: p, deviceId: 'a', sid: 'sa' },
        { projectId: p, deviceId: 'b', sid: 'old' }, // replaced by a newer session
        { projectId: q, deviceId: 'c', sid: 'sc' },
        { projectId: q, deviceId: 'missing', sid: 'sx' },
      ], 2);
      expect(renewed).toEqual([true, false, true, false]);
      await advance(1200);
      expect(await backend.getPresence(p)).toEqual({ a: 'sa|ta' });
      expect(await backend.getPresence(q)).toEqual({ c: 'sc|tc' });
      await advance(2500);
      expect(await backend.renewPresenceMany!([{ projectId: p, deviceId: 'a', sid: 'sa' }], 2)).toEqual([false]);
      expect(await backend.getPresence(p)).toEqual({});
    }, 15_000);

    it('remove is compare-and-delete: an old session cannot remove a newer entry', async () => {
      const { backend } = await make();
      const p = proj();
      await backend.setPresence(p, 'd', 's2|tok', 60);
      expect(await backend.removePresence(p, 'd', 's1')).toBe(false);
      expect(await backend.getPresence(p)).toEqual({ d: 's2|tok' });
      expect(await backend.removePresence(p, 'd', 's2')).toBe(true);
      expect(await backend.getPresence(p)).toEqual({});
    });

    it('publish reaches a subscriber once, and not after it unsubscribed', async () => {
      const { backend, advance } = await make();
      const ch = `parity:${proj()}`;
      const got: string[] = [];
      const off = await backend.subscribe(ch, (m) => got.push(m));
      await backend.publish(ch, 'one');
      // what the hub publishes: JSON with commas, delivered as the same string
      const sig = JSON.stringify({ t: 'sig', from: 'a', fromTicket: 'x.y.z', to: 'b', env: 'QUJD,REVG', ack: 'offer-1' });
      await backend.publish(ch, sig);
      await advance(300);
      expect(got).toEqual(['one', sig]);
      expect(JSON.parse(got[1] as string)).toMatchObject({ t: 'sig', to: 'b' });
      off();
      await advance(300);
      await backend.publish(ch, 'two');
      await advance(300);
      expect(got).toEqual(['one', sig]);
    }, 15_000);
  });
}

contract('memory', memory, true);

it('normal in-memory forwarding retains no payload archive; the explicit test trace stays bounded', async () => {
  const normal = new MemorySignalBackend();
  const got: string[] = [];
  const off = await normal.subscribe('channel', (message) => got.push(message));
  await normal.publish('channel', 'opaque ciphertext');
  await sleep(0);
  await expect.poll(async () => got, { timeout: 15_000 }).toEqual(['opaque ciphertext']);
  expect(normal.log).toEqual([]);
  off();
  const traced = new MemorySignalBackend({ recordMessages: true });
  for (let i = 0; i < 100; i++) await traced.publish('channel', 'x'.repeat(64 * 1024));
  expect(traced.log).toHaveLength(64);
  expect(traced.log.reduce((n, message) => n + message.length, 0)).toBe(4 * 1024 * 1024);
});

contract('redis (UPSTASH_REDIS_REST_URL)', redis, Boolean(url && token));
