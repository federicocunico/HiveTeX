import { ROOT_DOC_ID } from '@hivetex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { FORK_JOURNAL_KEY, type ForkJournal, type MergeReport, OfflineFork, forkMeshOptions, listenForkStatus } from '../src/fork.js';
import type { ReconcileOutcome } from '../src/mesh.js';
import { ProjectModel } from '../src/model.js';
import { MemoryPersistence, type Persistence } from '../src/persistence.js';
import { FaultyPersistence } from './faulty-store.js';
import { waitFor } from './helpers.js';
import { Net, type Node, text } from './net.js';

/**
 * F03: an offline merge only runs on remote state confirmed for its own attempt, and fails closed otherwise: the
 * recovery data stays, nothing unmerged is shared, and a later attempt completes the merge.
 */

const OPTS = { flushMs: 1, retryMs: 5, maxRetryMs: 20 };
const BASE = 'one\ntwo\nthree\n';

// ---- scripted confirmations (unit level) ----

type Confirm = (docId: string, signal: AbortSignal) => Promise<ReconcileOutcome>;

/** Offline work: an edit of main.tex and a new file, made while no peer is linked; then a peer links. */
async function offlineWork(store: Persistence, retryMs?: number) {
  const seed = new ProjectModel(store, OPTS);
  await seed.init();
  const id = await seed.createTextNow('main.tex', BASE);
  await seed.flush();
  await seed.destroy();
  const model = new ProjectModel(store, OPTS);
  await model.init();
  const reports: MergeReport[] = [];
  const errors: unknown[] = [];
  let linked = false;
  let confirm: Confirm = async () => 'timeout';
  const fork = new OfflineFork({
    model,
    isLinked: () => linked,
    canEdit: () => true,
    confirm: (d, s) => confirm(d, s),
    onReport: (r) => reports.push(r),
    onError: (e) => errors.push(e),
    ...(retryMs ? { retryMs } : {}),
  });
  await fork.start();
  (await model.openText(id)).insert(0, 'OFFLINE ');
  await model.createTextNow('new.tex', 'brand new\n');
  await model.flush();
  linked = true;
  return { model, fork, reports, errors, id, setConfirm: (c: Confirm) => (confirm = c) };
}

