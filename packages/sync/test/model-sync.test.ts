import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MemoryPersistence } from '../src/persistence.js';
import { waitFor } from './helpers.js';
import { Net, converged, text } from './net.js';

let net: Net;
afterEach(() => net?.destroy());

describe('project model convergence (6.3)', () => {
  it('syncs the file table and file contents between peers', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const id = await a.model.createTextNow('main.tex', '\\documentclass{article}');
    await waitFor(() => b.model.list().length === 1);
    expect(b.model.list()[0]?.path).toBe('main.tex');
    await converged([a, b], id);
    expect(await text(b, id)).toBe('\\documentclass{article}');
  });

  it('concurrent rename + edit end with a single renamed file containing the edit', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const id = await a.model.createTextNow('intro.tex', 'Hello world');
    await converged([a, b], id);

    // go offline, act concurrently, reconnect
    net.isolate(a);
    await waitFor(() => a.mesh.peers.length === 0 && b.mesh.peers.length === 0);
    a.model.rename(id, 'introduction.tex');
    (await b.model.openText(id)).insert(5, ', brave');
    await net.link(a, b);
    await converged([a, b], id);
    await waitFor(() => [a, b].every((n) => n.model.list()[0]?.path === 'introduction.tex'));

    for (const n of [a, b]) {
      expect(n.model.list().map((f) => f.path)).toEqual(['introduction.tex']);
      expect(await text(n, id)).toBe('Hello, brave world');
    }
  });

  it('concurrent edits in the same sentence on 3 peers preserve every insertion and converge', async () => {
    net = await Net.create();
    const [a, b, c] = [await net.add('alice', 'owner'), await net.add('bob', 'editor'), await net.add('carol', 'editor')];
    await net.fullMesh();
    const id = await a.model.createTextNow('main.tex', 'The cat sat.');
    await converged([a, b, c], id);
    for (const n of [a, b, c]) net.isolate(n);
    await waitFor(() => [a, b, c].every((n) => n.mesh.peers.length === 0));

    (await a.model.openText(id)).insert(3, ' big');
    (await b.model.openText(id)).insert(11, ' down');
    (await c.model.openText(id)).insert(0, 'Today: ');
    await net.fullMesh();
    await converged([a, b, c], id);
    const final = await text(a, id);
    expect(final).toContain('big');
    expect(final).toContain('down');
    expect(final).toContain('Today: ');
    expect(await text(b, id)).toBe(final);
    expect(await text(c, id)).toBe(final);
  });

  it('does not duplicate files when the same state arrives twice', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    a.model.createDir('figures');
    await waitFor(() => b.model.list().length === 1);
    await net.link(a, b);
    await new Promise((r) => setTimeout(r, 50));
    await expect.poll(async () => a.model.list(), { timeout: 15_000 }).toHaveLength(1);
    expect(b.model.list()).toHaveLength(1);
  });

  it('keeps both files, deterministically, when two peers create the same path concurrently', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    a.model.createText('notes.tex');
    b.model.createText('notes.tex');
    await net.link(a, b);
    await waitFor(() => a.model.list().length === 2 && b.model.list().length === 2);
    expect(a.model.list().map((f) => f.path)).toEqual(b.model.list().map((f) => f.path));
    expect(new Set(a.model.list().map((f) => f.path)).size).toBe(2);
  });

  it('only loads documents that are opened (lazy)', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await a.model.createTextNow(`ch${i}.tex`, `chapter ${i}`));
    await waitFor(() => b.model.list().length === 20);
    expect(b.model.loadedDocIds()).toEqual(['root']);
    await b.mesh.openDoc(`f:${ids[3]}`);
    await waitFor(async () => (await text(b, ids[3] as string)) === 'chapter 3');
    expect(b.model.loadedDocIds()).toHaveLength(2);
  });
});

