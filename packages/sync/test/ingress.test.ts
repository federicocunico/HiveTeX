import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { EditIngress, type IngressEntry, MemoryIngressJournal } from '../src/ingress.js';
import { ProjectModel } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';

/**
 * 5.2: editor batches journaled before custody, applied once, acknowledged as durable after the replica persisted them.
 * A "worker termination" is a new model and ingress over the same store and journal.
 */
async function world() {
  const store = new MemoryPersistence();
  const journal = new MemoryIngressJournal();
  const model = new ProjectModel(store, { flushMs: 5 });
  await model.init();
  const id = await model.createTextNow('main.tex', 'base');
  await model.flush();
  return { store, journal, model, id };
}
/** An editor-side edit: the renderer replica produces a Yjs update against the actor's current state. */
async function edit(model: ProjectModel, id: string, text: string): Promise<Uint8Array> {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(await model.getDoc(`f:${id}`)));
  const before = Y.encodeStateVector(replica);
  const t = replica.getText('t');
  t.insert(t.length, text);
  return Y.encodeStateAsUpdate(replica, before);
}
async function restart(store: MemoryPersistence) {
  const model = new ProjectModel(store, { flushMs: 5 });
  await model.init();
  return model;
}
const textOf = async (model: ProjectModel, id: string) => (await model.openText(id)).toString();

describe('editor ingress (5.2)', () => {
  it('acknowledges custody after journaling, durability after persisting, and leaves the journal empty', async () => {
    const w = await world();
    const ingress = new EditIngress({ journal: w.journal, model: w.model, canApply: () => true, origin: 'editor' });
    const custody: number[] = [];
    const entry: IngressEntry = { attachment: 'a1', seq: 1, docId: `f:${w.id}`, update: await edit(w.model, w.id, ' one') };
    const r = await ingress.submit(entry, (s) => custody.push(s));
    expect(custody).toEqual([1]);
    expect(r).toEqual({ seq: 1, status: 'durable' });
    expect(await w.journal.pending()).toEqual([]);
    expect(await textOf(await restart(w.store), w.id)).toBe('base one');
  });

  it('a termination after custody but before applying replays the edit once on restart', async () => {
    const w = await world();
    const update = await edit(w.model, w.id, ' journaled');
    await w.journal.put({ attachment: 'a1', seq: 1, docId: `f:${w.id}`, update }); // custody given, worker died
    const model = await restart(w.store);
    expect(await textOf(model, w.id)).toBe('base');
    const results = await new EditIngress({ journal: w.journal, model, canApply: () => true, origin: 'editor' }).recover();
    expect(results).toEqual([{ seq: 1, status: 'durable' }]);
    expect(await textOf(model, w.id)).toBe('base journaled');
    expect(await w.journal.pending()).toEqual([]);
  });

  it('a termination after persisting but before the acknowledgement replays without duplicating', async () => {
    const w = await world();
    const update = await edit(w.model, w.id, ' applied');
    await w.journal.put({ attachment: 'a1', seq: 1, docId: `f:${w.id}`, update });
    Y.applyUpdate(await w.model.getDoc(`f:${w.id}`), update, 'editor');
    await w.model.flush(); // durable in the replica, the journal entry was never acknowledged
    const model = await restart(w.store);
    await new EditIngress({ journal: w.journal, model, canApply: () => true, origin: 'editor' }).recover();
    expect(await textOf(model, w.id)).toBe('base applied');
  });

  it('a redelivered batch is acknowledged again but applied once, and batches keep their order', async () => {
    const w = await world();
    const ingress = new EditIngress({ journal: w.journal, model: w.model, canApply: () => true, origin: 'editor' });
    const u1 = await edit(w.model, w.id, ' 1');
    const e1 = { attachment: 'a1', seq: 1, docId: `f:${w.id}`, update: u1 };
    await ingress.submit(e1);
    const u2 = await edit(w.model, w.id, ' 2');
    await Promise.all([ingress.submit({ attachment: 'a1', seq: 2, docId: `f:${w.id}`, update: u2 }), ingress.submit(e1)]);
    expect(await textOf(w.model, w.id)).toBe('base 1 2');
  });

  it('denied edits are kept for export, never applied, and stay journaled', async () => {
    const w = await world();
    let allowed = false;
    const ingress = new EditIngress({ journal: w.journal, model: w.model, canApply: () => allowed, origin: 'editor' });
    const entry = { attachment: 'a1', seq: 1, docId: `f:${w.id}`, update: await edit(w.model, w.id, ' after demotion') };
    expect(await ingress.submit(entry)).toEqual({ seq: 1, status: 'denied' });
    expect(await textOf(w.model, w.id)).toBe('base');
    expect(ingress.denied).toHaveLength(1);
    expect(await w.journal.pending()).toHaveLength(1);
    await ingress.recover();
    expect(ingress.denied).toHaveLength(1); // not listed twice
    allowed = true;
    const restarted=new EditIngress({journal:w.journal,model:w.model,canApply:()=>allowed});
    expect(await restarted.submit({...entry,update:await edit(w.model,w.id,' substituted')})).toEqual({seq:1,status:'denied'});
    await restarted.submit({...entry,seq:2,update:await edit(w.model,w.id,' allowed')});
    expect(await textOf(w.model,w.id)).toBe('base allowed');
    const retained=await w.journal.pending();
    expect(retained).toHaveLength(1);expect(retained[0]?.denied).toBe(true);
  });
});
