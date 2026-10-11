import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { sha256Hex } from '../src/model.js';
import { type SyncEvent, SyncTracker } from '../src/sync-status.js';
import { waitFor } from './helpers.js';
import { type Node, Net } from './net.js';

let net: Net;
const trackers: SyncTracker[] = [];
afterEach(() => {
  for (const t of trackers.splice(0)) t.stop();
  net?.destroy();
});

function track(n: Node, o: Partial<ConstructorParameters<typeof SyncTracker>[0]> & Record<string, unknown> = {}) {
  const blobs = new BlobManager(n.mesh, n.store);
  const t = new SyncTracker({
    mesh: n.mesh,
    model: n.model,
    store: n.store,
    blobs,
    connecting: () => 0,
    offline: () => false,
    throttleMs: 5,
    ...o,
  } as ConstructorParameters<typeof SyncTracker>[0]);
  const events: SyncEvent[] = [];
  t.onEvent((e) => events.push(e));
  t.start();
  trackers.push(t);
  return { t, blobs, events };
}

const bytesOf = (seed: number) => new Uint8Array(3000).map((_, i) => (i * seed) % 251);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('missing-content retries follow identity, source and generation (5.3, F13)', () => {
  it('retries an image automatically once a connected peer announces it', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    const ablobs = new BlobManager(a.mesh, a.store);
    const bytes = bytesOf(7);
    a.model.createBinary('fig.png', await sha256Hex(bytes), bytes.length); // listed, but nobody holds the bytes yet
    const { t } = track(b, { fetchTimeoutMs: 100 });
    await net.link(a, b);
    await waitFor(() => t.snapshot.total === 1 && t.snapshot.rootSynced);
    await sleep(400); // the first attempt failed: nobody has announced it
    expect(t.snapshot.stage).toBe('receiving');
    await ablobs.add(bytes);
    await waitFor(() => t.snapshot.stage === 'synced', 3000);
    expect(await b.store.getBlob(await sha256Hex(bytes))).toBeDefined();
  });

  it('fetches a replaced asset although the number of files and peers did not change', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    const ablobs = new BlobManager(a.mesh, a.store);
    const [old, next] = [bytesOf(3), bytesOf(5)];
    const id = a.model.createBinary('fig.png', await sha256Hex(old), old.length); // never available
    const { t } = track(b, { fetchTimeoutMs: 100 });
    await net.link(a, b);
    await waitFor(() => t.snapshot.total === 1 && t.snapshot.rootSynced);
    await sleep(400);
    expect(t.snapshot.received).toBe(0);
    await ablobs.add(next);
    a.model.setBinary(id, await sha256Hex(next), next.length);
    await waitFor(() => t.snapshot.stage === 'synced', 3000);
    expect(await b.store.getBlob(await sha256Hex(next))).toBeDefined();
  });

  it('retries a document when its source is replaced by another peer, with the same number of peers', async () => {
    net = await Net.create();
    const [a, d, b] = [await net.add('alice', 'owner'), await net.add('dora', 'editor'), await net.add('bob', 'editor')];
    const id = await a.model.createTextNow('main.tex', 'body');
    await net.link(a, d);
    await waitFor(() => d.model.list().length === 1);
    await d.mesh.reconcile('root'); // dora knows the file list, not the body
    const { t } = track(b, { fetchTimeoutMs: 200 });
    await net.link(d, b);
    await waitFor(() => t.snapshot.total === 1 && t.snapshot.rootSynced);
    await sleep(500);
    expect(t.snapshot.received).toBe(0); // dora cannot supply it
    net.isolate(d);
    await waitFor(() => b.mesh.peers.length === 0);
    await net.link(a, b); // one peer again: a different one, and the counts are as before
    await waitFor(async () => (await b.model.openText(id)).toString() === 'body', 3000);
    await waitFor(() => t.snapshot.stage === 'synced', 3000);
  });

  it('does not let an active file hide another file that stopped making progress', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    const live = await a.model.createTextNow('live.tex', 'v0');
    a.model.putEntry('stuck', { path: 'stuck.tex', kind: 'text' }); // nobody has its body
    let clock = 1_000_000;
    const { t, events } = track(b, { autoFetch: false, stallMs: 60_000, now: () => clock });
    await net.link(a, b);
    await waitFor(() => b.model.list().length === 2);
    await b.mesh.openDoc(`f:${live}`);
    await t.refresh();
    for (let i = 1; i <= 4; i++) {
      clock += 20_000;
      (await a.model.openText(live)).insert(0, `v${i} `);
      await waitFor(async () => (await b.model.openText(live)).toString().startsWith(`v${i} `));
      await t.refresh();
    }
    expect(t.snapshot.stalled).toBe(true);
    expect(events).toContain('stalled');
  });
});
