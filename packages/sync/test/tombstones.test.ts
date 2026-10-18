import { afterEach, expect, it } from 'vitest';
import { Net, converged, waitFor } from '../src/testkit.js';

let net: Net | undefined;
afterEach(() => net?.destroy());

/**
 * Recoverable deletions live in the root `tombstones` map (the entry leaves `files`, an ordinary deletion for 0.8.0).
 * Concurrent rename, edit and delete on three replicas: the rename of a removed entry is lost (design risk accepted),
 * the content and the deletion stay recoverable everywhere, the edit shows as a conflict, and a restore converges.
 */
it('concurrent rename, edit and delete on three replicas keep the file recoverable, then restore everywhere', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor'), c = await net.add('Carol', 'editor');
  const id = await a.model.createTextNow('main.tex', 'original');
  await net.fullMesh(); await converged([a, b, c], id);
  for (const n of [b, c]) expect((await n.mesh.reconcile(`f:${id}`)).outcome).toBe('confirmed');
  for (const n of [a, b, c]) net.isolate(n);
  a.model.delete(id);
  b.model.rename(id, 'renamed.tex');
  (await c.model.openText(id)).insert(8, ' + Carol');
  await net.fullMesh();
  const trace = async () => JSON.stringify(await Promise.all([a, b, c].map(async (n) => ({ n: n.name, list: n.model.list(), deleted: n.model.deletedFiles(), files: [...n.model.files.keys()], text: (await n.model.openText(id)).toString() }))));
  await waitFor(async () => {
    for (const n of [a, b, c]) if (n.model.byId(id) || !n.model.deletedFiles().some((f) => f.id === id && f.conflict) || (await n.model.openText(id)).toString() !== 'original + Carol') return false;
    return true;
  }, 5_000).catch(async (e) => { console.error('TRACE', await trace()); throw e; });
  for (const n of [a, b, c]) {
    expect(n.model.files.has(id)).toBe(false);
    expect(n.model.tombstones.get(id)?.entry.path).toBe('main.tex');
  }
  const deletion = b.model.deletedFiles()[0]!;
  b.model.restoreDeleted(id, deletion.deletion.id);
  await waitFor(() => [a, b, c].every((n) => n.model.byId(id)?.path === 'main.tex' && !n.model.deletedFiles().length), 5_000)
    .catch(async (e) => { console.error('TRACE', await trace()); throw e; });
  for (const n of [a, b, c]) expect((await n.model.openText(id)).toString()).toBe('original + Carol');
});

it('keep-deleted and keep-both act on the tombstone map', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor');
  const id = await a.model.createTextNow('main.tex', 'original');
  await net.link(a, b); await converged([a, b], id);
  expect((await b.mesh.reconcile(`f:${id}`)).outcome).toBe('confirmed');
  net.isolate(a);
  a.model.delete(id);
  (await b.model.openText(id)).insert(0, 'B ');
  await net.link(a, b);
  await waitFor(() => a.model.deletedFiles().some((f) => f.id === id && f.conflict) && b.model.deletedFiles().some((f) => f.id === id), 5_000);
  await converged([a, b], id);
  // Keep both: the text comes back as a new file; the deletion stays.
  const copy = await a.model.createTextNow('Recovered/main.tex', (await a.model.openText(id)).toString());
  // Keep deleted: a new deletion token resolves the conflict on every replica.
  const before = a.model.deletedFiles()[0]!;
  a.model.confirmDeletion(id, before.deletion.id, a.model.changeSeq);
  await waitFor(() => [a, b].every((n) => n.model.deletedFiles()[0]?.deletion.resolvedFrom === before.deletion.id && !n.model.deletedFiles()[0]?.conflict && !!n.model.byId(copy)), 5_000);
  expect([a, b].every((n) => !n.model.files.has(id))).toBe(true);
});
