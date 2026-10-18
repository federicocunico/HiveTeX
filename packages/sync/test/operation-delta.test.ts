import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocPersister, MemoryPersistence, type OperationRecord, listOperations, operationViews } from '../src/persistence.js';
import { applyDelta, deltaOf } from '../src/operation-view.js';
import { ProjectModel } from '../src/model.js';
import { ROOT_DOC_ID } from '@hivetex/protocol';

// Deterministic generator: a failure is reproducible from the seed.
function rng(seed: number) { return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); }
const alphabet = 'ab \n{}\\é😀';

it('round-trips 10,000 journaled operations: inverse delta + update give the previous text, and the journal replays exactly', async () => {
  const random = rng(42), store = new MemoryPersistence(), doc = new Y.Doc(), text = doc.getText('t');
  const records: OperationRecord[] = [];
  const p = new DocPersister(store, 'f:fuzz', doc, { flushMs: 1_000_000, compactAfter: 1_000_000, onOperation: (r) => records.push(r) });
  const expected: Array<{ before: string; after: string }> = [];
  const word = () => Array.from({ length: 1 + Math.floor(random() * 6) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
  for (let n = 0; n < 10_000; n++) {
    const before = text.toString();
    const origin = random() < 0.1 ? 'folder' : null;
    doc.transact(() => {
      const ops = 1 + Math.floor(random() * 3);
      for (let k = 0; k < ops; k++) {
        const len = text.length, at = Math.floor(random() * (len + 1)), r = random();
        if (r < 0.55 || len === 0) text.insert(at, word());
        else if (r < 0.9) text.delete(Math.min(at, len - 1), Math.min(1 + Math.floor(random() * 4), len - Math.min(at, len - 1)));
        else { text.delete(0, Math.floor(len * 0.8)); text.insert(0, word()); }
      }
    }, origin);
    expected.push({ before, after: text.toString() });
    // Inverse applied to the text after must give the text before, for the delta the persister would record.
    const delta = deltaOf({ kind: 'text', text: before }, { kind: 'text', text: text.toString() });
    expect(applyDelta({ kind: 'text', text: text.toString() }, delta, -1)).toEqual({ kind: 'text', text: before });
  }
  await p.flush();
  expect(records).toHaveLength(expected.length);
  const stored = new Map((await listOperations(store)).map((r) => [r.id, r]));
  const cache = new Map();
  for (let n = 0; n < records.length; n++) {
    const views = await operationViews(store, stored.get(records[n]!.id)!, cache);
    expect(views).toEqual({ before: { kind: 'text', text: expected[n]!.before }, after: { kind: 'text', text: expected[n]!.after } });
  }
  // Destructive changes keep their preimage; plain typing only references deduplicated ones.
  expect([...stored.values()].filter((r) => r.snapshot).length).toBeLessThan(records.length / 4);
  await p.destroy();
});

it('replays root changes from deltas and stores each distinct preimage once', async () => {
  const store = new MemoryPersistence(), model = new ProjectModel(store, { flushMs: 1_000_000 });
  await model.init(); model.markComplete(ROOT_DOC_ID);
  const seen: string[][] = [], order: string[] = [];
  model.onOperation((r) => { if (r.docId === ROOT_DOC_ID) order.push(r.id); });
  const list = () => model.list().map((f) => `${f.id}:${f.path}`).sort();
  model.onDocUpdate((docId) => { if (docId === ROOT_DOC_ID) seen.push(list()); });
  const a = model.createText('a.tex'), b = model.createText('b.tex');
  model.rename(a, 'c.tex'); model.delete(b); model.settings.set('main', 'c.tex');
  await model.flush();
  const stored = new Map((await listOperations(store)).map((r) => [r.id, r]));
  const records = order.map((id) => stored.get(id)!);
  const cache = new Map();
  const after = [];
  for (const r of records) {
    const v = (await operationViews(store, r, cache))!;
    if (v.after.kind !== 'root') throw new Error('root view');
    after.push(Object.entries(v.after.maps.files ?? {}).filter(([, e]) => !(e as { deleted?: unknown }).deleted).map(([id, e]) => `${id}:${(e as { path: string }).path}`).sort());
  }
  expect(after).toEqual(seen);
  const snapshots = [...store.meta.keys()].filter((k) => /^operation:snapshot:[0-9a-f]{64}$/.test(k));
  expect(new Set(snapshots).size).toBe(snapshots.length);
  await model.destroy();
});
