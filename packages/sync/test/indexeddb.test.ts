import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbPersistence } from '../src/persistence.js';
import { ProjectModel } from '../src/model.js';

describe('IndexedDB persistence (6.4)', () => {
  it('survives reopening the database, including blobs and snapshots', async () => {
    const factory = new IDBFactory();
    const s1 = await IndexedDbPersistence.open('proj', factory);
    const m1 = new ProjectModel(s1, { flushMs: 1 });
    await m1.init();
    const id = await m1.createTextNow('main.tex', 'hello idb');
    await s1.putBlob('abc', new Uint8Array([1, 2, 3]));
    const snap = await m1.captureSnapshot();
    await m1.flush();
    s1.close();

    const s2 = await IndexedDbPersistence.open('proj', factory);
    const m2 = new ProjectModel(s2, { flushMs: 1 });
    await m2.init();
    expect(m2.list().map((f) => f.path)).toEqual(['main.tex']);
    expect((await m2.openText(id)).toString()).toBe('hello idb');
    expect(Array.from((await s2.getBlob('abc')) ?? [])).toEqual([1, 2, 3]);
    expect((await s2.listSnapshots()).map((s) => s.id)).toEqual([snap.id]);
    expect(await s2.listDocs()).toContain(`f:${id}`);
  });

  it('compaction replaces the stored updates with one state', async () => {
    const factory = new IDBFactory();
    const s = await IndexedDbPersistence.open('proj2', factory);
    await s.append('d', [new Uint8Array([1]), new Uint8Array([2])]);
    expect(await s.load('d')).toHaveLength(2);
    await s.compact('d', new Uint8Array([9]));
    expect((await s.load('d')).map((u) => Array.from(u))).toEqual([[9]]);
  });
});

describe('change-set storage', () => {
  const set = (id: string, endedAt: number) => ({ id, source: { kind: 'folder' as const, name: 'Folder' }, startedAt: endedAt, endedAt, files: [] });

  it('stores change sets newest first and prunes to max(7 days, 500)', async () => {
    const s = await IndexedDbPersistence.open('changes-1', new IDBFactory());
    const now = Date.UTC(2026, 9, 10);
    const DAY = 24 * 3600 * 1000;
    for (let i = 0; i < 600; i++) await s.putChangeSet(set(`old${i}`, now - 30 * DAY + i)); // all older than 7 days
    for (let i = 0; i < 10; i++) await s.putChangeSet(set(`new${i}`, now - i * 1000)); // recent
    expect((await s.listChangeSets())[0]?.id).toBe('new0');
    const removed = await s.pruneChangeSets(now);
    const left = await s.listChangeSets();
    expect(left).toHaveLength(500);
    expect(removed).toBe(110);
    expect(left.slice(0, 10).map((c) => c.id)).toEqual(Array.from({ length: 10 }, (_, i) => `new${i}`));

    // everything within 7 days is kept even beyond 500
    for (let i = 0; i < 700; i++) await s.putChangeSet(set(`week${i}`, now - DAY + i));
    await s.pruneChangeSets(now);
    expect((await s.listChangeSets()).filter((c) => c.id.startsWith('week'))).toHaveLength(700);
    s.close();
  });

  it('upgrades an existing version-1 project database without losing data', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const r = factory.open('legacy', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('updates', { autoIncrement: true }).createIndex('doc', 'docId');
        db.createObjectStore('blobs');
        db.createObjectStore('snapshots', { keyPath: 'id' });
        db.createObjectStore('meta').put('kept', 'k');
      };
      r.onsuccess = () => {
        r.result.close();
        resolve();
      };
      r.onerror = () => reject(r.error);
    });
    const s = await IndexedDbPersistence.open('legacy', factory);
    expect(await s.getMeta('k')).toBe('kept');
    await s.putChangeSet(set('c1', 1));
    expect((await s.listChangeSets()).map((c) => c.id)).toEqual(['c1']);
    s.close();
  });
});
