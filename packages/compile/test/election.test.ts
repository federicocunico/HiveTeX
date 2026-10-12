import { type Node, Net } from '@hivetex/sync/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { type CapabilityRecord, Election, score } from '../src/index.js';

let net: Net;
const elections: Election[] = [];
afterEach(() => {
  for (const e of elections.splice(0)) e.stop();
  net?.destroy();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error('waitFor timed out');
}

function rec(n: Node, o: Partial<CapabilityRecord> = {}): Omit<CapabilityRecord, 'stamp'> {
  return {
    dev: n.dev,
    uname: n.name,
    engine: 'native',
    supports: ['pdflatex', 'xelatex'],
    perf: 1,
    power: 'mains',
    batteryPct: 100,
    load: 0,
    optOut: false,
    ...o,
  };
}

function elect(n: Node, o: Partial<CapabilityRecord> = {}, engine: 'pdflatex' | 'xelatex' = 'pdflatex') {
  const e = new Election(n.mesh, rec(n, o), { engine: () => engine, selfRole: n.role, intervalMs: 40 });
  elections.push(e);
  e.start();
  return e;
}

describe('capability score', () => {
  const base = (o: Partial<CapabilityRecord>): CapabilityRecord => ({ ...rec({ dev: 'd', name: 'n' } as Node), ...o, stamp: 1 });
  it('ranks native over wasm, mains over battery, and applies load', () => {
    expect(score(base({}), 'pdflatex')).toBeGreaterThan(score(base({ engine: 'wasm' }), 'pdflatex'));
    expect(score(base({}), 'pdflatex')).toBeGreaterThan(score(base({ power: 'battery', batteryPct: 80 }), 'pdflatex'));
    expect(score(base({ power: 'battery', batteryPct: 80 }), 'pdflatex')).toBeGreaterThan(score(base({ power: 'battery', batteryPct: 20 }), 'pdflatex'));
    expect(score(base({ load: 0.5 }), 'pdflatex')).toBeCloseTo(score(base({}), 'pdflatex') * 0.5);
  });
  it('is zero when opted out, without an engine, or when the project engine is unsupported', () => {
    expect(score(base({ optOut: true }), 'pdflatex')).toBe(0);
    expect(score(base({ engine: 'none' }), 'pdflatex')).toBe(0);
    expect(score(base({}), 'lualatex')).toBe(0);
  });
});

describe('leader election (8.1, 8.2)', () => {
  it('a mains desktop beats battery laptops, and all peers agree', async () => {
    net = await Net.create();
    const [desk, l1, l2] = [await net.add('desk', 'editor'), await net.add('lap1', 'editor'), await net.add('lap2', 'editor')];
    await net.fullMesh();
    const es = [
      elect(desk),
      elect(l1, { power: 'battery', batteryPct: 90 }),
      elect(l2, { power: 'battery', batteryPct: 90, engine: 'wasm' }),
    ];
    await waitFor(() => es.every((e) => e.leader() === desk.dev));
    expect(es[0]?.isLeader()).toBe(true);
    expect(es[1]?.isLeader()).toBe(false);
  });

  it('propagates a power change within 5 seconds and moves leadership', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('a', 'editor'), await net.add('b', 'editor')];
    await net.link(a, b);
    const ea = elect(a, { perf: 2 });
    const eb = elect(b, { perf: 1.5 });
    await waitFor(() => ea.leader() === a.dev && eb.leader() === a.dev);
    const t0 = Date.now();
    ea.update({ power: 'battery', batteryPct: 30 }); // unplugged
    await waitFor(() => eb.leader() === b.dev && ea.leader() === b.dev);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('adopts the device id registered after an offline start, and peers then see that id', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('a', 'editor'), await net.add('b', 'editor')];
    const ea = elect(a, { perf: 3, dev: 'offline-temporary' }); // started before the device had a server id
    expect(ea.leader()).toBe('offline-temporary');
    ea.setDevice(a.dev);
    expect(ea.leader()).toBe(a.dev);
    expect(ea.isLeader()).toBe(true);
    const eb = elect(b, { perf: 1 });
    await net.link(a, b);
    await waitFor(() => eb.leader() === a.dev);
  });

  it('never elects an opted-out device or a viewer', async () => {
    net = await Net.create();
    const [strong, weak, viewer] = [await net.add('strong', 'editor'), await net.add('weak', 'editor'), await net.add('view', 'viewer')];
    await net.fullMesh();
    const [es, ew] = [elect(strong, { perf: 4, optOut: true }), elect(weak, { perf: 0.5 })];
    const ev = elect(viewer, { perf: 8 });
    await waitFor(() => [es, ew, ev].every((e) => e.leader() === weak.dev));
  });

  it('fails over within 10 seconds when the leader shuts down', async () => {
    net = await Net.create();
    const [a, b, c] = [await net.add('a', 'editor'), await net.add('b', 'editor'), await net.add('c', 'editor')];
    await net.fullMesh();
    const [ea, eb, ec] = [elect(a, { perf: 3 }), elect(b, { perf: 2 }), elect(c, { perf: 1 })];
    await waitFor(() => [ea, eb, ec].every((e) => e.leader() === a.dev));
    const t0 = Date.now();
    ea.stop();
    net.isolate(a);
    await waitFor(() => eb.leader() === b.dev && ec.leader() === b.dev);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('detects a hung leader by missed heartbeats even if the connection stays open', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('a', 'editor'), await net.add('b', 'editor')];
    await net.link(a, b);
    const ea = elect(a, { perf: 3 });
    const eb = elect(b, { perf: 1 });
    await waitFor(() => eb.leader() === a.dev);
    ea.stop(); // stops heartbeats; transport remains open
    await waitFor(() => eb.leader() === b.dev, 2000);
  });

  it('elects one leader per partition and a single leader after reunion', async () => {
    net = await Net.create();
    const [a, b, c, d] = [
      await net.add('a', 'editor'),
      await net.add('b', 'editor'),
      await net.add('c', 'editor'),
      await net.add('d', 'editor'),
    ];
    await net.link(a, b);
    await net.link(c, d);
    const es = [elect(a, { perf: 4 }), elect(b, { perf: 1 }), elect(c, { perf: 3 }), elect(d, { perf: 2 })];
    await waitFor(() => es[0]?.leader() === a.dev && es[1]?.leader() === a.dev && es[2]?.leader() === c.dev && es[3]?.leader() === c.dev);
    await net.link(b, c);
    await net.link(a, d);
    await waitFor(() => es.every((e) => e.leader() === a.dev));
  });

  it('ineligible engines never lead (xelatex project, peer lacks xelatex)', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('a', 'editor'), await net.add('b', 'editor')];
    await net.link(a, b);
    const ea = elect(a, { perf: 5, supports: ['pdflatex'] }, 'xelatex');
    const eb = elect(b, { perf: 1 }, 'xelatex');
    await waitFor(() => ea.leader() === b.dev && eb.leader() === b.dev);
  });

  it('hysteresis keeps the sitting leader against a marginally better peer', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('a', 'editor'), await net.add('b', 'editor')];
    await net.link(a, b);
    const ea = elect(a, { perf: 2 });
    const eb = elect(b, { perf: 1 });
    await waitFor(() => ea.leader() === a.dev && eb.leader() === a.dev);
    eb.update({ perf: 2.2 }); // +10%: below the 15% hysteresis
    await sleep(150);
    await expect.poll(async () => ea.leader(), { timeout: 15_000 }).toBe(a.dev);
    eb.update({ perf: 3 }); // +50%
    await waitFor(() => ea.leader() === b.dev && eb.leader() === b.dev);
  });
});
