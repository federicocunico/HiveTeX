import { afterEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Net, converged, waitFor } from '../src/testkit.js';
import { identity } from '../src/testkit.js';
import { ChangeLog, patchHunks } from '../src/changelog.js';
import { verifyOperation, readAuthoredOperation, signOperation, storeAuthoredOperation } from '../src/authorship.js';
import { listRecovery, readRecovery } from '../src/recovery.js';

it('applies a physical deletion made before the upgrade, keeps the removed file in Recovery once and never quarantines', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor');
  const id = await a.model.createTextNow('a.tex', 'retain every byte');
  await net.link(a, b); await converged([a, b], id);
  net.isolate(a);
  // Bob, on the previous release, deleted a.tex without a tombstone while Alice was offline, and created b.tex.
  b.model.root.getMap('files').delete(id);
  const created = await b.model.createTextNow('b.tex', 'new file');
  for (let n = 0; n < 3; n++) {
    await net.link(a, b);
    await waitFor(() => !!a.model.byId(created) && !a.model.byId(id));
    expect(a.mesh.historyStatus.quarantined).toBe(0);
    if (n === 0) { await converged([a, b], created); expect((await a.model.openText(created)).toString()).toBe('new file'); }
    net.isolate(a);
  }
  const removed = (await listRecovery(a.store)).filter((r) => r.fileId === id);
  expect(removed).toHaveLength(1);
  expect(removed[0]).toMatchObject({ kind: 'removed', path: 'a.tex' });
  expect(removed[0]!.reason).toContain(b.dev);
  expect(new TextDecoder().decode(await readRecovery(a.store, removed[0]!.id))).toBe('retain every byte');
});

it('holds only a root update with a future tombstone format, with a notice to update', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor');
  const id = await a.model.createTextNow('main.tex', 'kept');
  await net.link(a, b); await converged([a, b], id);
  a.model.root.transact(() => { a.model.root.getMap('tombstones').set(id, { v: 99 }); a.model.root.getMap('files').delete(id); });
  await waitFor(() => b.mesh.historyStatus.quarantined === 1);
  expect(b.model.byId(id)?.path).toBe('main.tex');
  expect((await listRecovery(b.store)).some((r) => r.reason.includes('update this app'))).toBe(true);
  net.isolate(a);
  await waitFor(() => b.mesh.historyStatus.quarantined === 0);
});

it('surfaces a binary branch arriving after resolution and refuses a stale second resolution', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor'), c = await net.add('Carol', 'editor');
  const id = a.model.createBinary('figure.pdf', 'original', 8);
  await net.fullMesh(); await waitFor(() => [b, c].every((n) => n.model.byId(id)?.hash === 'original'));
  net.isolate(c); net.isolate(b);
  a.model.setBinary(id, 'alice', 5); b.model.setBinary(id, 'bob', 3); c.model.setBinary(id, 'carol', 5);
  await net.link(a, b);
  await waitFor(() => a.model.binaryConflicts().some((f) => f.hashes.includes('bob')));
  a.model.resolveBinary(id, 'alice');
  expect(a.model.binaryConflicts()).toEqual([]);
  await net.link(a, c);
  await waitFor(() => a.model.binaryConflicts().some((f) => f.hashes.includes('carol') && f.hashes.includes('alice')));
  const revision = a.model.changeSeq;
  a.model.setBinary(id, 'newer', 5);
  expect(() => a.model.resolveBinary(id, 'carol', () => true, revision)).toThrow('changed after');
  expect(a.model.binaryVersions(id).map((v) => v.hash)).toEqual(expect.arrayContaining(['original', 'alice', 'bob', 'carol', 'newer']));
});

let net: Net;
afterEach(() => net?.destroy());

