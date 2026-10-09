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
