import { existsSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { ROOT_DOC_ID } from '@hivetex/protocol';
import { Net, type Node, converged, identity, waitFor } from '../src/testkit.js';
import { loopbackPair } from '../src/transport.js';
import { listRecovery, readRecovery } from '../src/recovery.js';

/**
 * Interoperability with a real 0.8.0 peer: the sync package of release 0.8.0 (git 9aeb8df) checked out in a separate
 * worktree, e.g. `git worktree add --detach %TEMP%\p2platex-080 9aeb8df` and `pnpm install --offline --frozen-lockfile`
 * there (docs/testing.md). HIVETEX_080_SYNC names its `packages/sync/src`. Without that checkout these tests are
 * skipped with the reason; with HIVETEX_NATIVE_TESTS=1 (required runs) a missing checkout fails.
 */
const old080 = process.env.HIVETEX_080_SYNC ?? `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/p2platex-080/packages/sync/src`;
const available = existsSync(`${old080}/mesh.ts`);
if (!available && process.env.HIVETEX_NATIVE_TESTS === '1') throw new Error(`0.8.0 peer checkout missing at ${old080} (see docs/testing.md)`);
if (!available) console.warn(`[skip] legacy-peer: no 0.8.0 checkout at ${old080}; see docs/testing.md to enable`);
const url = (m: string) => `file:///${old080.replace(/\\/g, '/').replace(/^\/+/, '')}/${m}`;

interface OldNode { model: any; mesh: any; store: any; fs: Map<string, Uint8Array> }

async function oldPeer(net: Net, name: string): Promise<OldNode> {
  const [{ ProjectModel }, { Mesh }, { MemoryPersistence }, { MirrorSync }, { BlobManager }] = await Promise.all(
    ['model.ts', 'mesh.ts', 'persistence.ts', 'mirror.ts', 'blobs.ts'].map((m) => import(/* @vite-ignore */ url(m))));
  const id = await identity(name, 'editor');
  const ticket = await net.auth.mint({ pid: net.pid, uid: id.uid, uname: name, dev: id.dev, keys: id.keys, role: 'editor' });
  const store = new MemoryPersistence();
  const model = new ProjectModel(store, { flushMs: 5 });
  await model.init();
  const mesh = new Mesh({ projectId: net.pid, model, keys: id.keys, trusted: net.auth.trusted, getTicket: () => ticket });
  // A bound folder, kept by the 0.8.0 mirror itself.
  const files = new Map<string, Uint8Array>(), watchers = new Set<(ev: { path: string }) => void>();
  const fs = {
    list: async () => [...files].map(([path, b]) => ({ path, size: b.length })),
    read: async (p: string) => files.get(p) ?? null,
    write: async (p: string, b: Uint8Array) => { files.set(p, b.slice()); },
    remove: async (p: string) => { files.delete(p); },
    watch: (cb: (ev: { path: string }) => void) => { watchers.add(cb); return () => watchers.delete(cb); },
  };
  const mirror = new MirrorSync({ model, mesh, blobs: new BlobManager(mesh, store), fs, getRole: () => 'editor', debounceMs: 5 });
  await mirror.start();
  const node = { model, mesh, store, fs: files };
  stops.push(() => { mirror.stop(); mesh.destroy(); });
  return node;
}

async function link(a: Node | OldNode, b: Node | OldNode) {
  const [ta, tb] = loopbackPair();
  await Promise.all([a.mesh.addTransport(ta), b.mesh.addTransport(tb)]);
}
const textOf = async (n: Node | OldNode, id: string) => (await n.model.openText(id)).toString();
const folderText = (n: OldNode, path: string) => { const b = n.fs.get(path); return b ? new TextDecoder().decode(b) : undefined; };

let net: Net | undefined;
const stops: Array<() => void> = [];
afterEach(() => { net?.destroy(); for (const s of stops.splice(0)) s(); });

it.skipIf(!available)('an upgraded deletion is an ordinary deletion for 0.8.0: gone from its tree and folder, never written back', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner');
  const c = await oldPeer(net, 'Carol');
  const old = await a.model.createTextNow('old.tex', 'old content');
  const other = await a.model.createTextNow('other.tex', 'other');
  await link(a, c);
  await waitFor(() => folderText(c, 'old.tex') === 'old content' && folderText(c, 'other.tex') === 'other', 10_000);
  a.model.delete(old);
  await waitFor(() => !c.model.list().some((f: { id: string }) => f.id === old) && !c.fs.has('old.tex'), 10_000);
  // Carol keeps editing another file; nothing brings old.tex back on either side.
  c.fs.set('other.tex', new TextEncoder().encode('other, edited by 0.8.0'));
  await c.model.openText(other).then((t: { insert: (i: number, s: string) => void }) => t.insert(0, '% '));
  await waitFor(async () => (await textOf(a, other)).startsWith('% '), 10_000);
  await new Promise((r) => setTimeout(r, 300));
  expect(c.fs.has('old.tex')).toBe(false);
  expect(c.model.list().some((f: { id: string }) => f.id === old)).toBe(false);
  expect(a.model.byId(old)).toBeUndefined();
  expect(a.model.deletedFiles().map((f) => f.id)).toEqual([old]);
  expect(await textOf(a, old)).toBe('old content');
});

