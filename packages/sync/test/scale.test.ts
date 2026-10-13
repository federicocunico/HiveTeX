import { afterEach, describe, expect, it } from 'vitest';
import type { Node } from '../src/testkit.js';
import { waitFor } from './helpers.js';
import { Net, converged, text } from './net.js';

/**
 * Group-scale real-time behaviour (spec peer-sync › Real-time propagation at group scale). Uses the in-memory
 * transport with immediate delivery: it measures the sync stack itself (Yjs, framing, compression, mesh relaying),
 * not the network. Browser-level WebRTC latency is measured by e2e/realtime.spec.ts.
 */

let net: Net;
afterEach(() => net?.destroy());

const FAST = { immediate: true };
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] as number;

/** Counts application frames sent by every connection (updates, relays) while `fn` runs. */
async function countFrames(nodes: Node[], fn: () => Promise<void>) {
  let frames = 0;
  const restore: Array<() => void> = [];
  for (const n of nodes)
    for (const p of n.mesh.peers) {
      const orig = p.conn.send.bind(p.conn);
      p.conn.send = (async (...a: Parameters<typeof orig>) => {
        frames++;
        return orig(...a);
      }) as typeof orig;
      restore.push(() => {
        p.conn.send = orig;
      });
    }
  await fn();
  for (const r of restore) r();
  return frames;
}

/** Resolves when `marker` appears in the node's copy of the file (event-driven, no polling delay). */
async function seen(n: Node, id: string, marker: string) {
  const t = await n.model.openText(id);
  if (t.toString().includes(marker)) return;
  await new Promise<void>((res) => {
    const f = () => {
      if (t.toString().includes(marker)) {
        t.unobserve(f);
        res();
      }
    };
    t.observe(f);
  });
}

async function group(n: number, link: (net: Net, nodes: Node[]) => Promise<void> = (nt) => nt.fullMesh(FAST)) {
  net = await Net.create();
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) nodes.push(await net.add(`p${i}`, i === 0 ? 'owner' : 'editor'));
  await link(net, nodes);
  const id = await nodes[0]!.model.createTextNow('main.tex', 'start\n');
  for (const x of nodes) await x.mesh.openDoc(`f:${id}`);
  await converged(nodes, id, 10_000);
  await new Promise((r) => setTimeout(r, 300)); // neighbour lists exchanged
  return { nodes, id };
}

describe('real-time propagation at group scale', () => {
  for (const n of [2, 6, 8, 12]) {
    it(`${n} peers: every keystroke reaches everyone fast, sent once per connection`, async () => {
      const { nodes, id } = await group(n);
      const writer = nodes[1]!;
      const wt = await writer.model.openText(id);
      const lat: number[] = [];
      const frames = await countFrames(nodes, async () => {
        for (let k = 0; k < 30; k++) {
          const marker = `#${k}#`;
          const t0 = performance.now();
          wt.insert(wt.length, marker);
          await Promise.all(nodes.filter((x) => x !== writer).map((x) => seen(x, id, marker)));
          lat.push(performance.now() - t0);
        }
        await new Promise((r) => setTimeout(r, 50)); // let any (unwanted) relays happen before counting
      });
      const perKey = frames / 30;
      console.log(`[scale] N=${n} keystroke p50=${pct(lat, 50).toFixed(2)}ms p95=${pct(lat, 95).toFixed(2)}ms frames/keystroke=${perKey.toFixed(1)}`);
      // The healthy-network contract (spec peer-sync): <= 250 ms. In-process it is usually a few ms; a loaded CI
      // runner must not turn a scheduling delay into a failure, while a real regression (a timer, a resend) still does.
      expect(pct(lat, 95)).toBeLessThan(250);
      expect(perKey).toBe(n - 1);
    }, 60_000);
  }

  it('12 peers typing at once converge with every insertion', async () => {
    const { nodes, id } = await group(12);
    const t0 = performance.now();
    await Promise.all(
      nodes.map(async (x, i) => {
        const t = await x.model.openText(id);
        for (let k = 0; k < 20; k++) t.insert(0, `<${i}.${k}>`);
      }),
    );
    await converged(nodes, id, 10_000);
    console.log(`[scale] 12x20 concurrent edits converged in ${(performance.now() - t0).toFixed(0)}ms`);
    const final = await text(nodes[0]!, id);
    for (let i = 0; i < 12; i++) for (let k = 0; k < 20; k++) expect(final).toContain(`<${i}.${k}>`);
  }, 60_000);

  it('partial mesh: a pair that cannot connect directly still gets every edit through the others', async () => {
    const { nodes, id } = await group(8, async (nt, ns) => {
      for (let i = 0; i < ns.length; i++)
        for (let j = i + 1; j < ns.length; j++) if (!(i === 0 && j === 1)) await nt.link(ns[i]!, ns[j]!, FAST);
    });
    const t0 = await nodes[0]!.model.openText(id);
    t0.insert(t0.length, 'from-p0');
    await seen(nodes[1]!, id, 'from-p0');
    const t1 = await nodes[1]!.model.openText(id);
    t1.insert(0, 'from-p1');
    await seen(nodes[0]!, id, 'from-p1');
    await converged(nodes, id, 5000);
  }, 60_000);

  it('chain topology (A-B-C-D-E): edits travel end to end without endless re-forwarding', async () => {
    const { nodes, id } = await group(5, async (nt, ns) => {
      for (let i = 0; i + 1 < ns.length; i++) await nt.link(ns[i]!, ns[i + 1]!, FAST);
    });
    const frames = await countFrames(nodes, async () => {
      const t = await nodes[0]!.model.openText(id);
      t.insert(t.length, 'end-to-end');
      await seen(nodes[4]!, id, 'end-to-end');
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(frames).toBe(4); // one hop per link, nothing bounces back
    await converged(nodes, id, 5000);
  }, 60_000);

  it('a late joiner connected to one peer catches up with everything', async () => {
    const { nodes, id } = await group(6);
    for (let i = 0; i < 6; i++) (await nodes[i]!.model.openText(id)).insert(0, `[${i}]`);
    await converged(nodes, id, 5000);
    const late = await net.add('late', 'editor');
    await net.link(late, nodes[3]!, FAST);
    await late.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await text(late, id)) === (await text(nodes[0]!, id)), 5000);
  }, 60_000);
});
