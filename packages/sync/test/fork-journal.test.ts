import { ROOT_DOC_ID } from '@hivetex/protocol';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { FORK_JOURNAL_KEY, FORK_RECORD_KEY, type ForkJournal, MERGE_ORIGIN, type MergeReport, OfflineFork } from '../src/fork.js';
import { ProjectModel } from '../src/model.js';
import type { Persistence } from '../src/persistence.js';
import { MemoryPersistence } from '../src/persistence.js';
import { FaultyPersistence } from './faulty-store.js';
import { waitFor } from './helpers.js';

const OPTS = { flushMs: 1, retryMs: 5, maxRetryMs: 20 };
const never = () => new Promise<void>(() => {});

async function open(store: Persistence, waitSynced: (docId: string) => Promise<void> = async () => {}) {
  const model = new ProjectModel(store, OPTS);
  await model.init();
  const reports: MergeReport[] = [];
  const errors: unknown[] = [];
  const fork = new OfflineFork({ model, isLinked: () => false, canEdit: () => true, confirm: async (d) => (await waitSynced(d), 'confirmed' as const), onReport: (r) => reports.push(r), onError: (e) => errors.push(e) });
  await fork.start();
  return { model, fork, reports, errors };
}

/** A project of one file, synced as far as this device knows, then edited while no peer is linked. */
async function offlineEdit(store: Persistence, waitSynced: (docId: string) => Promise<void> = never, content = 'base\n') {
  const seed = new ProjectModel(store, OPTS);
  await seed.init();
  const id = await seed.createTextNow('main.tex', content);
  await seed.flush();
  await seed.destroy();
  const s = await open(store, waitSynced);
  const t = await s.model.openText(id);
  t.insert(0, 'OFFLINE ');
  await s.model.flush();
  return { ...s, id };
}

const textOf = async (model: ProjectModel, id: string) => (await model.openText(id)).toString();
const docText = async (store: Persistence, id: string) => {
  const d = new Y.Doc();
  for (const u of await store.load(`f:${id}`)) Y.applyUpdate(d, u);
  return d.getText('t').toString();
};
const snapshot = (store: MemoryPersistence) => new Map([...store.meta].map(([k, v]) => [k, v]));

describe('recovery journal (version 2)', () => {
  it('records the operation id and advances through explicit stages, then removes everything it wrote', async () => {
    const store = new MemoryPersistence();
    const { fork, model, id } = await offlineEdit(store, async () => {});
    const forked = store.meta.get(FORK_JOURNAL_KEY) as ForkJournal;
    expect(forked).toMatchObject({ v: 2, stage: 'forked' });
    expect(forked.opId).toMatch(/^m/);
    expect(forked.docs).toEqual([ROOT_DOC_ID, `f:${id}`]);
    // the version-1 record is still written beside it
    expect(store.meta.get(FORK_RECORD_KEY)).toMatchObject({ v: 1, stage: 'forked', docs: forked.docs });

    fork.beforeSync().catch(() => {});
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY), 3000);
    expect(store.meta.has(FORK_RECORD_KEY)).toBe(false);
    expect([...store.meta.keys()].filter((k) => k.startsWith('fork:base:') || k.startsWith('fork:mine:'))).toEqual([]);
    expect(await textOf(model, id)).toBe('OFFLINE base\n');
  });

  it('prepared stage: mine, the journal and the replaced documents are stored together', async () => {
    const store = new MemoryPersistence();
    const { fork, id } = await offlineEdit(store);
    const opId = (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).opId;
    fork.beforeSync().catch(() => {}); // waits for a peer that never answers
    await waitFor(() => (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).stage === 'prepared');
    expect((store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).opId).toBe(opId);
    expect(await docText(store, id)).toBe('base\n'); // the shared base is what is stored and shared
    const mine = store.meta.get(`fork:mine:f:${id}`) as Uint8Array;
    const d = new Y.Doc();
    Y.applyUpdate(d, mine);
    expect(d.getText('t').toString()).toBe('OFFLINE base\n'); // the offline version is kept
  });

  it('a crash while the replacement fails leaves the offline version stored, then completes it atomically', async () => {
    const store = new FaultyPersistence();
    const { fork, id, errors } = await offlineEdit(store);
    store.failTransact = 1;
    await expect(fork.beforeSync()).rejects.toThrow('transact failed');
    // nothing of the transition is stored: still the offline text, journal still 'forked', no mine copy yet
    expect(await docText(store, id)).toBe('OFFLINE base\n');
    expect((store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).stage).toBe('forked');
    expect(store.meta.has(`fork:mine:f:${id}`)).toBe(false);
    // storage recovers: the retry stores the whole transition at once
    await waitFor(() => (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).stage === 'prepared');
    expect(await docText(store, id)).toBe('base\n');
    expect(store.meta.has(`fork:mine:f:${id}`)).toBe(true);
    expect(errors).toEqual([]);
  });

  it('restarting in the prepared stage resumes the merge and keeps the offline text exactly once', async () => {
    const store = new MemoryPersistence();
    const { fork, id } = await offlineEdit(store);
    fork.beforeSync().catch(() => {});
    await waitFor(() => (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).stage === 'prepared');
    // "crash": the app restarts with the journal as it was when the documents were replaced
    const again = await open(store);
    expect(again.fork.journal?.stage).toBe('prepared');
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(again.model, id)).toBe('OFFLINE base\n');
    expect(again.reports.at(-1)).toMatchObject({ taken: ['main.tex'], conflicts: 0 });
  });

  it('restarting in the committed stage only finishes the cleanup', async () => {
    const store = new MemoryPersistence();
    const { fork, id } = await offlineEdit(store);
    fork.beforeSync().catch(() => {});
    await waitFor(() => (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).stage === 'prepared');
    (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).stage = 'committed';
    const again = await open(store);
    expect(again.fork.active).toBe(false);
    expect(store.meta.has(FORK_JOURNAL_KEY)).toBe(false);
    expect(store.meta.has(FORK_RECORD_KEY)).toBe(false);
    expect(store.meta.has(`fork:mine:f:${id}`)).toBe(false);
    expect(again.reports).toEqual([]); // no second merge: nothing is applied twice
  });
});