it('keeps two devices of the same author distinct in verified history', async () => {
  net = await Net.create();
  const a = await net.add('Alice','owner'), b = await net.add('Alice','editor'), c = await net.add('Carol','editor');
  const id = await a.model.createTextNow('main.tex','base'); await net.fullMesh(); await converged([a,b,c],id);
  (await a.model.openText(id)).insert(4,' first device'); await converged([a,b,c],id);
  (await b.model.openText(id)).insert(0,'second device ');
  await waitFor(async () => {
    const groups = await c.store.listChangeSets();
    return [a.dev,b.dev].every((dev) => groups.some((g) => g.source.uid === 'u-Alice' && g.source.device === dev && g.files.some((f) => f.op === 'edit')));
  });
  const sources = (await c.store.listChangeSets()).filter((g) => g.source.uid === 'u-Alice').map((g) => g.source);
  expect(new Set(sources.map((s) => s.device))).toEqual(new Set([a.dev,b.dev]));
  expect(sources.every((s) => s.provenance === 'verified' && s.name === 'Alice')).toBe(true);
});

it('keeps a concurrently edited deleted document recoverable on three replicas with a visible conflict', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner');
  const b = await net.add('Bob', 'editor');
  const c = await net.add('Carol', 'editor');
  const id = await a.model.createTextNow('main.tex', 'original');
  await net.fullMesh();
  await converged([a, b, c], id);
  // Capture both changes before either update is delivered.
  a.model.delete(id);
  (await b.model.openText(id)).insert(8, ' contribution');
  await waitFor(() => [a, b, c].every((n) => n.model.deletedFiles().some((f) => f.id === id && f.conflict)));
  await converged([a, b, c], id);
  for (const n of [a, b, c]) {
    expect(n.model.byId(id)).toBeUndefined();
    expect((await n.model.openText(id)).toString()).toBe('original contribution');
  }
  const deletion = c.model.deletedFiles()[0]!;
  c.model.restoreDeleted(id, deletion.deletion.id);
  await waitFor(() => [a, b, c].every((n) => n.model.byId(id)?.path === 'main.tex'));
  expect((await a.model.openText(id)).toString()).toBe('original contribution');
});

it('detects concurrent character deletions even when the state vector did not advance', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner');
  const id = await a.model.createTextNow('main.tex', 'original');
  a.model.delete(id);
  (await a.model.openText(id)).delete(0, 1);
  expect(a.model.deletedFiles()[0]?.conflict).toBe(true);
});

it('never undoes creation by deleting a later contribution on any of three replicas (audit F04)', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor'), c = await net.add('Carol', 'editor');
  await net.fullMesh();
  const log = new ChangeLog({ model: a.model, store: a.store, idleMs: 20 }); log.start();
  const id = await a.model.createTextNow('new.tex', 'created');
  await log.flush();
  const created = (await log.list()).find((g) => g.files.some((f) => f.op === 'create'))!;
  await converged([a, b, c], id);
  (await b.model.openText(id)).insert(7, ' and contributed');
  await waitFor(async () => (await a.model.openText(id)).toString().includes('contributed'));
  await converged([a, b, c], id);
  const result = await log.undo(created);
  expect(result?.partial).toContain('new.tex');
  for (const n of [a,b,c]) { expect(n.model.byId(id)).toBeDefined(); expect((await n.model.openText(id)).toString()).toContain('contributed'); }
  log.stop();
});

it('refuses undo-create after a later net-zero contribution even if the displayed text matches', async () => {
  net = await Net.create(); const a = await net.add('Alice', 'owner');
  const log = new ChangeLog({ model: a.model, store: a.store, idleMs: 20 }); log.start();
  const id = await a.model.createTextNow('new.tex', 'created'); await log.flush();
  const created = (await log.list()).find((g) => g.files.some((f) => f.op === 'create'))!;
  const text = await a.model.openText(id); text.insert(0, 'later '); text.delete(0, 6);
  expect(text.toString()).toBe('created');
  expect((await log.undo(created))?.partial).toContain('new.tex');
  expect(a.model.byId(id)).toBeDefined(); log.stop();
});

