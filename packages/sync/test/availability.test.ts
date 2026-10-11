import { fileDocId } from '@hivetex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ProjectModel } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';
import { waitFor } from './helpers.js';
import { Net } from './net.js';

const FAST = { flushMs: 1 };
let net: Net;
afterEach(() => net?.destroy());

async function open(store = new MemoryPersistence()) {
  const m = new ProjectModel(store, FAST);
  await m.init();
  return { m, store };
}

describe('local completeness is separate from loaded or stored documents (5.1)', () => {
  it('classifies unknown, partial, locally created empty and reopened complete documents', async () => {
    const { m, store } = await open();
    // never seen: unknown, even though a file-table entry may name it
    expect(m.availability('f:nothing')).toBe('unknown');
    m.root.transact(() => {
      const e = new Y.Map<unknown>();
      e.set('path', 'listed.tex');
      e.set('kind', 'text');
      m.files.set('listed', e);
    }, 'remote');
    expect(m.availability(fileDocId('listed'))).toBe('unknown');
    // allocating the document (opening it) does not make it complete
    await m.openText('listed');
    expect(m.availability(fileDocId('listed'))).toBe('unknown');
    // some content without a confirmation is partial
    const src = new Y.Doc();
    src.getText('t').insert(0, 'abc');
    Y.applyUpdate(await m.getDoc(fileDocId('listed')), Y.encodeStateAsUpdate(src), 'remote');
    expect(m.availability(fileDocId('listed'))).toBe('partial');
    // created here, empty: complete without waiting for any update
    const empty = m.createText('empty.tex');
    expect(m.availability(fileDocId(empty))).toBe('complete');
    expect((await m.openText(empty)).toString()).toBe('');
    await m.flush();

    const again = await open(store);
    expect(again.m.availability(fileDocId(empty))).toBe('complete');
    expect(again.m.availability(fileDocId('listed'))).toBe('partial');
    expect(again.m.missingText().map((f) => f.path)).toEqual(['listed.tex']);
  });

  it('keeps stores written before availability was tracked usable (their stored documents count as complete)', async () => {
    const store = new MemoryPersistence();
    const old = new Y.Doc();
    old.getText('t').insert(0, 'legacy');
    await store.append('f:old', [Y.encodeStateAsUpdate(old)]);
    const { m } = await open(store);
    expect(m.availability('f:old')).toBe('complete');
    expect(m.availability('f:other')).toBe('unknown');
  });
});

describe('safe identical-file consolidation (5.5, F04)', () => {
  it('keeps both entries while their bodies have not arrived (delayed differing bodies)', async () => {
    net = await Net.create();
    const [a, c] = [await net.add('alice', 'owner'), await net.add('carol', 'editor')];
    await a.model.createTextNow('main.tex', 'alice body');
    await a.model.createTextNow('main.tex', 'bob body');
    // only the file table travels to the joiner: both bodies stay unrequested (and read as empty)
    await net.link(a, c);
    await waitFor(() => c.model.list().length === 2);
    expect(await c.model.dedupeIdentical()).toBe(0);
    expect(c.model.list()).toHaveLength(2);
    // once the bodies arrive and differ, they still are kept
    await c.mesh.reconcileProject();
    expect(await c.model.dedupeIdentical()).toBe(0);
    expect(c.model.list()).toHaveLength(2);
  });

  it('retains both files when one changes while their equality is being checked', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    for (const n of [a, b]) await n.model.createTextNow('main.tex', 'same');
    await net.link(a, b);
    await waitFor(() => a.model.list().length === 2 && b.model.list().length === 2);
    await a.mesh.reconcileProject();
    const ids = a.model.list().map((f) => f.id);
    const slow = ids.sort()[1] as string;
    // make the second comparison body load slowly, and edit the first meanwhile
    await a.model.unload(fileDocId(slow));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = a.store.load.bind(a.store);
    a.store.load = async (docId: string) => {
      if (docId === fileDocId(slow)) await gate;
      return load(docId);
    };
    const running = a.model.dedupeIdentical();
    await new Promise((r) => setTimeout(r, 20));
    const first = ids.sort()[0] as string;
    (await a.model.openText(first)).insert(0, 'edited ');
    release();
    expect(await running).toBe(0);
    expect(a.model.list()).toHaveLength(2);
  });

  it('still consolidates genuinely identical complete files', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    for (const n of [a, b]) await n.model.createTextNow('main.tex', 'same');
    await net.link(a, b);
    await waitFor(() => a.model.list().length === 2 && b.model.list().length === 2);
    await Promise.all([a.mesh.reconcileProject(), b.mesh.reconcileProject()]);
    expect(await a.model.dedupeIdentical()).toBe(1);
    expect(await b.model.dedupeIdentical()).toBeGreaterThanOrEqual(0);
    await waitFor(() => a.model.list().length === 1 && b.model.list().length === 1);
  });
});