describe('migration of version-1 recovery records', () => {
  /** Rewrites what a fork stores into what a version-1 build stored: no journal, just the old record. */
  function downgrade(store: MemoryPersistence, stage: 'forked' | 'merging') {
    const j = store.meta.get(FORK_JOURNAL_KEY) as ForkJournal;
    store.meta.delete(FORK_JOURNAL_KEY);
    store.meta.set(FORK_RECORD_KEY, { v: 1, stage, docs: j.docs });
  }

  it('a v1 forked record is migrated additively and still merges', async () => {
    const store = new MemoryPersistence();
    const { id } = await offlineEdit(store);
    downgrade(store, 'forked');
    const before = snapshot(store);
    const again = await open(store);
    expect(again.fork.active).toBe(true);
    expect(again.fork.journal).toMatchObject({ v: 2, stage: 'forked' });
    expect(store.meta.get(FORK_JOURNAL_KEY)).toMatchObject({ v: 2, stage: 'forked', opId: again.fork.journal?.opId });
    // every record that was there is still there, unchanged
    for (const [k, v] of before) expect(store.meta.get(k)).toEqual(v);
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(again.model, id)).toBe('OFFLINE base\n');
  });

  it('a v1 merging record resumes as prepared and keeps its mine copy', async () => {
    const store = new MemoryPersistence();
    const { fork, id } = await offlineEdit(store);
    fork.beforeSync().catch(() => {});
    await waitFor(() => (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).stage === 'prepared');
    downgrade(store, 'merging');
    const again = await open(store);
    expect(again.fork.journal?.stage).toBe('prepared');
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(again.model, id)).toBe('OFFLINE base\n');
  });

  it('a v1 conflict list is read unchanged', async () => {
    const store = new MemoryPersistence();
    const conflict = { id: 'c1', kind: 'text', fileId: 'x', path: 'a.tex', theirsAtMerge: 'T', regions: [] };
    store.meta.set('fork:conflicts', [conflict]);
    const { fork } = await open(store);
    expect(fork.conflicts).toEqual([conflict]);
  });

  it('a failed migration leaves the old recovery records intact and does not lose the fork', async () => {
    const store = new FaultyPersistence();
    const { id } = await offlineEdit(store);
    downgrade(store, 'forked');
    const before = snapshot(store);
    store.failTransact = 1;
    const again = await open(store);
    expect(again.errors).toHaveLength(1);
    expect(snapshot(store)).toEqual(before);
    expect(store.meta.has(FORK_JOURNAL_KEY)).toBe(false);
    expect(again.fork.active).toBe(true);
    // the next transition writes the journal after all
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_RECORD_KEY));
    expect(await textOf(again.model, id)).toBe('OFFLINE base\n');
  });

  it('a journal of an unknown version is never modified or deleted, and no new merge starts over it', async () => {
    const store = new MemoryPersistence();
    const future = { v: 3, opId: 'z', stage: 'sharded', docs: ['f:x'], extra: { keep: true } };
    store.meta.set(FORK_JOURNAL_KEY, future);
    store.meta.set(FORK_RECORD_KEY, { v: 1, stage: 'merging', docs: ['f:x'] });
    store.meta.set('fork:mine:f:x', new Uint8Array([1]));
    const before = snapshot(store);
    const { fork, model } = await open(store);
    expect(fork.recoveryBlocked).toBe(true);
    expect(fork.active).toBe(false);
    const id = await model.createTextNow('b.tex', 'x'); // an edit that would normally start a fork
    (await model.openText(id)).insert(0, 'y');
    await fork.beforeSync();
    await model.flush();
    expect(store.meta.get(FORK_JOURNAL_KEY)).toBe(future);
    for (const [k, v] of before) expect(store.meta.get(k)).toEqual(v);
  });

  it('an unrecognised legacy record is kept as well', async () => {
    const store = new MemoryPersistence();
    store.meta.set(FORK_RECORD_KEY, { v: 9, stage: 'whatever', docs: [] });
    const { fork } = await open(store);
    expect(fork.recoveryBlocked).toBe(true);
    expect(store.meta.get(FORK_RECORD_KEY)).toEqual({ v: 9, stage: 'whatever', docs: [] });
    expect(MERGE_ORIGIN).toBeDefined();
  });
});

