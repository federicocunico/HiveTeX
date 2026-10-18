import { afterEach, expect, it } from 'vitest';
import { ROOT_DOC_ID } from '@hivetex/protocol';
import { ChangeLog, type UndoRequest } from '../src/changelog.js';
import { ProjectModel, applyTextDiff } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';
import { Net, converged, waitFor } from '../src/testkit.js';

let net: Net | undefined;
afterEach(() => { net?.destroy(); net = undefined; });

/** Only what the store committed survives a process stop. */
function copyOf(store: MemoryPersistence) {
  const copy = new MemoryPersistence();
  copy.docs = structuredClone(store.docs); copy.meta = structuredClone(store.meta); copy.blobs = structuredClone(store.blobs);
  copy.snaps = structuredClone(store.snaps); copy.changes = structuredClone(store.changes);
  return copy;
}

it('closes the local change set when a co-author edit arrives, so undo removes only the local edit (5.1)', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor');
  const id = await a.model.createTextNow('main.tex', 'x');
  await net.link(a, b); await converged([a, b], id);
  const log = new ChangeLog({ model: a.model, store: a.store, idleMs: 60_000 }); log.start();
  const alice = await a.model.openText(id), bob = await b.model.openText(id);
  alice.insert(alice.length, 'A');
  await waitFor(() => bob.toString() === 'xA');
  bob.insert(bob.length, 'B');
  await waitFor(() => alice.toString() === 'xAB');
  alice.insert(alice.length, 'C'); // within the grouping window of "A"
  await converged([a, b], id);
  await log.flush();
  const local = (await log.list()).filter((c) => c.source.kind === 'editor');
  expect(local.slice(0, 2).map((c) => c.files.map((f) => f.after))).toEqual([['xABC'], ['xA']]);
  const result = await log.undo(local[0]!);
  expect(result?.partial ?? []).toEqual([]);
  expect(alice.toString()).toBe('xAB');
  await waitFor(() => bob.toString() === 'xAB');
  log.stop();
});

it('records no unknown-author edit and no duplicate group after first sync and a restart without edits (5.2)', async () => {
  net = await Net.create();
  const a = await net.add('Alice', 'owner'), b = await net.add('Bob', 'editor');
  const one = await a.model.createTextNow('main.tex', 'first file body'), two = await a.model.createTextNow('b.tex', 'second');
  const log = new ChangeLog({ model: b.model, store: b.store, idleMs: 20 }); log.start();
  await net.link(a, b); await converged([a, b], one); await converged([a, b], two);
  await b.model.flush(); await log.flush();
  const before = await log.list();
  log.stop(); net.destroy(); net = undefined;
  const store = copyOf(b.store as MemoryPersistence);
  for (let restart = 0; restart < 2; restart++) {
    const model = new ProjectModel(store); await model.init();
    const again = new ChangeLog({ model, store, idleMs: 20 }); again.start();
    const sets = await again.list();
    expect(sets.filter((c) => c.source.name.startsWith('Unknown original author'))).toEqual([]);
    expect(sets.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort());
    const ops = sets.flatMap((c) => c.operationIds ?? []);
    expect(new Set(ops).size).toBe(ops.length);
    again.stop(); await model.destroy();
  }
});

async function project() {
  const store = new MemoryPersistence(), model = new ProjectModel(store);
  await model.init(); model.markComplete(ROOT_DOC_ID);
  return { model, store };
}

it('refuses a restore whose precondition fails without leaving a pending checkpoint, then restores a new preview (5.3)', async () => {
  const { model, store } = await project();
  const id = await model.createTextNow('main.tex', 'version one');
  const target = await model.captureSnapshot();
  applyTextDiff(await model.openText(id), 'version two'); await model.flush();
  const plan = await model.previewRestore(target.id);
  applyTextDiff(await model.openText(id), 'co-author edit after preview');
  await expect(model.restore(target.id, () => true, plan.revision, plan.requestId)).rejects.toThrow('Project changed after restore preview');
  expect(await model.interruptedRestores()).toEqual([]);
  // The project also moves while the checkpoint itself is being written: the checkpoint is withdrawn.
  const racing = await model.previewRestore(target.id), meta = store.setMeta.bind(store);
  store.setMeta = async (key, value) => { await meta(key, value); if (key.startsWith('restore:pending:') && value) applyTextDiff(await model.openText(id), 'edit during the checkpoint'); };
  await expect(model.restore(target.id, () => true, racing.revision, racing.requestId)).rejects.toThrow('Project changed');
  store.setMeta = meta;
  expect(await model.interruptedRestores()).toEqual([]);
  expect(await model.interruptedRestores()).toEqual([]);
  const fresh = await model.previewRestore(target.id);
  await model.restore(target.id, () => true, fresh.revision, fresh.requestId);
  expect((await model.openText(id)).toString()).toBe('version one');
  await model.destroy();
});

