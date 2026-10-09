/**
 * Group-scale sync benchmark: `pnpm --filter @p2platex/sync bench` (or `make bench`).
 * Measures, for 2..16 fully connected peers on the in-memory transport, how long a keystroke takes to reach every
 * other peer, how many messages each keystroke costs, and how fast concurrent typing by everyone converges.
 * Run once with immediate delivery (cost of the sync stack itself) and once with simulated one-way latency
 * (LATENCY_MS, default 20 ms) to see what users experience on a network.
 */
import { Net, type Node } from '../src/testkit.js';

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] as number;

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

async function converge(nodes: Node[], id: string) {
  for (;;) {
    const texts = await Promise.all(nodes.map(async (n) => (await n.model.openText(id)).toString()));
    if (texts.every((t) => t === texts[0])) return;
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function run(n: number, transport: { immediate?: boolean; latencyMs?: number }) {
  const net = await Net.create();
  try {
    const nodes: Node[] = [];
    for (let i = 0; i < n; i++) nodes.push(await net.add(`p${i}`, i === 0 ? 'owner' : 'editor'));
    await net.fullMesh(transport);
    const id = await nodes[0]!.model.createTextNow('main.tex', 'start\n');
    for (const x of nodes) await x.mesh.openDoc(`f:${id}`);
    await converge(nodes, id);
    await new Promise((r) => setTimeout(r, 300));
    let frames = 0;
    for (const x of nodes)
      for (const p of x.mesh.peers) {
        const orig = p.conn.send.bind(p.conn);
        p.conn.send = (async (...a: Parameters<typeof orig>) => {
          frames++;
          return orig(...a);
        }) as typeof orig;
      }
    const writer = nodes[1 % n]!;
    const wt = await writer.model.openText(id);
    const lat: number[] = [];
    const keys = 40;
    for (let k = 0; k < keys; k++) {
      const marker = `#${k}#`;
      const t0 = performance.now();
      wt.insert(wt.length, marker);
      await Promise.all(nodes.filter((x) => x !== writer).map((x) => seen(x, id, marker)));
      lat.push(performance.now() - t0);
    }
    await new Promise((r) => setTimeout(r, 100));
    const perKey = frames / keys;
    const t1 = performance.now();
    await Promise.all(
      nodes.map(async (x, i) => {
        const t = await x.model.openText(id);
        for (let k = 0; k < 20; k++) t.insert(0, `<${i}.${k}>`);
      }),
    );
    await converge(nodes, id);
    const conv = performance.now() - t1;
    return { n, p50: pct(lat, 50), p95: pct(lat, 95), max: Math.max(...lat), perKey, conv };
  } finally {
    net.destroy();
  }
}

const sizes = [2, 4, 6, 8, 10, 12, 16];
const latency = Number(process.env.LATENCY_MS ?? 20);
for (const [label, transport] of [
  ['sync stack only (immediate delivery)', { immediate: true }],
  [`with ${latency} ms one-way network latency`, { latencyMs: latency }],
] as const) {
  console.log(`\n${label}`);
  console.log('peers | keystroke p50 | p95      | max      | msgs/keystroke | everyone types 20 chars: converged');
  console.log('------|---------------|----------|----------|----------------|-----------------------------------');
  for (const n of sizes) {
    const r = await run(n, transport);
    console.log(
      `${String(r.n).padStart(5)} | ${r.p50.toFixed(2).padStart(10)} ms | ${r.p95.toFixed(2).padStart(5)} ms | ${r.max.toFixed(2).padStart(5)} ms | ${r.perKey.toFixed(1).padStart(14)} | ${r.conv.toFixed(0).padStart(6)} ms`,
    );
  }
}
process.exit(0);
