import { describe, expect, it } from 'vitest';
import { type RuntimeKey, RuntimeCancelled, RuntimeRegistry } from '../src/registry.js';

/** 4.2: lifecycle registry for one authoritative runtime per server/account/project. */
const key = (project = 'p', account = 'ann', server = 'https://hivetex.example'): RuntimeKey => ({ server, account, project });

function fixture(delayMs = 20) {
  const created: Array<{ key: RuntimeKey; closed: boolean; paused: boolean[] }> = [];
  let gate: Promise<void> | null = null;
  const reg = new RuntimeRegistry({
    create: async (k) => {
      const r = { key: k, closed: false, paused: [] as boolean[], close: async () => { r.closed = true; }, setPaused: (p: boolean) => { r.paused.push(p); } };
      created.push(r);
      await (gate ?? new Promise((res) => setTimeout(res, delayMs)));
      return r;
    },
  });
  return { reg, created, hold: () => { let open!: () => void; gate = new Promise((r) => (open = r)); return () => { gate = null; open(); }; } };
}

describe('runtime registry (4.2)', () => {
  it('concurrent opens of one project share one runtime; different accounts or servers do not', async () => {
    const f = fixture();
    const a = f.reg.attach(key(), 'editor');
    const b = f.reg.attach(key(), 'background');
    const c = f.reg.attach(key('p', 'bob'), 'editor');
    const d = f.reg.attach(key('p', 'ann', 'https://HIVETEX.example/'), 'editor'); // same canonical server
    expect(await a.runtime).toBe(await b.runtime);
    expect(await d.runtime).toBe(await a.runtime);
    expect(await c.runtime).not.toBe(await a.runtime);
    expect(f.created).toHaveLength(2);
    expect(f.reg.demand(key()).sort()).toEqual(['background', 'editor', 'editor']);
  });

  it('detaching before the open completes closes the late runtime and never exposes it', async () => {
    const f = fixture();
    const open = f.hold();
    const a = f.reg.attach(key(), 'editor');
    await new Promise((r) => setTimeout(r, 5));
    const stopped = a.release();
    open();
    await stopped;
    await expect(a.runtime).rejects.toBeInstanceOf(RuntimeCancelled);
    expect(f.created[0]?.closed).toBe(true);
    expect(f.reg.get(key())).toBeNull();
  });

  it('remembers a pause requested while the runtime is still opening', async () => {
    const f = fixture();
    const a = f.reg.attach(key(), 'editor');
    f.reg.setPaused(key(), true);
    const r = (await a.runtime) as unknown as { paused: boolean[] };
    expect(r.paused).toEqual([true]);
  });

  it('a stale lease release cannot stop a newer attachment, and a new attach waits for the old runtime to close', async () => {
    const f = fixture();
    const old = f.reg.attach(key(), 'editor');
    await old.runtime;
    await old.release(); // last lease: stops
    const fresh = f.reg.attach(key(), 'editor');
    await old.release(); // idempotent, and of the old generation
    const r = await fresh.runtime;
    expect(f.created).toHaveLength(2);
    expect(f.created[0]?.closed).toBe(true);
    expect((r as unknown as { closed: boolean }).closed).toBe(false);
    expect(f.reg.get(key())).toBe(r);
  });

  it('keeps running while another lease remains and stops with the last one', async () => {
    const f = fixture();
    const editor = f.reg.attach(key(), 'editor');
    const seed = f.reg.attach(key(), 'background');
    await editor.runtime;
    await editor.release();
    expect(f.created[0]?.closed).toBe(false); // detaching the editor keeps the background session
    expect(f.reg.demand(key())).toEqual(['background']);
    await seed.release();
    expect(f.created[0]?.closed).toBe(true);
  });

  it('a stop barrier for one account closes all its runtimes before resolving and leaves others running', async () => {
    const f = fixture();
    const leases = [f.reg.attach(key('a'), 'background'), f.reg.attach(key('b'), 'editor'), f.reg.attach(key('a', 'bob'), 'editor')];
    await Promise.all(leases.map((l) => l.runtime));
    await f.reg.stopWhere((k) => k.account === 'ann');
    expect(f.created.filter((c) => c.key.account === 'ann').every((c) => c.closed)).toBe(true);
    expect(f.created.find((c) => c.key.account === 'bob')?.closed).toBe(false);
    expect(f.reg.keys()).toEqual([key('a', 'bob')]);
  });
});