it.skipIf(!available)('a 0.8.0 deletion applies on the upgraded peer, which keeps the removed file in Recovery', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner');
  const c = await oldPeer(net, 'Carol');
  const keep = await a.model.createTextNow('keep.tex', 'keep me');
  const fresh = await a.model.createTextNow('fresh.tex', 'x');
  await link(a, c);
  await waitFor(() => folderText(c, 'keep.tex') === 'keep me', 10_000);
  c.model.delete(keep);
  await waitFor(() => !a.model.byId(keep), 10_000);
  expect(a.mesh.historyStatus.quarantined).toBe(0);
  const removed = (await listRecovery(a.store)).filter((r) => r.fileId === keep);
  expect(removed).toHaveLength(1);
  expect(new TextDecoder().decode(await readRecovery(a.store, removed[0]!.id))).toBe('keep me');
  // Later root changes from the same peer still apply.
  c.model.rename(fresh, 'renamed.tex');
  await waitFor(() => a.model.byId(fresh)?.path === 'renamed.tex', 10_000);
});

it.skipIf(!available)('edits forwarded by an upgraded peer reach a 0.8.0 peer as plain updates, without a resync (Alice -> Bob -> Carol)', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor');
  const c = await oldPeer(net, 'Carol');
  const id = await a.model.createTextNow('main.tex', 'base');
  await net.link(a, b);
  await converged([a, b], id);
  expect((await b.mesh.reconcile(`f:${id}`)).outcome).toBe('confirmed');
  await link(b, c);
  await waitFor(() => folderText(c, 'main.tex') === 'base', 10_000).catch(async (e) => { console.error('TRACE', JSON.stringify({ list: c.model.list(), fs: [...c.fs.keys()], rootB: b.model.availability('root'), docB: b.model.availability('f:'+id), rootC: c.model.availability('root'), docC: c.model.availability('f:'+id), textC: await textOf(c, id) })); throw e; });
  await c.mesh.openDoc(`f:${id}`);
  const text = await a.model.openText(id);
  for (let n = 1; n <= 5; n++) {
    const started = Date.now();
    text.insert(text.length, ` ${n}`);
    await waitFor(async () => (await textOf(c, id)).endsWith(` ${n}`), 2_000);
    expect(Date.now() - started).toBeLessThan(2_000);
  }
  expect(await textOf(c, id)).toBe('base 1 2 3 4 5');
  expect(b.model.availability(ROOT_DOC_ID)).toBe('complete');
});