it('bootstraps signed retained history through a seed and deduplicates it on reconnect', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor');
  const id = await a.model.createTextNow('main.tex', 'original');
  (await a.model.openText(id)).insert(8, ' Alice offline');
  for (let n = 0; n < 36; n++) (await a.model.openText(id)).insert(0, '.');
  await a.model.flush();
  await net.link(a,b);
  await waitFor(() => b.mesh.historyStatus.complete);
  net.isolate(a);
  const c = await net.add('Carol', 'editor');
  await net.link(b,c);
  await waitFor(() => c.mesh.historyStatus.complete);
  const groups = await c.store.listChangeSets();
  // Retained history carries no preimage: Carol sees what the signed update inserted, never invented full texts.
  const inserted = (f: { patch?: string }) => f.patch ? patchHunks(f.patch).flat().filter((h) => h.op === 1).map((h) => h.text).join('') : '';
  expect(groups.some((g) => g.source.name === 'Alice' && g.source.device === a.dev && g.files.some((f) => inserted(f).includes('Alice offline') && f.after === undefined))).toBe(true);
  const ids = groups.filter((g) => g.id.startsWith('authored:')).map((g) => g.id).sort();
  net.isolate(c); await net.link(b,c);
  await waitFor(() => c.mesh.historyStatus.complete);
  expect((await c.store.listChangeSets()).filter((g) => g.id.startsWith('authored:')).map((g) => g.id).sort()).toEqual(ids);
});

it('verifies expired historical evidence without using it to authorize a live write', async () => {
  net = await Net.create();
  const writer = await identity('Alice', 'editor');
  const ticket = await net.auth.mint({ pid: net.pid, uid: writer.uid, uname: writer.uname, dev: writer.dev, keys: writer.keys, role: writer.role }, { iat: Math.floor(Date.now()/1000)-3600, ttlSec: 60 });
  const doc = new Y.Doc(); doc.getText('t').insert(0, 'archived');
  const op = await signOperation({ pid: net.pid, docId: 'f:archived', update: Y.encodeStateAsUpdate(doc), ticket, source: 'editor' }, writer.keys);
  expect((await verifyOperation(op, net.pid, net.auth.trusted, { historical: true })).claims.uid).toBe(writer.uid);
  await expect(verifyOperation(op, net.pid, net.auth.trusted)).rejects.toThrow();
});

it('preserves Alice as author through Bob to Carol, verifies signatures and rejects another project', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner');
  const b = await net.add('Bob', 'editor');
  const c = await net.add('Carol', 'editor');
  const id = await a.model.createTextNow('main.tex', 'original');
  await net.link(a, b);
  await net.link(b, c);
  await converged([a, b, c], id);
  const log = new ChangeLog({ model: c.model, store: c.store, idleMs: 5 });
  log.start();
  (await a.model.openText(id)).insert(8, ' Alice');
  await waitFor(async () => (await log.list()).some((g) => g.source.name === 'Alice' && g.files.some((f) => f.after?.includes(' Alice'))));
  const group = (await log.list()).find((g) => g.source.name === 'Alice' && g.files.some((f) => f.after?.includes(' Alice')))!;
  expect(group.source).toMatchObject({ name: 'Alice', uid: 'u-Alice', device: a.dev, provenance: 'verified' });
  const keys = (await c.store.listMetaKeys!()).filter((k) => k.startsWith('authored:'));
  const operations = await Promise.all(keys.map((key) => readAuthoredOperation(c.store, key.slice(9))));
  const operation = operations.find((op) => op?.docId === `f:${id}` && op.update && op.device === a.dev)!;
  const verified = await verifyOperation(operation, net.pid, net.auth.trusted);
  expect(verified.claims.uname).toBe('Alice');
  await expect(verifyOperation({ ...verified.operation, update: 'AAAA' }, net.pid, net.auth.trusted)).rejects.toThrow();
  await expect(verifyOperation(operation, 'another-project', net.auth.trusted)).rejects.toThrow();
  // The same immutable envelope is retained at every hop.
  expect(await readAuthoredOperation(b.store, verified.operation.id)).toEqual(operation);
  await expect(storeAuthoredOperation(b.store, { ...operation, update: 'AAAA' })).rejects.toThrow('immutable evidence');
  expect(await readAuthoredOperation(b.store, verified.operation.id)).toEqual(operation);
  log.stop();
});
