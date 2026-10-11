import { fileDocId } from '@hivetex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { acquireProject, projectHash } from '../src/snapshot.js';
import { waitFor } from './helpers.js';
import { type Node, Net } from './net.js';

let net: Net;
afterEach(() => net?.destroy());

const bytes = (s: string) => new TextEncoder().encode(s);

describe('complete immutable project acquisition (8.1, F06, F14)', () => {
  it('captures text, settings, file revisions and asset hashes, and fetches assets by the captured hashes', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    const blobs = new BlobManager(a.mesh, a.store);
    const id = await a.model.createTextNow('main.tex', 'v1');
    const hash = await blobs.add(bytes('PNG'));
    a.model.createBinary('fig.png', hash, 3);
    a.model.settings.set('engine', 'xelatex');
    const r = await acquireProject(a.mesh, a.model, blobs);
    if (!r.complete) throw new Error('expected a complete project');
    expect(r.capture.settings).toEqual({ main: 'main.tex', engine: 'xelatex' });
    expect(r.capture.files.find((f) => f.path === 'main.tex')).toMatchObject({ kind: 'text', text: 'v1', revision: a.model.revision(fileDocId(id)) });
    expect(r.capture.files.find((f) => f.path === 'fig.png')).toMatchObject({ kind: 'binary', hash });
    expect(new TextDecoder().decode(r.assets.get(hash))).toBe('PNG');
  });

  it('is not changed by a text edit that lands while an asset is still being fetched', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    const blobs = new BlobManager(a.mesh, a.store);
    const id = await a.model.createTextNow('main.tex', 'v1');
    const hash = await blobs.add(bytes('ZZZ'));
    a.model.createBinary('zzz.png', hash, 3);
    const first = await acquireProject(a.mesh, a.model, blobs, { assets: false });
    if (!first.complete) throw new Error('expected a complete project');
    const before = await projectHash(first.capture);
    const real = blobs.fetch.bind(blobs);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let started: () => void = () => {};
    const fetching = new Promise<void>((r) => (started = r));
    blobs.fetch = async (h, t) => {
      started();
      await gate;
      return real(h, t);
    };
    const pending = acquireProject(a.mesh, a.model, blobs);
    await fetching;
    (await a.model.openText(id)).insert(2, ' edited');
    release();
    const r = await pending;
    if (!r.complete) throw new Error('expected a complete project');
    expect(r.capture.files.find((f) => f.path === 'main.tex')?.text).toBe('v1');
    expect(await projectHash(r.capture)).toBe(before);
    expect(r.capture.seq).toBeLessThan(a.model.changeSeq);
  });

  it('reports a file known by name but not received instead of an empty stand-in', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    const blobs = new BlobManager(a.mesh, a.store);
    await a.model.createTextNow('main.tex', 'here');
    a.model.putEntry('ghost', { path: 'ghost.tex', kind: 'text' });
    const r = await acquireProject(a.mesh, a.model, blobs, { timeoutMs: 200 });
    expect(r.complete).toBe(false);
    if (r.complete) return;
    expect(r.missing).toEqual([expect.objectContaining({ path: 'ghost.tex', kind: 'text' })]);
  });

  it('waits for a text body that arrives during acquisition', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await a.model.createTextNow('main.tex', 'body from alice');
    await net.link(a, b);
    await waitFor(() => b.model.list().length === 1);
    expect(b.model.missingText()).toHaveLength(1);
    const r = await acquireProject(b.mesh, b.model, new BlobManager(b.mesh, b.store), { timeoutMs: 3000 });
    if (!r.complete) throw new Error('expected a complete project');
    expect(r.capture.files[0]?.text).toBe('body from alice');
  });

  it('reports an asset nobody can supply, and stays usable offline when the project is complete', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    const blobs = new BlobManager(a.mesh, a.store);
    await a.model.createTextNow('main.tex', 'x');
    const have = await blobs.add(bytes('local'));
    a.model.createBinary('have.png', have, 5);
    expect((await acquireProject(a.mesh, a.model, blobs, { assetTimeoutMs: 50 })).complete).toBe(true);
    a.model.createBinary('lost.png', 'f'.repeat(64), 5);
    const r = await acquireProject(a.mesh, a.model, blobs, { assetTimeoutMs: 50 });
    expect(r.complete).toBe(false);
    if (r.complete) return;
    expect(r.missing).toEqual([expect.objectContaining({ path: 'lost.png', kind: 'binary', hash: 'f'.repeat(64) })]);
  });

  it('refuses to record a history snapshot while text is missing', async () => {
    net = await Net.create();
    const a: Node = await net.add('alice', 'owner');
    await a.model.createTextNow('main.tex', 'here');
    a.model.putEntry('ghost', { path: 'ghost.tex', kind: 'text' });
    await expect(a.model.captureSnapshot()).rejects.toThrow(/ghost\.tex/);
    expect(await a.store.listSnapshots()).toHaveLength(0);
  });
});
