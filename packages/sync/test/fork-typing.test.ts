import { ROOT_DOC_ID } from '@hivetex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { FORK_JOURNAL_KEY, type ForkJournal, type MergeReport, OfflineFork, forkMeshOptions, listenForkStatus } from '../src/fork.js';
import type { ReconcileOutcome } from '../src/mesh.js';
import { ProjectModel } from '../src/model.js';
import { MemoryPersistence, type Persistence } from '../src/persistence.js';
import { FaultyPersistence } from './faulty-store.js';
import { waitFor } from './helpers.js';
import { Net, type Node, text } from './net.js';

/**
 * Edits typed while an offline merge captures, replaces and resolves are never lost or applied twice, and a member who
 * lost edit rights never publishes offline work (the explicit demotion policy: it is dropped, see offline.md).
 */

const OPTS = { flushMs: 1, retryMs: 5, maxRetryMs: 20 };
const BASE = 'one\ntwo\nthree\n';

class SlowLoad extends FaultyPersistence {
  slow = new Map<string, { gate: Promise<void>; reached: () => void }>();
  override async load(docId: string) {
    const s = this.slow.get(docId);
    if (s) {
      this.slow.delete(docId);
      s.reached();
      await s.gate;
    }
    return super.load(docId);
  }
}

interface Open {
  model: ProjectModel;
  fork: OfflineFork;
  reports: MergeReport[];
  errors: unknown[];
  linked: { value: boolean };
  can: { value: boolean };
  confirm: { fn: (docId: string) => Promise<ReconcileOutcome> };
}

async function open(store: Persistence, o: { linked?: boolean; canEdit?: boolean; selfDevice?: string } = {}): Promise<Open> {
  const model = new ProjectModel(store, OPTS);
  await model.init();
  const reports: MergeReport[] = [];
  const errors: unknown[] = [];
  const linked = { value: o.linked ?? false };
  const can = { value: o.canEdit ?? true };
  const confirm = { fn: (async () => 'confirmed') as (docId: string) => Promise<ReconcileOutcome> };
  const fork = new OfflineFork({
    model,
    isLinked: () => linked.value,
    canEdit: () => can.value,
    confirm: (d) => confirm.fn(d),
    onReport: (r) => reports.push(r),
    onError: (e) => errors.push(e),
    ...(o.selfDevice ? { selfDevice: () => o.selfDevice as string, statusTimeoutMs: 20 } : {}),
  });
  await fork.start();
  return { model, fork, reports, errors, linked, can, confirm };
}

async function seedProject(store: Persistence, files: Record<string, string>) {
  const seed = new ProjectModel(store, OPTS);
  await seed.init();
  const ids: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) ids[path] = await seed.createTextNow(path, content);
  await seed.flush();
  await seed.destroy();
  return ids;
}

const textOf = async (model: ProjectModel, id: string) => (await model.openText(id)).toString();
const stage = (store: MemoryPersistence) => (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal | undefined)?.stage;
const never = () => new Promise<ReconcileOutcome>(() => {});