describe('restart from every journal transition (F02)', () => {
  /** What the others wrote meanwhile: lands in the swapped-in document as a remote edit would. */
  const theirs = async (model: ProjectModel, id: string, at: number, s: string) => {
    (await model.openText(id)).insert(at, s);
  };

  it('forked: the offline text survives a restart before anything was prepared, and is merged once', async () => {
    const store = new MemoryPersistence();
    const { model, id } = await offlineEdit(store);
    await model.destroy();
    expect(await docText(store, id)).toBe('OFFLINE base\n');
    const again = await open(store);
    expect(again.fork.journal).toMatchObject({ v: 2, stage: 'forked' });
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(again.model, id)).toBe('OFFLINE base\n');
    expect(again.reports).toHaveLength(1);
  });

  it('reconciling, results already applied: a restart merges again without duplicating the offline text', async () => {
    const store = new FaultyPersistence();
    const sync = async (d: string) => {
      if (d.startsWith('f:')) store.failTransact = 1; // the commit transition fails: the crash happens after the merged result was applied
    };
    const { fork, id, model, errors } = await offlineEdit(store, sync);
    await fork.beforeSync();
    await waitFor(() => errors.length > 0);
    await model.flush();
    expect((store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).stage).toBe('reconciling');
    expect(await docText(store, id)).toBe('OFFLINE base\n'); // the merged result is stored, the recovery data still is too
    const again = await open(store);
    expect(again.fork.journal?.stage).toBe('reconciling');
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(again.model, id)).toBe('OFFLINE base\n'); // exactly once
    expect(again.errors).toEqual([]);
  });

  it('reconciling, with their edit in other lines: the restart keeps both edits exactly once', async () => {
    const store = new FaultyPersistence();
    let model!: ProjectModel;
    let id = '';
    const sync = async (d: string) => {
      if (!d.startsWith('f:')) return;
      await theirs(model, id, 'base\nmid\nend\n'.length, 'THEIRS\n');
      store.failTransact = 1;
    };
    const s = await offlineEdit(store, sync, 'base\nmid\nend\n');
    model = s.model;
    id = s.id;
    await s.fork.beforeSync();
    await waitFor(() => s.errors.length > 0);
    await s.model.flush();
    const again = await open(store);
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(again.model, id)).toBe('OFFLINE base\nmid\nend\nTHEIRS\n');
  });

  it('a failed commit does not turn one conflict into two when the merge is attempted again', async () => {
    const store = new FaultyPersistence();
    let model!: ProjectModel;
    let id = '';
    let first = true;
    const sync = async (d: string) => {
      if (!d.startsWith('f:') || !first) return;
      first = false;
      await theirs(model, id, 0, 'THEIRS ');
      store.failTransact = 1;
    };
    const s = await offlineEdit(store, sync);
    model = s.model;
    id = s.id;
    await s.fork.beforeSync();
    await waitFor(() => s.errors.length > 0);
    await s.fork.beforeSync(); // the next link retries from the journal
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(s.fork.conflicts).toHaveLength(1);
    expect((store.meta.get('fork:conflicts') as unknown[]).length).toBe(1);
  });

  it('a restart after a failed commit finds the conflict once, not twice', async () => {
    const store = new FaultyPersistence();
    let model!: ProjectModel;
    let id = '';
    const sync = async (d: string) => {
      if (!d.startsWith('f:')) return;
      await theirs(model, id, 0, 'THEIRS ');
      store.failTransact = 1;
    };
    const s = await offlineEdit(store, sync);
    model = s.model;
    id = s.id;
    await s.fork.beforeSync();
    await waitFor(() => s.errors.length > 0);
    expect(store.meta.has('fork:conflicts')).toBe(false); // not durable before the commit transition
    const again = await open(store, async () => {});
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(again.fork.conflicts).toHaveLength(1);
    expect(await textOf(again.model, id)).toContain('THEIRS');
  });

  it('committed with conflicts: a restart keeps them and only finishes the cleanup', async () => {
    const store = new MemoryPersistence();
    let model!: ProjectModel;
    let id = '';
    const sync = async (d: string) => {
      if (d.startsWith('f:')) await theirs(model, id, 0, 'THEIRS ');
    };
    const s = await offlineEdit(store, sync);
    model = s.model;
    id = s.id;
    await s.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    // as if the crash came right after the commit transition: journal committed, recovery copies still present
    store.meta.set(FORK_JOURNAL_KEY, { v: 2, opId: 'op', stage: 'committed', docs: [ROOT_DOC_ID, `f:${id}`] });
    store.meta.set(`fork:mine:f:${id}`, new Uint8Array([0]));
    const again = await open(store);
    expect(again.fork.active).toBe(false);
    expect(again.fork.conflicts).toHaveLength(1);
    expect(store.meta.has(`fork:mine:f:${id}`)).toBe(false);
    expect(again.reports).toEqual([]);
  });
});