it('cancels an interrupted restore by returning to its recovery point (5.3)', async () => {
  const { model, store } = await project();
  const id = await model.createTextNow('main.tex', 'old');
  const target = await model.captureSnapshot();
  applyTextDiff(await model.openText(id), 'new'); await model.flush();
  const undo = await model.captureSnapshot();
  applyTextDiff(await model.openText(id), 'old'); // a crash left the target half applied
  await store.setMeta('restore:pending:crashed', { v: 1, stage: 'prepared', snapshotId: target.id, undoId: undo.id, revision: 0, at: Date.now() });
  expect((await model.interruptedRestores()).map((r) => r.requestId)).toEqual(['crashed']);
  await model.abandonRestore('crashed');
  expect((await model.openText(id)).toString()).toBe('new');
  expect(await model.interruptedRestores()).toEqual([]);
  await expect(model.restore(target.id, () => true, undefined, 'crashed')).rejects.toThrow('cancelled');
  await model.destroy();
});

async function multiFileUndo() {
  const { model, store } = await project();
  const log = new ChangeLog({ model, store, idleMs: 20 }); log.start();
  const a = await model.createTextNow('a.tex', 'alpha'), b = await model.createTextNow('b.tex', 'beta'), c = await model.createTextNow('c.tex', 'gamma');
  await log.flush();
  for (const [id, text] of [[a, 'alpha edited'], [b, 'beta edited'], [c, 'gamma edited']] as const) applyTextDiff(await model.openText(id), text);
  await log.flush();
  const set = (await log.list()).find((g) => g.files.length === 3 && g.files.every((f) => f.op === 'edit'))!;
  expect(set).toBeDefined();
  return { model, store, log, set, ids: [a, b, c] as const };
}

it('reports an undo interrupted mid-way with the files already inverted, then completes it (5.3)', async () => {
  const { model, store, log, set, ids } = await multiFileUndo();
  let allowed = 2; // two mutations, then the permission is lost
  const canApply = () => allowed > 0;
  const setMeta = store.setMeta.bind(store);
  store.setMeta = async (key, value) => { await setMeta(key, value); if (key.startsWith('undo:request:') && (value as UndoRequest | undefined)?.done?.length) allowed--; };
  await expect(log.undo(set, () => canApply())).rejects.toThrow('denied');
  store.setMeta = setMeta;
  const [pending] = await log.interruptedUndos();
  expect(pending?.changeSetId).toBe(set.id);
  expect(pending!.done.map((s) => s.path)).toEqual(['c.tex', 'b.tex']);
  const texts = async () => Promise.all(ids.map(async (id) => (await model.openText(id)).toString()));
  expect(await texts()).toEqual(['alpha edited', 'beta', 'gamma']);
  // A retry is not refused because of the checkpoint: it completes the remaining file only.
  const done = await log.undo(set);
  expect(done?.undoOf).toBe(set.id);
  expect(done?.partial ?? []).toEqual([]);
  expect(await texts()).toEqual(['alpha', 'beta', 'gamma']);
  expect(await log.interruptedUndos()).toEqual([]);
  log.stop(); await model.destroy();
});

it('cancels an interrupted undo by reversing exactly the files it inverted, keeping later edits (5.3)', async () => {
  const { model, store, log, set, ids } = await multiFileUndo();
  let allowed = 2;
  const setMeta = store.setMeta.bind(store);
  store.setMeta = async (key, value) => { await setMeta(key, value); if (key.startsWith('undo:request:') && (value as UndoRequest | undefined)?.done?.length) allowed--; };
  await expect(log.undo(set, () => allowed > 0)).rejects.toThrow('denied');
  store.setMeta = setMeta;
  // A co-author edits an inverted file elsewhere before the member cancels.
  const gamma = await model.openText(ids[2]); gamma.insert(0, '% note\n');
  const reversed = await log.abandonUndo(set.id);
  expect(reversed?.source.name).toContain('Cancelled undo');
  expect(await Promise.all(ids.map(async (id) => (await model.openText(id)).toString()))).toEqual(['alpha edited', 'beta edited', '% note\ngamma edited']);
  expect(await log.interruptedUndos()).toEqual([]);
  expect(await store.listMetaKeys('undo:request:')).toEqual([]);
  log.stop(); await model.destroy();
});

it('leaves no undo checkpoint when the undo is refused before any mutation (5.3)', async () => {
  const { model, store, log, set } = await multiFileUndo();
  let calls = 0;
  await expect(log.undo(set, () => ++calls < 3)).rejects.toThrow('denied');
  expect(await store.listMetaKeys('undo:request:')).toEqual([]);
  expect(await log.undo(set)).toMatchObject({ undoOf: set.id });
  log.stop(); await model.destroy();
});
