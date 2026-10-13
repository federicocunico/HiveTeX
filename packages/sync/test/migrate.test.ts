import 'fake-indexeddb/auto';
import { ROOT_DOC_ID } from '@hivetex/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ChangeLog } from '../src/changelog.js';
import { copyStore, storeDigest } from '../src/migrate.js';
import { ProjectModel, sha256Hex } from '../src/model.js';
import { NativePersistence } from '../src/native-persistence.js';
import { IndexedDbPersistence } from '../src/persistence.js';
import { fakeNative } from './native-fake.js';

/**
 * 5.3: a desktop 0.5.0 IndexedDB store, written by the current model the way the app writes it (texts with edit
 * history, a binary, completeness markers, history snapshot, change log, an offline-merge journal holding raw updates),
 * is copied into the native store and compares equal after reopening the target.
 */
async function legacyFixture(factory: IDBFactory) {
  const store = await IndexedDbPersistence.open('hivetex-project-legacy', factory);
  const model = new ProjectModel(store, { flushMs: 1 });
  await model.init();
  model.markComplete(ROOT_DOC_ID);
  const changelog = new ChangeLog({ model, store });
  changelog.start();
  const main = await model.createTextNow('main.tex', '\\documentclass{article}');
  const intro = await model.createTextNow('sections/intro.tex', 'Intro');
  for (let i = 0; i < 40; i++) {
    (await model.openText(intro)).insert(0, `${i} `);
    if (i % 10 === 0) await model.flush(); // several stored updates for one document
  }
  const png = new Uint8Array(5000).map((_, i) => i % 251);
  const hash = await sha256Hex(png);
  await store.putBlob(hash, png);
  model.createBinary('figures/plot.png', hash, png.length);
  await model.captureSnapshot();
  // An unresolved offline merge: the fork keeps raw Yjs updates and a checkpoint in metadata.
  const pending = new Y.Doc();
  pending.getText('t').insert(0, 'offline edit');
  await store.setMeta('fork:journal', { base: Y.encodeStateVector(pending), updates: [Y.encodeStateAsUpdate(pending)], stage: 'conflict' });
  await model.flush();
  await changelog.flush();
  changelog.stop();
  return { store, model, main, intro, hash };
}

describe('desktop store migration (5.3)', () => {
  it('copies a 0.5.0 IndexedDB project into the native store and compares equal after reopening', async () => {
    const factory = new IDBFactory();
    const legacy = await legacyFixture(factory);
    const before = await storeDigest(legacy.store);
    expect(before.counts.docs).toBeGreaterThanOrEqual(3);
    expect(before.counts.updates).toBeGreaterThanOrEqual(before.counts.docs);
    expect(before.counts.blobs).toBe(1);
    expect(before.counts.snapshots).toBe(1);
    expect(before.counts.changes).toBeGreaterThan(0);
    expect(before.counts.meta).toBeGreaterThan(0);

    const f = fakeNative();
    const scope = 'd'.repeat(64);
    const target = await NativePersistence.open(f.invoke, scope);
    const counts = await copyStore(legacy.store, target, { batchBytes: 512 }); // tiny batches: several per document
    expect(counts).toEqual(before.counts);
    target.close();

    const reopened = await NativePersistence.open(f.invoke, scope);
    const after = await storeDigest(reopened);
    expect(after.parts).toEqual(before.parts);
    expect(after.sha256).toBe(before.sha256);

    // The migrated replica opens with the same files, texts, binary and completeness, and the journal's raw bytes.
    const model = new ProjectModel(reopened, { flushMs: 1 });
    await model.init();
    expect(model.list().map((e) => e.path).sort()).toEqual(['figures', 'figures/plot.png', 'main.tex', 'sections', 'sections/intro.tex'].filter((p) => legacy.model.list().some((e) => e.path === p)).sort());
    expect((await model.openText(legacy.intro)).toString()).toBe((await legacy.model.openText(legacy.intro)).toString());
    expect(model.availability(ROOT_DOC_ID)).toBe('complete');
    expect(await reopened.getBlob(legacy.hash)).toBeDefined();
    const journal = (await reopened.getMeta('fork:journal')) as { updates: Uint8Array[]; stage: string };
    expect(journal.stage).toBe('conflict');
    expect(journal.updates[0]).toBeInstanceOf(Uint8Array);
  });

  it('a resumed copy skips finished items and replaces a partially copied document instead of duplicating it', async () => {
    const legacy = await legacyFixture(new IDBFactory());
    const f = fakeNative();
    const target = await NativePersistence.open(f.invoke, 'e'.repeat(64));
    const docs = (await legacy.store.listDocs()).sort();
    // First run "crashes" after the first document; the second document was half written.
    await copyStore(legacy.store, target, { done: { docs: new Set(docs.slice(1)), blobs: new Set(await legacy.store.listBlobs()) } });
    const half = await legacy.store.load(docs[1] as string);
    await target.append(docs[1] as string, half.slice(0, 3));
    await copyStore(legacy.store, target, { done: { docs: new Set(docs.slice(0, 1)) } });
    expect((await storeDigest(target)).sha256).toBe((await storeDigest(legacy.store)).sha256);
  });
});