describe('documented recovery paths (docs/offline.md, Recovery journal)', () => {
  it('a journal and a version-1 record side by side: the journal decides and the record is left as written', async () => {
    const store = new MemoryPersistence();
    const { fork, id } = await offlineEdit(store);
    fork.beforeSync().catch(() => {});
    await waitFor(() => (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).stage === 'prepared');
    const legacyBefore = structuredClone(store.meta.get(FORK_RECORD_KEY));
    const again = await open(store);
    expect(again.fork.journal?.stage).toBe('prepared');
    expect(store.meta.get(FORK_RECORD_KEY)).toEqual(legacyBefore);
    await again.fork.beforeSync();
    await waitFor(() => !store.meta.has(FORK_JOURNAL_KEY));
    expect(await textOf(again.model, id)).toBe('OFFLINE base\n');
  });

  it('the version-1 mirror reads as forked before preparation and as merging from then on, so a downgrade still finds the work', async () => {
    const store = new MemoryPersistence();
    const { fork } = await offlineEdit(store);
    expect(store.meta.get(FORK_RECORD_KEY)).toMatchObject({ v: 1, stage: 'forked' });
    fork.beforeSync().catch(() => {});
    await waitFor(() => (store.meta.get(FORK_JOURNAL_KEY) as ForkJournal).stage === 'prepared');
    expect(store.meta.get(FORK_RECORD_KEY)).toMatchObject({ v: 1, stage: 'merging' });
  });

  for (const [name, journal] of [
    ['an unknown stage', { v: 2, opId: 'x', stage: 'sharded', docs: [] }],
    ['a malformed document list', { v: 2, opId: 'x', stage: 'prepared', docs: 'f:a' }],
    ['no operation id', { v: 2, stage: 'prepared', docs: [] }],
    ['a newer version', { v: 4, opId: 'x', stage: 'prepared', docs: [], more: 1 }],
  ] as const) {
    it(`a journal with ${name} is kept byte for byte and blocks a new merge`, async () => {
      const store = new MemoryPersistence();
      store.meta.set(FORK_JOURNAL_KEY, journal);
      store.meta.set('fork:mine:f:a', new Uint8Array([7]));
      const before = structuredClone([...store.meta]);
      const { fork, model } = await open(store);
      expect(fork.recoveryBlocked).toBe(true);
      const id = await model.createTextNow('n.tex', 'x');
      (await model.openText(id)).insert(0, 'y');
      await fork.beforeSync();
      await model.flush();
      expect(store.meta.get(FORK_JOURNAL_KEY)).toEqual(journal);
      for (const [k, v] of before) expect(store.meta.get(k)).toEqual(v);
      expect(store.meta.has(FORK_RECORD_KEY)).toBe(false); // nothing was written over it
    });
  }
});
