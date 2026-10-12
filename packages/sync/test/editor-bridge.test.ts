import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ActorDocs, directLink, RendererDoc } from '../src/editor-bridge.js';
import { EditIngress, MemoryIngressJournal } from '../src/ingress.js';
import { ProjectModel } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';

/** 7.1-7.2: renderer replicas attached to the authoritative runtime's documents. */
async function actorWorld(opts: { canApply?: () => boolean } = {}) {
  const store = new MemoryPersistence();
  const model = new ProjectModel(store, { flushMs: 2 });
  await model.init();
  const id = await model.createTextNow('main.tex', 'base');
  const journal = new MemoryIngressJournal();
  const ingress = new EditIngress({ journal, model, canApply: opts.canApply ?? (() => true), originFor: (e) => ({ attachment: e.attachment }) });
  const actor = new ActorDocs({ model, ingress });
  return { store, model, id, docId: `f:${id}`, journal, actor };
}
/** A co-author's edit arriving through the mesh: applied to the actor's document with a non-renderer origin. */
async function remoteEdit(model: ProjectModel, docId: string, f: (t: Y.Text) => void) {
  const d = await model.getDoc(docId);
  d.transact(() => f(d.getText('t')), 'peer');
}
const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const text = (r: RendererDoc) => r.doc.getText('t').toString();

describe('editor bridge (7.1)', () => {
  it('converges with remote edits that land while the attachment is in flight, without gaps or duplicates', async () => {
    const w = await actorWorld();
    const r = new RendererDoc(directLink(w.actor, 15), 'att-1', w.docId);
    const attaching = r.attach();
    // Remote edits race the snapshot: some before it is taken, some after it was sent.
    await remoteEdit(w.model, w.docId, (t) => t.insert(t.length, ' r1'));
    await new Promise((res) => setTimeout(res, 20));
    await remoteEdit(w.model, w.docId, (t) => t.insert(t.length, ' r2'));
    await attaching;
    await remoteEdit(w.model, w.docId, (t) => t.insert(t.length, ' r3'));
    const actorText = async () => (await w.model.openText(w.id)).toString();
    await until(async () => text(r) === (await actorText()));
    expect(text(r)).toBe('base r1 r2 r3');
  });

  it('local typing reaches the actor once, durably, and is never echoed back', async () => {
    const w = await actorWorld();
    const r = new RendererDoc(directLink(w.actor, 2), 'att-1', w.docId);
    await r.attach();
    let updatesSeen = 0;
    r.doc.on('update', () => updatesSeen++);
    for (const ch of ' typed') r.doc.getText('t').insert(r.doc.getText('t').length, ch);
    const typedUpdates = updatesSeen;
    await until(() => r.state === 'saved');
    expect((await w.model.openText(w.id)).toString()).toBe('base typed');
    await new Promise((res) => setTimeout(res, 30));
    expect(updatesSeen).toBe(typedUpdates); // no echo of our own edits
    expect(await w.journal.pending()).toEqual([]);
    const after = new ProjectModel(w.store);
    await after.init();
    expect((await after.openText(w.id)).toString()).toBe('base typed');
  });

  it('a reloaded renderer reattaches from scratch, and a stale one with edits merges them without loss', async () => {
    const w = await actorWorld();
    const first = new RendererDoc(directLink(w.actor), 'att-1', w.docId);
    await first.attach();
    first.doc.getText('t').insert(4, ' one');
    await until(() => first.state === 'saved');
    first.detach();
    await remoteEdit(w.model, w.docId, (t) => t.insert(0, '>> '));
    // Renderer reload: a brand-new replica (no state) attaches.
    const reloaded = new RendererDoc(directLink(w.actor), 'att-2', w.docId);
    await reloaded.attach();
    expect(text(reloaded)).toBe('>> base one');
    // The old replica (still holding its state) reattaches: only the missing part comes, nothing duplicates.
    await first.attach();
    expect(text(first)).toBe('>> base one');
    // Two attachments typing at once converge on the actor and on both renderers.
    first.doc.getText('t').insert(0, 'A');
    reloaded.doc.getText('t').insert(text(reloaded).length, 'B');
    await until(async () => text(first) === text(reloaded) && text(first) === (await w.model.openText(w.id)).toString());
    expect(text(first)).toMatch(/^A>> base oneB$/);
  });

  it('edits refused by authorization stay pending as denied and never reach the actor', async () => {
    let allowed = true;
    const w = await actorWorld({ canApply: () => allowed });
    const r = new RendererDoc(directLink(w.actor), 'att-1', w.docId);
    await r.attach();
    allowed = false; // demoted to viewer while editing
    r.doc.getText('t').insert(0, 'forbidden ');
    await until(() => r.state === 'denied');
    expect((await w.model.openText(w.id)).toString()).toBe('base');
    expect(await w.journal.pending()).toHaveLength(1); // kept for export, not published
  });
});
