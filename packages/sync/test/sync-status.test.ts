import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { SyncTracker, type SyncEvent } from '../src/sync-status.js';
import { waitFor } from './helpers.js';
import { Net, type Node } from './net.js';

let net: Net;
const trackers: SyncTracker[] = [];
afterEach(() => {
  for (const t of trackers.splice(0)) t.stop();
  net?.destroy();
});

function track(n: Node, o: { autoFetch?: boolean; stallMs?: number; now?: () => number; connecting?: () => number } = {}) {
  const blobs = new BlobManager(n.mesh, n.store);
  const t = new SyncTracker({
    mesh: n.mesh,
    model: n.model,
    store: n.store,
    blobs,
    connecting: o.connecting ?? (() => 0),
    offline: () => false,
    throttleMs: 5,
    ...o,
  });
  const events: SyncEvent[] = [];
  t.onEvent((e) => events.push(e));
  t.start();
  trackers.push(t);
  return { t, blobs, events };
}

describe('sync status', () => {
  it('lists file names before contents, then progresses to synced with an event', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    for (let i = 0; i < 6; i++) await a.model.createTextNow(`s${i}.tex`, `content ${i}`);
    const { t, events } = track(b, { autoFetch: false });
    expect((await t.refresh()).stage).toBe('alone');
    await net.link(a, b);
    // root arrives -> names known, contents not requested yet
    await waitFor(() => b.model.list().length === 6, 3000);
    await waitFor(() => t.snapshot.rootSynced && t.snapshot.total === 6, 3000);
    expect(t.snapshot.files.map((f) => f.path).sort()).toEqual(['s0.tex', 's1.tex', 's2.tex', 's3.tex', 's4.tex', 's5.tex']);
    expect(t.snapshot.received).toBe(0);
    expect(t.snapshot.stage).toBe('receiving');
    expect(t.snapshot.percent).toBe(0);
    expect(t.snapshot.files.every((f) => f.state === 'receiving')).toBe(true);
    await t.fetchAll();
    await waitFor(() => t.snapshot.stage === 'synced', 3000);
    expect(t.snapshot.percent).toBe(100);
    expect(t.snapshot.lastSyncAt).toBeTypeOf('number');
    expect(events).toContain('complete');
  });

  it('fetches automatically when peers connect and counts binary files by stored blob', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    const ablobs = new BlobManager(a.mesh, a.store);
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    const hash = await ablobs.add(bytes);
    a.model.createBinary('fig.png', hash, bytes.length);
    await a.model.createTextNow('main.tex', 'hi');
    const { t } = track(b);
    await net.link(a, b);
    await waitFor(() => t.snapshot.stage === 'synced', 8000);
    expect(t.snapshot.total).toBe(2);
    expect(t.snapshot.received).toBe(2);
    expect(await b.store.getBlob(hash)).toBeDefined();
  }, 15_000);

  it('counts files created on this device as received and reports no percent while alone', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    await a.model.createTextNow('main.tex', 'x');
    const { t } = track(a);
    const s = await t.refresh();
    expect(s.stage).toBe('alone');
    expect(s.percent).toBeNull();
    expect(s.received).toBe(1);
  });

  it('reports connecting co-authors and a stall when nothing progresses', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    let clock = 1_000_000;
    let connecting = 1;
    const { t, events } = track(a, { stallMs: 60_000, now: () => clock, connecting: () => connecting });
    expect((await t.refresh()).stage).toBe('connecting');
    expect(t.snapshot.stalled).toBe(false);
    clock += 61_000;
    expect((await t.refresh()).stalled).toBe(true);
    expect(events).toEqual(['stalled']);
    connecting = 0;
    expect((await t.refresh()).stage).toBe('alone');
  });

  it('answers a request for the document of an empty file so it counts as received', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await a.model.createTextNow('empty.tex', '');
    const { t } = track(b);
    await net.link(a, b);
    await waitFor(() => t.snapshot.stage === 'synced', 5000);
    expect(t.snapshot.received).toBe(1);
  });

  it('resync recovers a document whose answer was never delivered', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    const id = await a.model.createTextNow('main.tex', 'hello');
    await net.link(a, b);
    await waitFor(() => b.model.list().length === 1, 3000);
    // b believes it already asked for the doc (so openDoc would not ask again) but never got an answer
    await b.mesh.openDoc(`f:${id}`);
    (await b.model.openText(id)).delete(0, (await b.model.openText(id)).length);
    await b.mesh.resync();
    await waitFor(async () => (await b.model.openText(id)).toString() === 'hello', 3000);
  });

  it('stays cheap on a project of 5,000 files', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    await a.model.applyBatch(Array.from({ length: 5000 }, (_, i) => ({ op: 'text' as const, path: `d${i % 50}/f${i}.tex`, text: '' })));
    const { t } = track(a, { autoFetch: false });
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) await t.refresh();
    expect(t.snapshot.total).toBe(5000);
    expect((performance.now() - t0) / 5).toBeLessThan(500);
  }, 30_000);
});
