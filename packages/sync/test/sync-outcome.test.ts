import { fileDocId } from '@hivetex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { type SyncSnapshot, SyncTracker } from '../src/sync-status.js';
import { loopbackPair } from '../src/transport.js';
import { Gate } from './gate.js';
import { waitFor } from './helpers.js';
import { type Node, Net } from './net.js';

let net: Net;
const trackers: SyncTracker[] = [];
afterEach(() => {
  for (const t of trackers.splice(0)) t.stop();
  net?.destroy();
});

function track(n: Node, o: Record<string, unknown> = {}) {
  const t = new SyncTracker({
    mesh: n.mesh,
    model: n.model,
    store: n.store,
    blobs: new BlobManager(n.mesh, n.store),
    connecting: () => 0,
    offline: () => false,
    throttleMs: 5,
    ...o,
  } as ConstructorParameters<typeof SyncTracker>[0]);
  t.start();
  trackers.push(t);
  return t;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function twoFileProject() {
  net = await Net.create();
  const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
  await a.model.createTextNow('main.tex', 'one');
  await a.model.createTextNow('two.tex', 'two');
  return { a, b };
}

describe('status and manual sync follow current reconciliation (5.4, F13)', () => {
  it('does not call a cached reconnect up to date, nor advance the sync time, before the peer answered', async () => {
    const { a, b } = await twoFileProject();
    const t = track(b);
    await net.link(a, b);
    await waitFor(() => t.snapshot.stage === 'synced', 4000);
    const first = t.snapshot.lastSyncAt as number;
    expect(first).toBeTypeOf('number');
    net.isolate(b);
    await waitFor(() => t.snapshot.peers === 0 && t.snapshot.stage === 'alone');
    await sleep(30);
    // everything is cached and usable, but the new connection has not been asked yet (slow link)
    await net.link(a, b, { latencyMs: 150 });
    const snap: SyncSnapshot = await t.refresh();
    expect(snap.files.every((f) => f.have)).toBe(true);
    expect(snap.stage).toBe('reconciling');
    expect(snap.reconciled).toBeLessThan(snap.total);
    expect(snap.lastSyncAt).toBe(first);
    await waitFor(() => t.snapshot.stage === 'synced', 4000);
    expect(t.snapshot.lastSyncAt as number).toBeGreaterThan(first);
  });

  it('does not report success for queued requests nobody answered', async () => {
    const { a, b } = await twoFileProject();
    const t = track(b);
    const [ta, tb] = loopbackPair();
    const ga = new Gate(ta);
    await Promise.all([a.mesh.addTransport(ga), b.mesh.addTransport(tb)]);
    await waitFor(() => t.snapshot.stage === 'synced', 4000);
    const synced = t.snapshot.lastSyncAt as number;
    await sleep(30);
    ga.closed = true; // alice stops answering
    const out = await t.syncNow({ timeoutMs: 80 });
    expect(out.status).toBe('pending');
    expect(out.pending).toBeGreaterThan(0);
    expect(t.snapshot.lastSyncAt).toBe(synced);
    await ga.release();
    const again = await t.syncNow({ timeoutMs: 3000 });
    expect(again.status).toBe('complete');
    expect(t.snapshot.lastSyncAt as number).toBeGreaterThan(synced);
  });

  it('reports content nobody can supply as failed, and nobody online as no-peer, keeping local edits', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    a.model.putEntry('ghost', { path: 'ghost.tex', kind: 'text' });
    const id = await b.model.createTextNow('mine.tex', 'local edit');
    const t = track(b, { autoFetch: false });
    expect((await t.syncNow()).status).toBe('no-peer');
    await net.link(a, b);
    await waitFor(() => t.snapshot.total === 2 && t.snapshot.rootSynced);
    const out = await t.syncNow({ timeoutMs: 2000 });
    expect(out.status).toBe('failed');
    expect(out.missingText).toBe(1);
    expect(t.snapshot.stage).toBe('receiving');
    expect((await b.model.openText(id)).toString()).toBe('local edit');
    expect(t.snapshot.lastSyncAt).toBeNull();
  });

});

describe('complete-project snapshots for consumers (5.2, 5.6)', () => {
  it('returns at once when everything is complete, also offline, and never substitutes empty text', async () => {
    const { a, b } = await twoFileProject();
    expect(await a.mesh.awaitComplete()).toMatchObject({ complete: true, missing: [] });
    // a joiner with only the file list: the bodies are reported as missing, then fetched
    await net.link(a, b);
    await waitFor(() => b.model.list().length === 2);
    const ids = b.model.list().map((f) => fileDocId(f.id));
    expect(b.model.missingText()).toHaveLength(2);
    const r = await b.mesh.awaitComplete({ timeoutMs: 3000 });
    expect(r.complete).toBe(true);
    for (const id of ids) expect(b.model.availability(id)).toBe('complete');
    // and it is still complete once the peers are gone
    net.isolate(b);
    await waitFor(() => b.mesh.peers.length === 0);
    expect(await b.mesh.awaitComplete()).toMatchObject({ complete: true });
  });

  it('names what remains unavailable instead of claiming completeness', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await a.model.createTextNow('main.tex', 'here');
    a.model.putEntry('ghost', { path: 'ghost.tex', kind: 'text' });
    await net.link(a, b);
    await waitFor(() => b.model.list().length === 2);
    const r = await b.mesh.awaitComplete({ timeoutMs: 2000 });
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual([expect.objectContaining({ fileId: 'ghost', path: 'ghost.tex', outcome: 'unavailable' })]);
  });
});
