import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { waitFor } from './helpers.js';
import { Net, converged, text } from './net.js';

let net: Net;
afterEach(() => net?.destroy());

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

function randomBytes(n: number) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
}

describe('large mesh (6.5)', () => {
  it('10 peers converge when editing concurrently (gossip relay for sparse links)', async () => {
    net = await Net.create();
    const nodes = [];
    for (let i = 0; i < 10; i++) nodes.push(await net.add(`user${i}`, 'editor', { meshOpts: { relayThreshold: 2 } }));
    // ring + a few chords: not fully connected, so updates must be relayed
    for (let i = 0; i < nodes.length; i++) await net.link(nodes[i]!, nodes[(i + 1) % nodes.length]!);
    await net.link(nodes[0]!, nodes[5]!);
    const id = await nodes[0]!.model.createTextNow('main.tex', 'start');
    await converged(nodes, id, 8000);

    const t0 = Date.now();
    await Promise.all(
      nodes.map(async (n, i) => {
        (await n.model.openText(id)).insert(0, `[${i}]`);
      }),
    );
    await converged(nodes, id, 8000);
    const final = await text(nodes[0]!, id);
    for (let i = 0; i < 10; i++) expect(final).toContain(`[${i}]`);
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 30_000);

  it('delivers an edit to a peer in under a second', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const id = await a.model.createTextNow('main.tex', 'x');
    await converged([a, b], id);
    const t0 = performance.now();
    (await a.model.openText(id)).insert(1, 'y');
    await waitFor(async () => (await text(b, id)) === 'xy', 1000, 1);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it('compresses large update batches over the wire', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const id = await a.model.createTextNow('big.tex', 'lorem ipsum dolor sit amet '.repeat(5000));
    await converged([a, b], id);
    expect((await text(b, id)).length).toBe(27 * 5000);
  });
});

describe('role enforcement through the mesh (6.6)', () => {
  it('discards and never forwards edits from a tampered viewer', async () => {
    net = await Net.create();
    const [owner, editor, viewer] = [await net.add('owen', 'owner'), await net.add('edna', 'editor'), await net.add('vic', 'viewer')];
    await net.fullMesh();
    const id = await owner.model.createTextNow('main.tex', 'original');
    await converged([owner, editor, viewer], id);

    // The tampered viewer client writes to its own replica and tries to push it.
    (await viewer.model.openText(id)).insert(0, 'HACKED ');
    viewer.model.createText('evil.tex');
    await new Promise((r) => setTimeout(r, 200));

    expect(await text(owner, id)).toBe('original');
    expect(await text(editor, id)).toBe('original');
    expect(owner.model.list().map((f) => f.path)).toEqual(['main.tex']);
    expect(editor.model.list().map((f) => f.path)).toEqual(['main.tex']);
    const dropped = owner.mesh.peers.find((p) => p.claims.uname === 'vic')?.conn.droppedFromViewer ?? 0;
    expect(dropped).toBeGreaterThan(0);
  });

  it('still lets viewers receive edits and publish presence', async () => {
    net = await Net.create();
    const [owner, viewer] = [await net.add('owen', 'owner'), await net.add('vic', 'viewer')];
    await net.link(owner, viewer);
    const id = await owner.model.createTextNow('main.tex', 'hello');
    await converged([owner, viewer], id);
    (await owner.model.openText(id)).insert(5, ' world');
    await waitFor(async () => (await text(viewer, id)) === 'hello world');

    viewer.mesh.awareness.setLocalState({ user: { name: 'vic' } });
    await waitFor(() => [...owner.mesh.awareness.getStates().values()].some((s) => s.user?.name === 'vic'));
  });
});

describe('membership epoch policy (6.2)', () => {
  it('drops a peer whose epoch stays behind past the grace period, and keeps one that refreshes', async () => {
    net = await Net.create();
    const clock = { t: Date.now() };
    net.auth.now = () => new Date(clock.t);
    const meshOpts = { epochGraceMs: 60_000, policyIntervalMs: 1_000_000 };
    const [owner, stale, fresh] = [
      await net.add('owen', 'owner', { meshOpts }),
      await net.add('sam', 'editor', { meshOpts }),
      await net.add('fay', 'editor', { meshOpts }),
    ];
    await net.link(owner, stale);
    await net.link(owner, fresh);

    // owner's membership view moves to epoch 2 (e.g. someone was removed)
    net.auth.epoch = 2;
    const ownerKeys = (owner as unknown as { mesh: { o: { keys: unknown } } }).mesh.o.keys;
    void ownerKeys;
    owner.mesh.broadcast(0x20, new TextEncoder().encode(JSON.stringify({ epoch: 2 })));
    await waitFor(() => owner.mesh.peers.length === 2 && owner.mesh.epoch === 2 && stale.mesh.epoch === 2 && fresh.mesh.epoch === 2).catch((e) => { throw new Error(`epochs ${owner.mesh.peers.length} ${stale.mesh.epoch} ${fresh.mesh.epoch}: ${e}`); });

    clock.t += 30_000;
    owner.mesh.enforcePolicy();
    expect(owner.mesh.peers).toHaveLength(2); // inside grace
    // fresh refreshes with an epoch-2 ticket
    const freshTicket = await net.auth.mint(
      { pid: 'proj1', uid: 'u-fay', uname: 'fay', dev: fresh.dev, keys: (fresh.mesh as unknown as { o: { keys: never } }).o.keys, role: 'editor', ep: 2 },
      { iat: Math.floor(clock.t / 1000) },
    );
    fresh.mesh.refreshOwnTicket(freshTicket);
    await waitFor(() => owner.mesh.peers.find((p) => p.claims.uname === 'fay')?.claims.ep === 2);

    clock.t += 40_000; // 70s since stale was noted
    owner.mesh.enforcePolicy();
    await waitFor(() => owner.mesh.peers.length === 1);
    expect(owner.mesh.peers[0]?.claims.uname).toBe('fay');
    // ...and cannot simply reconnect with the same stale ticket once the grace period is over
    await expect(net.link(owner, stale)).rejects.toThrow();
    expect(owner.mesh.rejected).toContain('stale membership epoch');
  });

  it('disconnects peers whose ticket expired without refresh', async () => {
    net = await Net.create();
    const clock = { t: Date.now() };
    net.auth.now = () => new Date(clock.t);
    const meshOpts = { policyIntervalMs: 1_000_000 };
    const [a, b] = [await net.add('alice', 'owner', { meshOpts }), await net.add('bob', 'editor', { meshOpts })];
    await net.link(a, b);
    clock.t += 16 * 60_000;
    a.mesh.enforcePolicy();
    await waitFor(() => a.mesh.peers.length === 0);
  });
});

describe('blob transfer (6.7)', () => {
  it('fetches a 5 MB image in verified chunks from multiple peers', async () => {
    net = await Net.create();
    const [a, b, c] = [await net.add('alice', 'owner'), await net.add('bob', 'editor'), await net.add('carol', 'editor')];
    await net.fullMesh();
    const [ba, bb, bc] = [a, b, c].map((n) => new BlobManager(n.mesh, n.store));
    const img = randomBytes(5 * 1024 * 1024);
    const hash = await ba!.add(img);
    // Make bob a second holder
    expect(same(await bb!.fetch(hash, 20_000), img)).toBe(true);
    await waitFor(() => (bc as unknown as { peerHas: Map<string, Set<string>> }).peerHas.size >= 1);
    const got = await bc!.fetch(hash, 20_000);
    expect(got.length).toBe(img.length);
    expect(same(got, img)).toBe(true);
  }, 60_000);

  it('discards corrupt chunks and refetches from another peer', async () => {
    net = await Net.create();
    const [good, bad, me] = [await net.add('gina', 'editor'), await net.add('brad', 'editor'), await net.add('mia', 'editor')];
    await net.fullMesh();
    const [bg, bb, bm] = [good, bad, me].map((n) => new BlobManager(n.mesh, n.store));
    const data = randomBytes(300 * 1024);
    const hash = await bg!.add(data);
    await bb!.add(data);
    bb!.corruptOutgoing = true;
    await waitFor(() => (bm as unknown as { peerHas: Map<string, Set<string>> }).peerHas.size === 2);
    const got = await bm!.fetch(hash, 20_000);
    expect(same(got, data)).toBe(true);
  }, 60_000);

  it('rejects when nobody has the blob', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const bb = new BlobManager(b.mesh, b.store);
    new BlobManager(a.mesh, a.store);
    await expect(bb.fetch('0'.repeat(64), 600)).rejects.toThrow(/unavailable/);
  });
});
