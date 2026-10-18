import { afterEach, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { ChangeLog } from '../src/changelog.js';
import { IndexedDbPersistence, MemoryPersistence, type Persistence } from '../src/persistence.js';
import { listRecovery, onRecoveryChange, preserveRecovery } from '../src/recovery.js';
import { Net, converged, waitFor } from '../src/testkit.js';

let net: Net | undefined;
afterEach(() => { net?.destroy(); net = undefined; });

/** Counts listings that read more than one key range. */
function counted(store: MemoryPersistence) {
  const calls = { full: 0, records: 0, docs: 0, prefixes: [] as string[] };
  const keys = store.listMetaKeys.bind(store), docs = store.listDocs.bind(store);
  store.listMetaKeys = async (prefix?: string) => {
    if (prefix === undefined) calls.full++; else calls.prefixes.push(prefix);
    if (prefix === 'operation:record:') calls.records++;
    return keys(prefix);
  };
  store.listDocs = async () => { calls.docs++; return docs(); };
  return calls;
}

it('applies co-author edits over 500,000 retained records without a full history listing per edit (5.4)', async () => {
  net = await Net.create();
  const store = new MemoryPersistence();
  // 500,000 retained, already projected operation records (keys and tiny values; contents are never read here).
  const retained = { v: 1, id: 'old', docId: 'f:old', at: 0, source: { kind: 'editor', name: 'old' }, state: 'applied' };
  for (let n = 0; n < 500_000; n++) {
    const id = `retained-${String(n).padStart(6, '0')}`;
    store.meta.set(`operation:record:${id}`, retained);
    store.meta.set(`operation:projected:${id}`, 'baseline');
  }
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor', { store });
  const id = await a.model.createTextNow('main.tex', 'base');
  const log = new ChangeLog({ model: b.model, store, idleMs: 50 }); log.start();
  await log.list(); // startup recovery: one key-range listing, no record contents
  await net.link(a, b); await converged([a, b], id);
  const calls = counted(store);
  let changes = 0;
  const off = onRecoveryChange(store, () => changes++);
  const text = await a.model.openText(id);
  const started = Date.now();
  for (let n = 0; n < 30; n++) {
    text.insert(text.length, ` ${n}`);
    await waitFor(async () => (await b.model.openText(id)).toString().endsWith(` ${n}`));
  }
  const perEdit = (Date.now() - started) / 30;
  await b.model.flush(); await log.flush();
  expect(calls.full).toBe(0);
  expect(calls.records).toBe(0);
  expect(calls.docs).toBe(0);
  expect(changes).toBe(0);
  expect(perEdit).toBeLessThan(500);
  // The Recovery list reads only its own range, however much operation history is retained.
  calls.prefixes.length = 0;
  await preserveRecovery(store, 'private.tex', new TextEncoder().encode('kept'), 'test');
  await preserveRecovery(store, 'private.tex', new TextEncoder().encode('kept'), 'test');
  expect((await listRecovery(store)).length).toBe(1);
  expect(changes).toBe(1);
  expect(calls.full).toBe(0);
  expect(calls.prefixes).toEqual(['recovery:record:']);
  off(); log.stop();
}, 120_000);

it('lists IndexedDB metadata by key range and documents from index keys only (5.4)', async () => {
  const store: Persistence = await IndexedDbPersistence.open('scale-range', new IDBFactory());
  await store.transact([
    { op: 'append', docId: 'f:a', updates: [new Uint8Array([1]), new Uint8Array([2])] },
    { op: 'append', docId: 'root', updates: [new Uint8Array([3])] },
    ...['recovery:record:1', 'recovery:record:2', 'recovery:recordx', 'recovery;', 'operation:record:1'].map((key) => ({ op: 'meta' as const, key, value: 1 })),
  ]);
  expect(await store.listMetaKeys!('recovery:record:')).toEqual(['recovery:record:1', 'recovery:record:2']);
  expect((await store.listMetaKeys!()).length).toBe(5);
  expect((await store.listDocs()).sort()).toEqual(['f:a', 'root']);
  store.close();
});