const mineKeys = (store: MemoryPersistence) => [...store.meta.keys()].filter((k) => k.startsWith('fork:mine:'));
const stageOf = (store: MemoryPersistence) => (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal | undefined)?.stage;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('merge input must be confirmed', () => {
  for (const outcome of ['timeout', 'unavailable', 'disconnected', 'cancelled'] as const) {
    it(`${outcome} of the file table keeps the merge pending with its recovery data intact`, async () => {
      const store = new MemoryPersistence();
      const w = await offlineWork(store);
      w.setConfirm(async () => outcome);
      await w.fork.beforeSync();
      await waitFor(() => w.errors.length > 0);
      expect(w.fork.active).toBe(true);
      expect(w.reports).toEqual([]);
      expect(stageOf(store)).toBe('prepared');
      expect(mineKeys(store).length).toBeGreaterThan(0);
      expect(w.model.find('new.tex')).toBeUndefined(); // the shared file table was not touched
    });
  }

  it('a file document that is not confirmed leaves the whole merge unapplied, and the next attempt completes it once', async () => {
    const store = new MemoryPersistence();
    const w = await offlineWork(store);
    // root arrives, then the link drops before the file's state does
    w.setConfirm(async (d) => (d === ROOT_DOC_ID ? 'confirmed' : 'disconnected'));
    await w.fork.beforeSync();
    await waitFor(() => w.errors.length > 0);
    expect(w.fork.active).toBe(true);
    expect(w.model.find('new.tex')).toBeUndefined(); // no half-applied file table
    expect(w.fork.conflicts).toEqual([]);
    expect(mineKeys(store).length).toBeGreaterThan(0);
    // reconnected: everything is confirmed now
    w.setConfirm(async () => 'confirmed');
    await w.fork.beforeSync();
    await waitFor(() => !w.fork.active);
    expect((await w.model.openText(w.id)).toString()).toBe(`OFFLINE ${BASE}`);
    expect((await w.model.openText(w.model.find('new.tex')?.id as string)).toString()).toBe('brand new\n');
    expect(w.reports).toHaveLength(1);
  });

  it('retries by itself while the peer stays linked', async () => {
    const store = new MemoryPersistence();
    const w = await offlineWork(store, 20);
    let calls = 0;
    w.setConfirm(async () => (++calls > 2 ? 'confirmed' : 'timeout'));
    await w.fork.beforeSync();
    await waitFor(() => !w.fork.active, 3000);
    expect(w.errors.length).toBeGreaterThan(0);
    expect((await w.model.openText(w.id)).toString()).toBe(`OFFLINE ${BASE}`);
    expect(w.reports).toHaveLength(1);
  });

  it('the first retries come quickly, so a peer that only needs a moment to become complete does not hold the merge for seconds', async () => {
    const store = new MemoryPersistence();
    const w = await offlineWork(store); // default retry delay
    let calls = 0;
    w.setConfirm(async () => (++calls <= 2 ? 'unavailable' : 'confirmed')); // a joining peer that has nothing yet
    await w.fork.beforeSync();
    await waitFor(() => !w.fork.active, 2000);
    expect(w.reports).toHaveLength(1);
  });

  it('a viewer cannot confirm anything and holds no work: with only viewers around the work is shared as it is, at once', async () => {
    const store = new MemoryPersistence();
    const w = await offlineWork(store);
    let asked = 0;
    w.setConfirm(async () => (asked++, 'unavailable'));
    await w.fork.beforeSync({ deviceId: 'v', claims: { role: 'viewer' } } as never);
    expect(w.fork.active).toBe(false);
    expect(asked).toBe(0);
    expect((await w.model.openText(w.id)).toString()).toBe(`OFFLINE ${BASE}`); // nothing was set aside
    expect(mineKeys(store)).toEqual([]);
  });

  it('a late reply of an earlier attempt cannot certify the current one', async () => {
    const store = new MemoryPersistence();
    const w = await offlineWork(store);
    const late = deferred<ReconcileOutcome>();
    w.setConfirm((d) => (d === ROOT_DOC_ID ? late.promise : Promise.resolve('confirmed')));
    await w.fork.beforeSync(); // attempt 1: waiting for the file table
    w.setConfirm(async () => 'timeout');
    await w.fork.beforeSync(); // attempt 2 (a new link): its answers do not arrive
    await waitFor(() => w.errors.length > 0);
    late.resolve('confirmed'); // the answer to attempt 1 turns up now
    await new Promise((r) => setTimeout(r, 50));
    await expect.poll(async () => w.fork.active, { timeout: 15_000 }).toBe(true);
    expect(w.reports).toEqual([]);
    expect(mineKeys(store).length).toBeGreaterThan(0);
    w.setConfirm(async () => 'confirmed'); // attempt 3 is answered
    await w.fork.beforeSync();
    await waitFor(() => !w.fork.active);
    expect(w.reports).toHaveLength(1);
  });

  it('a new file whose text could not be applied the first time still gets its text when the merge is repeated', async () => {
    const store = new MemoryPersistence();
    const w = await offlineWork(store);
    w.setConfirm(async () => 'confirmed');
    const openText = w.model.openText.bind(w.model);
    let failed = false;
    w.model.openText = async (id: string) => {
      if (!failed && w.model.byId(id)?.path === 'new.tex') {
        failed = true;
        throw new Error('storage hiccup');
      }
      return openText(id);
    };
    await w.fork.beforeSync();
    await waitFor(() => w.errors.length > 0);
    expect(w.fork.active).toBe(true);
    await w.fork.beforeSync();
    await waitFor(() => !w.fork.active);
    const nid = w.model.find('new.tex')?.id as string;
    expect((await openText(nid)).toString()).toBe('brand new\n');
  });
});

// ---- over a real mesh ----

let net: Net;
afterEach(() => net?.destroy());

type FNode = Node & { fork: OfflineFork; reports: MergeReport[]; errors: unknown[]; gateErrors: unknown[] };

async function addNode(name: string, store?: Persistence, extra: object = {}): Promise<FNode> {
  const holder: { fork?: OfflineFork } = {};
  const gateErrors: unknown[] = [];
  const n = await net.add(name, 'editor', {
    authored: true,
    ...(store ? { store } : {}),
    meshOpts: { beforeSync: (p: { deviceId: string }) => holder.fork?.beforeSync(p) ?? Promise.resolve(), onSyncGateError: (_p: unknown, e: unknown) => gateErrors.push(e), ...extra },
  });
  const reports: MergeReport[] = [];
  const errors: unknown[] = [];
  const fork = new OfflineFork({
    model: n.model,
    canEdit: () => true,
    onReport: (r) => reports.push(r),
    onError: (e) => errors.push(e),
    statusTimeoutMs: 100,
    retryMs: 150,
    ...forkMeshOptions(() => n.mesh, () => n.dev, 300),
  });
  await fork.start();
  listenForkStatus(n.mesh, fork);
  holder.fork = fork;
  return Object.assign(n, { fork, reports, errors, gateErrors });
}

