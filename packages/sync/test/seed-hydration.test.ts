import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { sha256Hex } from '../src/model.js';
import { SyncTracker } from '../src/sync-status.js';
import { Net, type Node, text } from '../src/testkit.js';

/**
 * 8.5: a background seed (no editor ever opens a file on it) hydrates every known text document and referenced binary,
 * reconciled with a current peer, and then supplies a newcomer after the author has left. An asset nobody can supply
 * stays visibly partial and is retried, never reported as received.
 */
let net: Net;
const trackers: SyncTracker[] = [];
afterEach(() => {
  for (const t of trackers.splice(0)) t.stop();
  net?.destroy();
});
function seedOf(n: Node) {
  const blobs = new BlobManager(n.mesh, n.store);
  const tracker = new SyncTracker({ mesh: n.mesh, model: n.model, store: n.store, blobs, connecting: () => 0, offline: () => false, throttleMs: 5, fetchTimeoutMs: 400, retryBaseMs: 100, retryMaxMs: 400 });
  tracker.start();
  trackers.push(tracker);
  return { blobs, tracker };
}
const until = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('background seed hydration (8.5)', () => {
  it('hydrates all texts and assets without an editor and bootstraps a newcomer after the author left', async () => {
    net = await Net.create();
    const author = await net.add('author', 'owner');
    const seed = await net.add('seed', 'editor');
    const authorBlobs = new BlobManager(author.mesh, author.store);
    const ids = [await author.model.createTextNow('main.tex', 'main text'), await author.model.createTextNow('ch/intro.tex', 'intro')];
    const png = new Uint8Array(70_000).map((_, i) => i % 251);
    const hash = await authorBlobs.add(png);
    author.model.createBinary('fig.png', hash, png.length);
    const s = seedOf(seed);
    await net.link(author, seed);
    // Hydration: every file reached and reconciled with the author, without opening any document on the seed.
    await until(() => s.tracker.snapshot.stage === 'synced');
    expect(s.tracker.snapshot.received).toBe(3);
    expect(await seed.store.getBlob(hash)).toBeDefined();
    for (const id of ids) expect(seed.model.availability(`f:${id}`)).toBe('complete');

    net.isolate(author); // the author goes offline
    author.mesh.destroy();
    const newcomer = await net.add('newcomer', 'editor');
    const n = seedOf(newcomer);
    await net.link(seed, newcomer);
    await until(() => n.tracker.snapshot.stage === 'synced');
    expect(await text(newcomer, ids[0] as string)).toBe('main text');
    expect(await text(newcomer, ids[1] as string)).toBe('intro');
    expect(await sha256Hex((await newcomer.store.getBlob(hash)) as Uint8Array)).toBe(hash);
  }, 30_000);

  it('a referenced asset nobody holds stays partial and retryable, and arrives once a holder connects', async () => {
    net = await Net.create();
    const author = await net.add('author', 'owner');
    const seed = await net.add('seed', 'editor');
    await author.model.createTextNow('main.tex', 'text arrives');
    const missing = new TextEncoder().encode('figure bytes only on another laptop');
    const hash = await sha256Hex(missing);
    author.model.createBinary('fig.png', hash, missing.length); // listed, but the author does not hold the bytes
    const s = seedOf(seed);
    await net.link(author, seed);
    await until(() => s.tracker.snapshot.files.some((f) => f.kind === 'text' && f.have && f.reconciled));
    await new Promise((r) => setTimeout(r, 800)); // several fetch attempts and retries
    const snap = await s.tracker.refresh();
    expect(snap.files.find((f) => f.kind === 'binary')?.have).toBe(false);
    expect(snap.stage).not.toBe('synced');
    expect(snap.lastSyncAt).toBeNull();
    // The laptop holding the figure comes online: the retry picks it up.
    const holder = await net.add('holder', 'editor');
    await new BlobManager(holder.mesh, holder.store).add(missing);
    await net.link(holder, seed);
    await until(() => s.tracker.snapshot.stage === 'synced', 15_000);
    expect(await seed.store.getBlob(hash)).toBeDefined();
  }, 30_000);
});
