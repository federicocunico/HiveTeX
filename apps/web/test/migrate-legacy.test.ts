import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { migrateLegacyStorage } from '../src/lib/migrate-legacy.js';

class MemStorage {
  m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const done = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function seed(idb: IDBFactory, name: string, version: number, build: (db: IDBDatabase) => void, fill: (tx: IDBTransaction) => void) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = idb.open(name, version);
    r.onupgradeneeded = () => build(r.result);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const tx = db.transaction([...db.objectStoreNames], 'readwrite');
  fill(tx);
  await new Promise((r) => (tx.oncomplete = r));
  db.close();
}

async function names(idb: IDBFactory) {
  return (await idb.databases()).map((d) => d.name).sort();
}

describe('migration from the previous product name', () => {
  it('moves settings, device keys, project copies and locations once', async () => {
    const idb = new IDBFactory();
    const local = new MemStorage();
    const session = new MemStorage();
    local.setItem('p2platex.compileForOthers', '0');
    local.setItem('p2platex.serverUrl', 'https://old.example');
    local.setItem('hivetex.serverUrl', 'https://new.example'); // a new value wins
    session.setItem('p2platex.trusted', '[]');

    await seed(idb, 'p2platex-device', 1, (db) => db.createObjectStore('keys'), (tx) => tx.objectStore('keys').put({ deviceId: 'dev-1' }, 'user-1'));
    await seed(
      idb,
      'p2platex-project-abc',
      2,
      (db) => db.createObjectStore('changes', { keyPath: 'id' }).createIndex('byTime', 'endedAt'),
      (tx) => tx.objectStore('changes').put({ id: 'c1', endedAt: 5 }),
    );
    await seed(idb, 'p2platex-locations', 1, (db) => db.createObjectStore('locations'), (tx) => tx.objectStore('locations').put({ kind: 'app' }, 'abc'));

    expect(await migrateLegacyStorage({ local, session, idb })).toBe(true);

    expect(local.getItem('hivetex.compileForOthers')).toBe('0');
    expect(local.getItem('hivetex.serverUrl')).toBe('https://new.example');
    expect([...local.m.keys()].some((k) => k.startsWith('p2platex.'))).toBe(false);
    expect(session.getItem('hivetex.trusted')).toBe('[]');
    expect(await names(idb)).toEqual(['hivetex-device', 'hivetex-locations', 'hivetex-project-abc']);

    const db = await done(idb.open('hivetex-project-abc'));
    expect(db.version).toBe(2);
    const store = db.transaction('changes').objectStore('changes');
    expect(store.keyPath).toBe('id');
    expect(await done(store.index('byTime').getAll())).toEqual([{ id: 'c1', endedAt: 5 }]);
    db.close();
    const dev = await done(idb.open('hivetex-device'));
    expect(await done(dev.transaction('keys').objectStore('keys').get('user-1'))).toEqual({ deviceId: 'dev-1' });
    dev.close();

    // second start: nothing to do
    local.setItem('p2platex.late', 'x');
    expect(await migrateLegacyStorage({ local, session, idb })).toBe(false);
    expect(local.getItem('p2platex.late')).toBe('x');
  });

  it('keeps data created under the new name and drops the stale old copy', async () => {
    const idb = new IDBFactory();
    const local = new MemStorage();
    await seed(idb, 'p2platex-device', 1, (db) => db.createObjectStore('keys'), (tx) => tx.objectStore('keys').put('old', 'u'));
    await seed(idb, 'hivetex-device', 1, (db) => db.createObjectStore('keys'), (tx) => tx.objectStore('keys').put('new', 'u'));
    await migrateLegacyStorage({ local, idb });
    expect(await names(idb)).toEqual(['hivetex-device']);
    const db = await done(idb.open('hivetex-device'));
    expect(await done(db.transaction('keys').objectStore('keys').get('u'))).toBe('new');
    db.close();
  });

  it('keeps the old data and retries later when copying fails', async () => {
    const idb = new IDBFactory();
    const local = new MemStorage();
    await seed(idb, 'p2platex-device', 1, (db) => db.createObjectStore('keys'), (tx) => tx.objectStore('keys').put('k', 'u'));
    const failing = Object.create(idb) as IDBFactory;
    failing.open = (name: string, version?: number) => {
      if (name === 'hivetex-device' && version !== undefined) throw new Error('quota exceeded');
      return idb.open(name, version);
    };
    failing.deleteDatabase = (n: string) => idb.deleteDatabase(n);
    failing.databases = () => idb.databases();
    await expect(migrateLegacyStorage({ local, idb: failing })).rejects.toThrow(/quota/);
    expect(local.getItem('hivetex.migrated')).toBeNull();
    expect(await names(idb)).toContain('p2platex-device');
    // next start, storage works again
    expect(await migrateLegacyStorage({ local, idb })).toBe(true);
    expect(await names(idb)).toEqual(['hivetex-device']);
  });

  it('does nothing harmful on a fresh device', async () => {
    const idb = new IDBFactory();
    const local = new MemStorage();
    expect(await migrateLegacyStorage({ local, idb })).toBe(true);
    expect(await names(idb)).toEqual([]);
    expect(local.getItem('hivetex.migrated')).toBe('1');
  });
});
