import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ProjectModel } from '../src/model.js';
import { DocPersister, IndexedDbPersistence, MemoryPersistence, type Persistence } from '../src/persistence.js';
import { FaultyPersistence } from './faulty-store.js';
import { waitFor } from './helpers.js';

const FAST = { flushMs: 1, retryMs: 5, maxRetryMs: 20 };

function type(t: Y.Text, s: string) {
  t.insert(t.length, s);
}

async function reopen(store: Persistence, id: string) {
  const m = new ProjectModel(store, FAST);
  await m.init();
  return (await m.openText(id)).toString();
}

async function stored(store: Persistence, docId: string) {
  const back = new Y.Doc();
  for (const u of await store.load(docId)) Y.applyUpdate(back, u);
  return back.getText('t').toString();
}

describe('DocPersister retains failed writes (F01)', () => {
  it('keeps a failed batch, then saves it with later edits once storage recovers', async () => {
    const store = new FaultyPersistence();
    const doc = new Y.Doc();
    const p = new DocPersister(store, 'd', doc, { flushMs: 100_000, retryMs: 100_000 });
    type(doc.getText('t'), 'A');
    store.failAppend = 1;
    await expect(p.flush()).rejects.toThrow('append failed');
    // the failed flush is not an apparently successful one: nothing stored, edit retained and reported
    expect(store.docs.get('d')).toBeUndefined();
    expect(p.status).toMatchObject({ unsaved: true, failing: true });

    type(doc.getText('t'), 'B');
    await p.flush();
    expect(p.status).toMatchObject({ unsaved: false, failing: false });
    expect(await stored(store, 'd')).toBe('AB');
    expect(store.appendCalls).toBe(2);
  });

  it('retries by itself with backoff and does not duplicate text', async () => {
    const store = new FaultyPersistence();
    const doc = new Y.Doc();
    const p = new DocPersister(store, 'd', doc, FAST);
    type(doc.getText('t'), 'A');
    store.failAppend = 3;
    await waitFor(() => store.appendCalls === 4 && !p.status.failing);
    expect(await stored(store, 'd')).toBe('A');
    expect((await store.load('d')).length).toBe(1);
  });

  it('a failed compaction keeps the committed append and does not append it again', async () => {
    const store = new FaultyPersistence();
    const doc = new Y.Doc();
    const p = new DocPersister(store, 'd', doc, { flushMs: 100_000, retryMs: 100_000, compactAfter: 2 });
    type(doc.getText('t'), 'A');
    await p.flush();
    type(doc.getText('t'), 'B');
    store.failCompact = 1;
    await expect(p.flush()).rejects.toThrow('compact failed');
    expect(store.appendCalls).toBe(2);
    expect((await store.load('d')).length).toBe(2); // both batches committed
    expect(p.status.failing).toBe(false); // housekeeping only: no edit is at risk

    type(doc.getText('t'), 'C');
    await p.flush(); // compaction is retried, the new edit saved
    expect(store.appendCalls).toBe(3);
    expect(store.docs.get('d')).toHaveLength(1);
    expect(await stored(store, 'd')).toBe('ABC');
  });

  it('reopening a model restores edits made before and after the failure', async () => {
    const store = new FaultyPersistence();
    const m = new ProjectModel(store, FAST);
    await m.init();
    const id = await m.createTextNow('main.tex', '');
    await m.flush();
    const t = await m.openText(id);
    store.failAppend = 1;
    type(t, 'before ');
    await waitFor(() => m.saveState.failing);
    expect(m.saveState.docs).toContain(`f:${id}`);
    type(t, 'after');
    await waitFor(() => !m.saveState.failing);
    expect(await reopen(store, id)).toBe('before after');
  });

  it('saveState subscribers see the failure and its recovery', async () => {
    const store = new FaultyPersistence();
    const m = new ProjectModel(store, FAST);
    await m.init();
    const seen: boolean[] = [];
    m.onSaveState((s) => seen.push(s.failing));
    store.failAppend = 2;
    await m.createTextNow('a.tex', 'x');
    await waitFor(() => seen.length >= 2 && !m.saveState.failing);
    expect(seen[0]).toBe(true);
    expect(seen.at(-1)).toBe(false);
    expect(seen.slice(0, -1).every(Boolean)).toBe(true);
  });

  it('destroy rejects while edits are unsaved instead of dropping them silently', async () => {
    const store = new FaultyPersistence();
    const doc = new Y.Doc();
    const p = new DocPersister(store, 'd', doc, { flushMs: 100_000, retryMs: 100_000 });
    type(doc.getText('t'), 'A');
    store.failAppend = 1;
    await expect(p.destroy()).rejects.toThrow('append failed');
    expect(p.status.unsaved).toBe(true);
  });
});