describe('edits typed while the documents are replaced', () => {
  const MULTI = 'base\nmid\nend\n';

  it('an edit typed while the replacement is being stored is merged with the offline text, once, also after a restart', async () => {
    const store = new FaultyPersistence();
    const ids = await seedProject(store, { 'main.tex': MULTI });
    const s = await open(store);
    const id = ids['main.tex'] as string;
    (await s.model.openText(id)).insert(0, 'OFFLINE ');
    await s.model.flush();
    s.confirm.fn = never; // no answer: the merge waits in its prepared stage
    const hold = store.hold('transact');
    const prepared = s.fork.beforeSync();
    await hold.reached; // the swap is done in memory, its storage transition is still under way
    const t = await s.model.openText(id);
    t.insert(t.length, 'TYPED\n'); // the member keeps typing into the swapped-in document
    hold.release();
    await prepared;
    await s.model.flush();
    expect(stage(store)).toBe('prepared');
    // the app restarts now: the typed line was stored with the replacement, the offline text is in the journal's copy
    const again = await open(store);
    expect(await textOf(again.model, id)).toBe(`${MULTI}TYPED\n`);
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(again.model, id)).toBe('OFFLINE base\nmid\nend\nTYPED\n');
  });

  it('an edit typed while the replacement keeps failing is retained and survives once storage works', async () => {
    const store = new FaultyPersistence();
    const ids = await seedProject(store, { 'main.tex': MULTI });
    const s = await open(store);
    const id = ids['main.tex'] as string;
    (await s.model.openText(id)).insert(0, 'OFFLINE ');
    await s.model.flush();
    s.confirm.fn = never;
    store.failTransact = 3;
    await expect(s.fork.beforeSync()).rejects.toThrow('transact failed');
    const t = await s.model.openText(id);
    t.insert(t.length, 'TYPED\n');
    await waitFor(() => stage(store) === 'prepared');
    await s.model.flush();
    const again = await open(store);
    expect(await textOf(again.model, id)).toBe(`${MULTI}TYPED\n`);
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(again.model, id)).toBe('OFFLINE base\nmid\nend\nTYPED\n');
  });

  it('an edit typed while the documents are still being loaded for the capture is part of the captured version', async () => {
    const store = new SlowLoad();
    const ids = await seedProject(store, { 'a.tex': MULTI, 'b.tex': MULTI });
    const first = await open(store);
    (await first.model.openText(ids['a.tex'] as string)).insert(0, 'OFFLINE-A ');
    (await first.model.openText(ids['b.tex'] as string)).insert(0, 'OFFLINE-B ');
    await first.model.flush();
    await first.model.destroy();
    // restart in the 'forked' stage: nothing is loaded yet
    const s = await open(store);
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => {
      reached = r;
    });
    let go!: () => void;
    const gate = new Promise<void>((r) => {
      go = r;
    });
    store.slow.set(`f:${ids['b.tex']}`, { gate, reached });
    const done = s.fork.beforeSync();
    await reachedP; // a.tex is loaded, b.tex is not
    const a = await s.model.openText(ids['a.tex'] as string);
    a.insert(a.length, 'TYPED\n');
    go();
    await done;
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(s.model, ids['a.tex'] as string)).toBe('OFFLINE-A base\nmid\nend\nTYPED\n');
    expect(await textOf(s.model, ids['b.tex'] as string)).toBe('OFFLINE-B base\nmid\nend\n');
  });

  it('a document first edited while the capture is loading others is captured and replaced too', async () => {
    const store = new SlowLoad();
    const ids = await seedProject(store, { 'a.tex': MULTI, 'b.tex': MULTI });
    const first = await open(store);
    (await first.model.openText(ids['a.tex'] as string)).insert(0, 'OFFLINE-A ');
    await first.model.flush();
    await first.model.destroy();
    const s = await open(store);
    s.confirm.fn = never;
    let reached!: () => void;
    const reachedP = new Promise<void>((r) => {
      reached = r;
    });
    let go!: () => void;
    const gate = new Promise<void>((r) => {
      go = r;
    });
    store.slow.set(`f:${ids['a.tex']}`, { gate, reached });
    const done = s.fork.beforeSync();
    await reachedP;
    // no peer was linked as far as this device knows: the edit of another file still counts as offline work
    const bId = ids['b.tex'] as string;
    (await s.model.openText(bId)).insert(0, 'LATE ');
    go();
    await done;
    await waitFor(() => stage(store) === 'prepared');
    expect((store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).docs).toContain(`f:${bId}`);
    const swapped = new Y.Doc();
    for (const u of await store.load(`f:${bId}`)) Y.applyUpdate(swapped, u);
    expect(swapped.getText('t').toString()).toBe(MULTI); // replaced by its base, nothing unmerged is shared
    s.confirm.fn = async () => 'confirmed';
    await s.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(s.model, bId)).toBe(`LATE ${MULTI}`);
  });
});

describe('edits typed while conflicts wait to be resolved', () => {
  /** A conflict on line 1 with a free line at the end of the file. */
  async function withConflict(store: MemoryPersistence) {
    const ids = await seedProject(store, { 'main.tex': BASE });
    const id = ids['main.tex'] as string;
    const s = await open(store);
    (await s.model.openText(id)).insert(0, 'MINE ');
    await s.model.flush();
    s.confirm.fn = async (d) => {
      if (d.startsWith('f:') && !s.model.byId('x')) {
        const t = await s.model.openText(id);
        if (!t.toString().startsWith('THEIRS')) t.insert(0, 'THEIRS ');
      }
      return 'confirmed';
    };
    await s.fork.beforeSync();
    await waitFor(() => s.fork.conflicts.length === 1);
    return { ...s, id };
  }

  it('what is typed meanwhile in other lines is kept when the member decides', async () => {
    const store = new MemoryPersistence();
    const s = await withConflict(store);
    const t = await s.model.openText(s.id);
    t.insert(t.length, 'TYPED\n');
    expect(await s.fork.resolveText(s.fork.conflicts[0]?.id as string, ['mine'])).toBe('resolved');
    expect(await textOf(s.model, s.id)).toBe('MINE one\ntwo\nthree\nTYPED\n');
  });

  it('what is typed in the conflicting lines keeps the conflict open, across a restart, until it is decided', async () => {
    const store = new MemoryPersistence();
    const s = await withConflict(store);
    const t = await s.model.openText(s.id);
    t.insert(0, 'MORE ');
    const c = s.fork.conflicts[0];
    expect(await s.fork.resolveText(c?.id as string, ['mine'])).toBe('conflict-again');
    await s.model.flush();
    const again = await open(store);
    expect(again.fork.conflicts).toHaveLength(1);
    expect(await textOf(again.model, s.id)).toContain('MORE');
    expect(await again.fork.resolveText(again.fork.conflicts[0]?.id as string, ['theirs'])).toBe('resolved');
    expect(await textOf(again.model, s.id)).toContain('MORE THEIRS');
  });

  it('a restart after the decision was applied but before it was recorded does not apply it twice', async () => {
    const store = new MemoryPersistence();
    const s = await withConflict(store);
    const before = structuredClone(store.meta.get('fork:conflicts'));
    expect(await s.fork.resolveText(s.fork.conflicts[0]?.id as string, ['mine'])).toBe('resolved');
    await s.model.flush();
    const want = await textOf(s.model, s.id);
    store.meta.set('fork:conflicts', before); // as if the crash came before the conflict list was updated
    const again = await open(store);
    expect(again.fork.conflicts).toHaveLength(1);
    expect(await again.fork.resolveText(again.fork.conflicts[0]?.id as string, ['mine'])).toBe('resolved');
    expect(await textOf(again.model, s.id)).toBe(want);
  });
});

