import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { IndexedDbPersistence } from '../src/persistence.js';

const openRaw = (factory: IDBFactory, name: string, version: number, upgrade?: (db: IDBDatabase) => void) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(name, version);
    r.onupgradeneeded = () => upgrade?.(r.result);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

it('reports an upgrade blocked by an older open tab, then proceeds once it closes (5.6)', async () => {
  const factory = new IDBFactory();
  // A 0.8.0 tab: version 2, no versionchange handler, so it keeps the upgrade waiting.
  const old = await openRaw(factory, 'p', 2, (db) => {
    db.createObjectStore('updates', { autoIncrement: true }).createIndex('doc', 'docId');
    for (const name of ['blobs', 'meta']) db.createObjectStore(name);
    db.createObjectStore('snapshots', { keyPath: 'id' }); db.createObjectStore('changes', { keyPath: 'id' });
  });
  let blocked = 0;
  const opening = IndexedDbPersistence.open('p', factory, { onBlocked: () => blocked++ });
  await new Promise((r) => setTimeout(r, 50));
  expect(blocked).toBe(1);
  old.close();
  const store = await opening;
  await store.setMeta('k', 1);
  expect(await store.getMeta('k')).toBe(1);
  store.close();
});

it('closes its connection when a newer version asks to upgrade, and later calls say why (5.6)', async () => {
  const factory = new IDBFactory();
  let superseded = 0;
  const one = await IndexedDbPersistence.open('q', factory, { onVersionChange: () => superseded++ });
  const two = await IndexedDbPersistence.open('q', factory, { onVersionChange: () => superseded++ });
  let blocked = false;
  const newer = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open('q', 4);
    r.onblocked = () => { blocked = true; };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  expect(blocked).toBe(false);
  expect(superseded).toBe(2);
  await expect(one.getMeta('k')).rejects.toThrow('upgraded by a newer HiveTeX');
  await expect(two.setMeta('k', 1)).rejects.toThrow('reload this tab');
  newer.close();
});