describe('document replacement is serialized with writes (F02)', () => {
  it('a delayed append cannot land after the replacement', async () => {
    const store = new FaultyPersistence();
    const m = new ProjectModel(store, { flushMs: 100_000 });
    await m.init();
    const id = await m.createTextNow('main.tex', 'base');
    await m.flush();
    const docId = `f:${id}`;
    const base = Y.encodeStateAsUpdate(m.getLoadedDoc(docId) as Y.Doc);
    type(await m.openText(id), ' OFFLINE');
    const held = store.hold('append');
    const flushing = m.flush();
    await held.reached;
    const replaced = m.replaceDoc(docId, base);
    held.release();
    await flushing;
    await replaced;
    expect(await reopen(store, id)).toBe('base');
    expect(m.getLoadedDoc(docId)?.getText('t').toString()).toBe('base');
  });

  it('a delayed compaction cannot overwrite the replacement either', async () => {
    const store = new FaultyPersistence();
    const m = new ProjectModel(store, { flushMs: 100_000, compactAfter: 1 });
    await m.init();
    const id = await m.createTextNow('main.tex', 'base');
    await m.flush();
    const docId = `f:${id}`;
    const base = Y.encodeStateAsUpdate(m.getLoadedDoc(docId) as Y.Doc);
    type(await m.openText(id), ' OFFLINE');
    const held = store.hold('compact');
    const flushing = m.flush().catch(() => {});
    await held.reached;
    const replaced = m.replaceDoc(docId, base);
    held.release();
    await flushing;
    await replaced;
    expect(await reopen(store, id)).toBe('base');
  });

  it('edits typed after the swap are kept and saved after the replacement', async () => {
    const store = new FaultyPersistence();
    const m = new ProjectModel(store, FAST);
    await m.init();
    const id = await m.createTextNow('main.tex', 'base');
    await m.flush();
    const docId = `f:${id}`;
    const base = Y.encodeStateAsUpdate(m.getLoadedDoc(docId) as Y.Doc);
    type(await m.openText(id), ' OFFLINE');
    await m.flush();
    const held = store.hold('transact');
    const replaced = m.replaceDoc(docId, base);
    await held.reached;
    type(m.getLoadedDoc(docId)?.getText('t') as Y.Text, ' typed');
    held.release();
    await replaced;
    await m.flush();
    expect(await reopen(store, id)).toBe('base typed');
  });

  it('a failed replacement transition rejects, is retried, and applies metadata together with the documents', async () => {
    const store = new FaultyPersistence();
    const m = new ProjectModel(store, FAST);
    await m.init();
    const id = await m.createTextNow('main.tex', 'base');
    await m.flush();
    const docId = `f:${id}`;
    const base = Y.encodeStateAsUpdate(m.getLoadedDoc(docId) as Y.Doc);
    type(await m.openText(id), ' OFFLINE');
    await m.flush();
    store.failTransact = 1;
    await expect(m.replaceDoc(docId, base, [{ op: 'meta', key: 'k', value: 1 }])).rejects.toThrow('transact failed');
    // nothing of the transition was applied: the offline text is still what is stored, and no metadata
    expect(store.meta.get('k')).toBeUndefined();
    expect(await reopen(store, id)).toBe('base OFFLINE');
    expect(m.saveState.failing).toBe(true);
    type(m.getLoadedDoc(docId)?.getText('t') as Y.Text, '!');
    await waitFor(() => !m.saveState.failing && store.meta.get('k') === 1);
    await m.flush();
    expect(await reopen(store, id)).toBe('base!');
  });
});

describe('Persistence.transact is atomic', () => {
  it('IndexedDB: a failing step rolls back updates and metadata together', async () => {
    const s = await IndexedDbPersistence.open('atomic', new IDBFactory());
    await s.append('d', [new Uint8Array([1])]);
    await s.setMeta('k', 'old');
    // a function cannot be structured-cloned, so storing it throws part-way through the transition
    const bad = (() => {}) as unknown as Uint8Array;
    await expect(
      s.transact([
        { op: 'meta', key: 'k', value: 'new' },
        { op: 'compact', docId: 'd', state: new Uint8Array([9]) },
        { op: 'append', docId: 'e', updates: [bad] },
      ]),
    ).rejects.toBeTruthy();
    expect(await s.getMeta('k')).toBe('old');
    expect((await s.load('d')).map((u) => Array.from(u))).toEqual([[1]]);
    expect(await s.load('e')).toEqual([]);

    await s.transact([
      { op: 'meta', key: 'k', value: 'new' },
      { op: 'compact', docId: 'd', state: new Uint8Array([9]) },
    ]);
    expect(await s.getMeta('k')).toBe('new');
    expect((await s.load('d')).map((u) => Array.from(u))).toEqual([[9]]);
    await s.transact([{ op: 'meta', key: 'k', value: undefined }]);
    expect(await s.getMeta('k')).toBeUndefined();
  });

  it('memory store applies updates and metadata in one call', async () => {
    const s = new MemoryPersistence();
    await s.transact([
      { op: 'append', docId: 'd', updates: [new Uint8Array([1])] },
      { op: 'meta', key: 'k', value: 1 },
    ]);
    expect(await s.getMeta('k')).toBe(1);
    expect(await s.load('d')).toHaveLength(1);
  });
});