describe('a member who lost edit rights', () => {
  it('never shares offline work, not even when the other device would have shared its own work as it is', async () => {
    const store = new MemoryPersistence();
    const ids = await seedProject(store, { 'main.tex': BASE });
    const id = ids['main.tex'] as string;
    const s = await open(store, { selfDevice: 'a' });
    (await s.model.openText(id)).insert(0, 'OFFLINE ');
    await s.model.flush();
    s.can.value = false; // demoted meanwhile
    s.linked.value = true;
    s.fork.receiveStatus('b', true); // the other device holds unshared work too, and has the higher id
    await s.fork.beforeSync({ deviceId: 'b' });
    // the offline version was replaced by the shared one: nothing of it can be exchanged
    expect(await textOf(s.model, id)).toBe(BASE);
    await waitFor(() => s.reports.length === 1);
    expect(s.reports[0]).toMatchObject({ discarded: true });
    expect(s.fork.active).toBe(false);
    expect(await textOf(s.model, id)).toBe(BASE);
  });

  it('cannot apply conflict decisions to the shared project, and keeps the conflicts', async () => {
    const store = new MemoryPersistence();
    const ids = await seedProject(store, { 'main.tex': BASE });
    const id = ids['main.tex'] as string;
    const s = await open(store);
    (await s.model.openText(id)).insert(0, 'MINE ');
    await s.model.flush();
    s.confirm.fn = async (d) => {
      if (d.startsWith('f:')) {
        const t = await s.model.openText(id);
        if (!t.toString().startsWith('THEIRS')) t.insert(0, 'THEIRS ');
      }
      return 'confirmed';
    };
    await s.fork.beforeSync();
    await waitFor(() => s.fork.conflicts.length === 1);
    s.can.value = false;
    const cid = s.fork.conflicts[0]?.id as string;
    await expect(s.fork.resolveText(cid, ['mine'])).rejects.toThrow(/edit/i);
    expect(await textOf(s.model, id)).toBe(`THEIRS ${BASE}`);
    expect(s.fork.conflicts).toHaveLength(1);
  });
});

// ---- over a mesh ----

let net: Net;
afterEach(() => net?.destroy());

type FNode = Node & { fork: OfflineFork; reports: MergeReport[] };

async function addNode(name: string, role: 'owner' | 'editor' | 'viewer', canEdit: () => boolean): Promise<FNode> {
  const holder: { fork?: OfflineFork } = {};
  const n = await net.add(name, role, { authored: true, meshOpts: { beforeSync: (p: { deviceId: string }) => holder.fork?.beforeSync(p) ?? Promise.resolve() } });
  const reports: MergeReport[] = [];
  const fork = new OfflineFork({ model: n.model, canEdit, onReport: (r) => reports.push(r), statusTimeoutMs: 100, retryMs: 150, ...forkMeshOptions(() => n.mesh, () => n.dev, 500) });
  await fork.start();
  listenForkStatus(n.mesh, fork);
  holder.fork = fork;
  return Object.assign(n, { fork, reports });
}

describe('a demoted member over the mesh', () => {
  it('never publishes the changes made offline, and the others never see them', async () => {
    net = await Net.create();
    let allowed = true;
    const a = await addNode('alice', 'editor', () => allowed);
    const b = await addNode('bob', 'owner', () => true);
    await net.link(a, b);
    const id = await b.model.createTextNow('main.tex', BASE);
    await a.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await text(a, id)) === BASE, 3000);
    net.isolate(a);
    await waitFor(() => a.mesh.peers.length === 0 && b.mesh.peers.length === 0);
    (await a.model.openText(id)).insert(0, 'ALICE ');
    await a.model.createTextNow('secret.tex', 'private\n');
    allowed = false; // bob demoted alice while she worked alone
    await net.link(a, b);
    await waitFor(() => a.reports.length === 1, 5000);
    expect(a.reports[0]).toMatchObject({ discarded: true });
    await new Promise((r) => setTimeout(r, 200));
    await expect.poll(async () => await text(b, id), { timeout: 15_000 }).toBe(BASE);
    expect(b.model.find('secret.tex')).toBeUndefined();
    expect(await text(a, id)).toBe(BASE);
    expect(a.fork.active).toBe(false);
  });
});