describe('F03 over the mesh', () => {
  it('a peer that does not answer in time leaves the fork pending; its late answer completes the merge exactly once', async () => {
    net = await Net.create();
    let hold: Promise<void> = Promise.resolve();
    let release = () => {};
    const a = await addNode('alice');
    const b = await net.add('bob', 'editor', { authored: true, meshOpts: { beforeSync: () => hold } });
    await net.link(a, b);
    const id = await a.model.createTextNow('main.tex', BASE);
    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await text(b, id)) === BASE, 3000);
    net.isolate(a);
    await waitFor(() => a.mesh.peers.length === 0 && b.mesh.peers.length === 0);
    (await a.model.openText(id)).insert(0, 'OFFLINE ');
    expect(a.fork.active).toBe(true);
    hold = new Promise<void>((r) => {
      release = r;
    }); // bob does not answer anything on the next link
    const linking = net.link(a, b); // bob's side does not finish linking while it holds
    await new Promise((r) => setTimeout(r, 1200)); // well past the confirmation deadline, with retries
    await expect.poll(async () => a.fork.active, { timeout: 15_000 }).toBe(true);
    expect(a.reports).toEqual([]);
    expect(a.fork.journal?.stage === 'prepared' || a.fork.journal?.stage === 'reconciling').toBe(true);
    expect(await text(b, id)).toBe(BASE); // nothing unmerged reached bob
    release();
    await linking;
    await waitFor(() => !a.fork.active, 5000);
    await waitFor(async () => (await text(b, id)) === `OFFLINE ${BASE}`, 5000);
    expect(await text(a, id)).toBe(`OFFLINE ${BASE}`);
    expect(a.reports).toHaveLength(1);
  });

  it('offline work reaches a viewer that joins, without waiting for anyone to confirm', async () => {
    net = await Net.create();
    const a = await addNode('alice');
    const v = await net.add('vic', 'viewer', {});
    const id = await a.model.createTextNow('main.tex', BASE); // created while alone: unshared work
    expect(a.fork.active).toBe(true);
    await net.link(a, v);
    await v.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await text(v, id).catch(() => '')) === BASE, 2000);
    expect(v.model.find('main.tex')).toBeDefined();
    expect(a.fork.active).toBe(false);
    expect(a.errors).toEqual([]);
  });

  it('a conflict found once the peer answers is decided by the member, and only the decision is shared', async () => {
    net = await Net.create();
    let hold: Promise<void> = Promise.resolve();
    let release = () => {};
    const a = await addNode('alice');
    const b = await net.add('bob', 'editor', { authored: true, meshOpts: { beforeSync: () => hold } });
    await net.link(a, b);
    const id = await a.model.createTextNow('main.tex', BASE);
    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await text(b, id)) === BASE, 3000);
    net.isolate(a);
    await waitFor(() => a.mesh.peers.length === 0 && b.mesh.peers.length === 0);
    const edit = async (n: Node, to: string) => {
      const t = await n.model.openText(id);
      t.doc?.transact(() => {
        t.delete(0, 3);
        t.insert(0, to);
      });
    };
    await edit(a, 'ALICE');
    await edit(b, 'BOB'); // bob works alone as well, on the same line
    hold = new Promise<void>((r) => {
      release = r;
    });
    const linking = net.link(a, b);
    await new Promise((r) => setTimeout(r, 800));
    expect(a.fork.conflicts).toEqual([]); // still waiting, nothing decided
    expect(await text(b, id)).toBe(`BOB\ntwo\nthree\n`);
    release();
    await linking;
    await waitFor(() => a.fork.conflicts.length === 1, 5000);
    expect(await text(a, id)).toBe(`BOB\ntwo\nthree\n`); // alice's version is held back until she decides
    expect(await a.fork.resolveText(a.fork.conflicts[0]?.id as string, ['mine'])).toBe('resolved');
    await waitFor(async () => (await text(b, id)) === `ALICE\ntwo\nthree\n`, 5000);
  });
});

class FlakyLoad extends FaultyPersistence {
  failLoad = new Set<string>();
  override async load(docId: string) {
    if (this.failLoad.has(docId)) throw new Error('load failed');
    return super.load(docId);
  }
}

describe('F03: failed preparation never shares the offline work', () => {
  it('a rejecting preparation stops the document exchange of that attempt, then the retry merges', async () => {
    net = await Net.create();
    const store = new FlakyLoad();
    const a0 = await addNode('alice', store);
    const b = await addNode('bob');
    await net.link(a0, b);
    const id = await a0.model.createTextNow('main.tex', BASE);
    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await text(b, id)) === BASE, 3000);
    // alice works alone, then her app restarts: her journal is still in the 'forked' stage
    net.isolate(a0);
    await waitFor(() => a0.mesh.peers.length === 0 && b.mesh.peers.length === 0);
    (await a0.model.openText(id)).insert(0, 'PRIVATE ');
    await a0.model.createTextNow('private.tex', 'secret\n');
    expect(a0.fork.active).toBe(true);
    a0.fork.stop();
    a0.mesh.destroy();
    await a0.model.destroy();
    store.failLoad.add(`f:${id}`);
    const a = await addNode('alice2', store);
    expect(a.fork.active).toBe(true);
    await net.link(a, b).catch(() => {});
    await waitFor(() => a.gateErrors.length > 0, 3000);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.model.find('private.tex')).toBeUndefined(); // nothing of the offline work was exchanged
    expect(await text(b, id)).toBe(BASE);
    expect(a.mesh.peers).toHaveLength(0); // the attempt's exchange was closed
    expect(a.fork.active).toBe(true);
    // storage works again: the next link retries from the journal and merges
    store.failLoad.clear();
    await net.link(a, b);
    await net.link(a, b);
    await waitFor(async () => (await text(b, id)) === `PRIVATE ${BASE}`, 5000);
    expect(b.model.find('private.tex')).toBeDefined();
    expect(a.gateErrors).toHaveLength(1);
  });
});
