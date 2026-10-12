import { describe, expect, it } from 'vitest';
import { ActorCommands, ActorDocs, directLink, RendererDoc } from '../src/editor-bridge.js';
import { ChangeLog } from '../src/changelog.js';
import { EditIngress, MemoryIngressJournal } from '../src/ingress.js';
import { ProjectModel } from '../src/model.js';
import { FaultyPersistence } from './faulty-store.js';

/** 7.2: editor commands and edits through actor authorization and durable acknowledgements. */
async function world() {
  const store = new FaultyPersistence();
  const model = new ProjectModel(store, { flushMs: 2 });
  await model.init();
  const changelog = new ChangeLog({ model, store, idleMs: 20 });
  changelog.start();
  const journal = new MemoryIngressJournal();
  let allowed = true;
  const ingress = new EditIngress({ journal, model, canApply: () => allowed, originFor: (e) => ({ attachment: e.attachment }) });
  const actor = new ActorDocs({ model, ingress });
  const commands = new ActorCommands({ model, changelog, canApply: () => allowed });
  return { store, model, changelog, journal, actor, commands, deny: () => { allowed = false; } };
}
const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('editor commands and durability (7.2)', () => {
  it('runs typed file commands durably and refuses them after a demotion', async () => {
    const w = await world();
    const created = await w.commands.run({ kind: 'create', path: 'a.tex', text: 'hello' });
    expect(created.ok).toBe(true);
    const id = (created as { value: string }).value;
    expect((await w.commands.run({ kind: 'rename', id, path: 'b.tex' })).ok).toBe(true);
    expect(w.model.byId(id)?.path).toBe('b.tex');
    expect(await w.commands.run({ kind: 'rename', id: 'nope', path: 'x' })).toEqual({ ok: false, reason: 'not-found' });
    w.deny();
    expect(await w.commands.run({ kind: 'delete', id })).toEqual({ ok: false, reason: 'denied' });
    expect(w.model.byId(id)).toBeDefined();
  });

  it('typing is attributed to this device and undo works through the actor', async () => {
    const w = await world();
    const id = (await w.commands.run({ kind: 'create', path: 'u.tex', text: 'start' }) as { value: string }).value;
    await w.changelog.flush(); // the creation is its own change set
    const r = new RendererDoc(directLink(w.actor), 'att-1', `f:${id}`);
    await r.attach();
    r.doc.getText('t').insert(5, ' typed');
    await until(() => r.state === 'saved');
    await w.changelog.flush();
    const sets = await w.changelog.list();
    const typed = sets.find((s) => s.files.some((f) => f.fileId === id && f.op === 'edit'));
    expect(typed?.source).toEqual({ kind: 'editor', name: 'This device' });
    const undone = await w.commands.run({ kind: 'undo', changeSetId: typed?.id as string });
    expect(undone.ok).toBe(true);
    await until(async () => (await w.model.openText(id)).toString() === 'start');
    await until(() => r.doc.getText('t').toString() === 'start'); // the renderer follows the actor's undo
  });
  it('a demotion while a batch loads text prevents both the text and file-table mutations', async () => {
    const w = await world();
    const id = await w.model.createTextNow('old.tex', 'keep');
    const original = w.model.openText.bind(w.model);
    let release!: () => void;
    let loading = false;
    w.model.openText = async (file) => {
      loading = true;
      await new Promise<void>((r) => { release = r; });
      return original(file);
    };
    const command = w.commands.run({ kind: 'batch', ops: [
      { op: 'text', id, path: 'old.tex', text: 'forbidden' },
      { op: 'setting', key: 'engine', value: 'forbidden' },
    ] });
    await until(() => loading);
    w.deny(); release();
    expect(await command).toEqual({ ok: false, reason: 'denied' });
    expect((await original(id)).toString()).toBe('keep');
    expect(w.model.settings.get('engine')).toBeUndefined();
  });

  it('a failing store is never reported as saved; the edit stays journaled and is recovered after a worker crash', async () => {
    const w = await world();
    const id = (await w.commands.run({ kind: 'create', path: 's.tex', text: 'x' }) as { value: string }).value;
    const r = new RendererDoc(directLink(w.actor), 'att-1', `f:${id}`);
    await r.attach();
    w.store.failAppend = 1_000; // storage refuses every write from now on
    r.doc.getText('t').insert(1, ' pending');
    await until(() => r.state === 'error' || r.state === 'pending');
    await new Promise((res) => setTimeout(res, 100));
    expect(r.state).not.toBe('saved');
    expect(await w.journal.pending()).toHaveLength(1);
    // The worker crashes now; a new one starts on the same store and journal once storage works again.
    w.store.failAppend = 0;
    const model = new ProjectModel(w.store, { flushMs: 2 });
    await model.init();
    const ingress = new EditIngress({ journal: w.journal, model, canApply: () => true, originFor: (e) => ({ attachment: e.attachment }) });
    await ingress.recover();
    expect((await model.openText(id)).toString()).toBe('x pending');
    expect(await w.journal.pending()).toEqual([]);
  });
});