describe('persistence (6.4)', () => {
  it('restores edits after a simulated kill', async () => {
    net = await Net.create();
    const store = new MemoryPersistence();
    const a = await net.add('alice', 'owner', { store });
    const id = await a.model.createTextNow('main.tex', 'draft v1');
    (await a.model.openText(id)).insert(8, ' + more');
    await new Promise((r) => setTimeout(r, 30)); // > flush interval
    a.mesh.destroy(); // "kill": nothing else is flushed

    const net2 = await Net.create();
    const a2 = await net2.add('alice', 'owner', { store });
    expect(a2.model.list().map((f) => f.path)).toEqual(['main.tex']);
    expect(await text(a2, id)).toBe('draft v1 + more');
    net2.destroy();
  });

  it('compacts the update log after many updates', async () => {
    net = await Net.create();
    const store = new MemoryPersistence();
    const a = await net.add('alice', 'owner', { store });
    const id = await a.model.createTextNow('main.tex', '');
    const docId = `f:${id}`;
    const t = await a.model.openText(id);
    for (let i = 0; i < 30; i++) {
      t.insert(t.length, 'x');
      await new Promise((r) => setTimeout(r, 8));
    }
    await a.model.flush();
    expect((await store.load(docId)).length).toBeGreaterThan(1);
    // force compaction through a fresh model with a low threshold
    const { ProjectModel } = await import('../src/model.js');
    const m = new ProjectModel(store, { flushMs: 1, compactAfter: 3 });
    await m.init();
    const tt = await m.openText(id);
    for (let i = 0; i < 10; i++) {
      tt.insert(tt.length, 'y');
      await new Promise((r) => setTimeout(r, 5));
    }
    await m.flush();
    const doc = new Y.Doc();
    for (const u of await store.load(docId)) Y.applyUpdate(doc, u);
    expect(doc.getText('t').toString()).toBe(`${'x'.repeat(30)}${'y'.repeat(10)}`);
    expect((await store.load(docId)).length).toBeLessThan(8);
  });

  it('restores a history snapshot as a normal edit that can be undone', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const id = await a.model.createTextNow('main.tex', 'version one');
    const snap = await a.model.captureSnapshot();
    const t = await a.model.openText(id);
    t.delete(0, t.length);
    t.insert(0, 'version two, much longer');
    a.model.createDir('extra');
    await converged([a, b], id);

    const { undoId } = await a.model.restore(snap.id);
    await converged([a, b], id);
    expect(await text(b, id)).toBe('version one');
    expect(b.model.list().map((f) => f.path)).toEqual(['main.tex']);

    await a.model.restore(undoId);
    await converged([a, b], id);
    expect(await text(b, id)).toBe('version two, much longer');
    expect(b.model.list().map((f) => f.path).sort()).toEqual(['extra', 'main.tex']);
  });
});

describe('merging independently imported copies (10.6)', () => {
  it('removes identical duplicates but keeps differing ones', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    // both bootstrap the same repository on their own (different random file ids)
    for (const n of [a, b]) {
      await n.model.createTextNow('main.tex', 'same text');
      n.model.createBinary('img/x.png', 'hashX', 3);
      n.model.createDir('sections');
    }
    await a.model.createTextNow('notes.tex', 'alice version');
    await b.model.createTextNow('notes.tex', 'bob version');
    await net.link(a, b);
    await waitFor(() => a.model.list().length >= 6 && b.model.list().length >= 6);
    for (const n of [a, b]) await n.mesh.prefetchAll();
    await new Promise((r) => setTimeout(r, 200));

    const removedA = await a.model.dedupeIdentical();
    const removedB = await b.model.dedupeIdentical();
    expect(removedA).toBeGreaterThan(0);
    expect(removedA + removedB).toBeGreaterThanOrEqual(3);
    await waitFor(() => a.model.list().length === b.model.list().length);
    const paths = a.model.list().map((f) => f.path).sort();
    expect(paths.filter((p) => p === 'main.tex')).toHaveLength(1);
    expect(paths.filter((p) => p === 'img/x.png')).toHaveLength(1);
    expect(paths.filter((p) => p === 'sections')).toHaveLength(1);
    expect(paths.filter((p) => p.startsWith('notes'))).toHaveLength(2); // different content: both kept
  });
});

describe('path safety', () => {
  it('refuses to create or rename to unsafe paths and neutralises ones a peer injected', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    for (const bad of ['../evil.tex', '/etc/passwd', 'a/../../b', 'C:\\x.tex', 'a\\b.tex', 'x/./y', 'a//b', '', 'bad\u0000name']) {
      expect(() => a.model.createText(bad), bad).toThrow(/Invalid file path/);
      expect(() => a.model.createDir(bad), bad).toThrow();
    }
    const id = a.model.createText('ok.tex');
    expect(() => a.model.rename(id, '../escape.tex')).toThrow();

    // a malicious peer writes an unsafe path straight into the CRDT
    const Y = await import('yjs');
    b.model.root.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('path', '../../outside.tex');
      m.set('kind', 'text');
      b.model.files.set('evil2', m);
    });
    await waitFor(() => a.model.list().some((f) => f.id === 'evil2'));
    const evil = a.model.list().find((f) => f.id === 'evil2');
    expect(evil?.path).toBe('_unsafe_/evil2');
    expect(a.model.list().every((f) => !f.path.includes('..'))).toBe(true);
  });
});
