import { BlobManager } from '@hivetex/sync';
import { Net } from '@hivetex/sync/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { exportProjectZip, readZip } from '../src/lib/import/zip.js';

let net: Net;
afterEach(() => net?.destroy());

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b?: Uint8Array) => new TextDecoder().decode(b);
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('source export needs complete content (8.3)', () => {
  it('exports a complete local project with its images, also with nobody online', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    const blobs = new BlobManager(a.mesh, a.store);
    await a.model.createTextNow('main.tex', 'hi');
    await a.model.createTextNow('chap/empty.tex', ''); // genuinely empty is not missing
    a.model.createBinary('img/x.png', await blobs.add(new Uint8Array([1, 2, 3])), 3);
    const r = await exportProjectZip(a.mesh, a.model, blobs);
    if (!r.ok) throw new Error('expected an archive');
    const { files } = readZip(r.zip);
    expect(files.map((f) => f.path).sort()).toEqual(['chap/empty.tex', 'img/x.png', 'main.tex']);
    expect(dec(files.find((f) => f.path === 'main.tex')?.bytes)).toBe('hi');
    expect(Array.from(files.find((f) => f.path === 'img/x.png')?.bytes ?? [])).toEqual([1, 2, 3]);
  });

  it('waits for a body that has not arrived yet instead of substituting an empty file', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await a.model.createTextNow('main.tex', 'the real text');
    await net.link(a, b);
    await waitFor(() => b.model.list().length === 1); // the file list is here, the body is not
    expect(b.model.missingText()).toHaveLength(1);
    const r = await exportProjectZip(b.mesh, b.model, new BlobManager(b.mesh, b.store), { timeoutMs: 3000 });
    if (!r.ok) throw new Error('expected an archive');
    expect(dec(readZip(r.zip).files[0]?.bytes)).toBe('the real text');
  });

  it('names the missing files and produces no archive', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    const blobs = new BlobManager(a.mesh, a.store);
    await a.model.createTextNow('main.tex', 'here');
    a.model.putEntry('ghost', { path: 'ghost.tex', kind: 'text' });
    const text = await exportProjectZip(a.mesh, a.model, blobs, { timeoutMs: 200 });
    expect(text).toMatchObject({ ok: false });
    if (!text.ok) expect(text.missing.map((m) => m.path)).toEqual(['ghost.tex']);
    a.model.markComplete('f:ghost');
    a.model.createBinary('fig.png', 'a'.repeat(64), 3);
    const image = await exportProjectZip(a.mesh, a.model, blobs, { assetTimeoutMs: 50 });
    expect(image).toMatchObject({ ok: false });
    if (!image.ok) expect(image.missing.map((m) => m.path)).toEqual(['fig.png']);
  });
});
