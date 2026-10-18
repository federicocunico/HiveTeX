import { afterEach, describe, expect, it } from 'vitest';
import { ChangeLog } from '../src/changelog.js';
import { MIRROR_ORIGIN } from '../src/mirror.js';
import { ProjectModel, applyTextDiff } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';
import { waitFor } from './helpers.js';
import { Net, converged, text } from './net.js';
import { ROOT_DOC_ID } from '@hivetex/protocol';

let net: Net | undefined;
const logs: ChangeLog[] = [];
afterEach(() => {
  for (const l of logs.splice(0)) l.stop();
  net?.destroy();
  net = undefined;
});

function track(model: ProjectModel, store: MemoryPersistence | import('../src/persistence.js').Persistence) {
  const log = new ChangeLog({ model, store, idleMs: 60 });
  log.start();
  logs.push(log);
  return log;
}

async function solo() {
  const store = new MemoryPersistence();
  const model = new ProjectModel(store, { flushMs: 5 });
  await model.init();
  model.markComplete(ROOT_DOC_ID);
  return { model, store };
}

describe('change sets', () => {
  it('records the first lazy edit and the complete contents of a lazy deletion (audit F05/F08)', async () => {
    const { model, store } = await solo();
    const edit = await model.createTextNow('edit.tex', 'original edit');
    const deleted = await model.createTextNow('deleted.tex', 'original deleted');
    await model.flush();
    await model.destroy();
    const reopened = new ProjectModel(store, { flushMs: 5 });
    await reopened.init();
    const log = track(reopened, store);
    applyTextDiff(await reopened.openText(edit), 'changed');
    reopened.delete(deleted);
    await log.flush();
    const set = (await log.list())[0]!;
    expect(set.files.find((f) => f.fileId === edit)?.op).toBe('edit');
    expect(set.files.find((f) => f.fileId === deleted)?.before).toBe('original deleted');
    await log.undo(set);
    expect((await reopened.openText(reopened.find('deleted.tex')!.id)).toString()).toBe('original deleted');
    expect((await reopened.openText(edit)).toString()).toBe('original edit');
    await reopened.destroy();
  });

  it('preserves both edit and rename in a single undoable group (audit F09)', async () => {
    const { model, store } = await solo();
    const id = await model.createTextNow('before.tex', 'before');
    const log = track(model, store);
    applyTextDiff(await model.openText(id), 'after');
    model.rename(id, 'after.tex');
    await log.flush();
    const set = (await log.list())[0]!;
    expect(set.files.map((f) => f.op)).toEqual(['edit', 'rename']);
    await log.undo(set);
    expect(model.byId(id)?.path).toBe('before.tex');
    expect((await model.openText(id)).toString()).toBe('before');
    await model.destroy();
  });

  it('does not include an interleaved editor contribution in the folder inverse (audit F06)', async () => {
    const { model, store } = await solo();
    const id = await model.createTextNow('main.tex', 'base');
    const log = track(model, store);
    applyTextDiff(await model.openText(id), 'base folder', MIRROR_ORIGIN);
    applyTextDiff(await model.openText(id), 'base folder EDITOR');
    await log.flush();
    const folder = (await log.list()).find((s) => s.source.kind === 'folder')!;
    expect(folder.files[0]?.patch).not.toContain('EDITOR');
    await log.undo(folder);
    expect((await model.openText(id)).toString()).toBe('base EDITOR');
    await model.destroy();
  });

  it('retries a failed history write without losing the set (audit F10)', async () => {
    const { model, store } = await solo();
    const id = await model.createTextNow('main.tex', 'before');
    const log = track(model, store);
    applyTextDiff(await model.openText(id), 'after');
    const write = store.putChangeSet.bind(store);
    store.putChangeSet = async () => { throw new Error('disk full'); };
    await expect(log.flush()).rejects.toThrow('disk full');
    store.putChangeSet = write;
    await log.flush();
    expect(await log.list()).toHaveLength(1);
    await log.undo((await log.list())[0]!);
    expect((await model.openText(id)).toString()).toBe('before');
    await model.destroy();
  });

  it('groups folder edits on several files into one attributed change set', async () => {
    const { model, store } = await solo();
    const a = await model.createTextNow('a.tex', 'alpha');
    const b = await model.createTextNow('b.tex', 'beta\n');
    const log = track(model, store);
    applyTextDiff(await model.openText(a), 'alpha (by the AI)', MIRROR_ORIGIN);
    applyTextDiff(await model.openText(b), 'beta\nnew line\n', MIRROR_ORIGIN);
    await waitFor(async () => (await log.list()).length === 1);
    const [set] = await log.list();
    expect(set?.source).toEqual({ kind: 'folder', name: 'Folder on this device' });
    expect(set?.files.map((f) => [f.path, f.op]).sort()).toEqual([['a.tex', 'edit'], ['b.tex', 'edit']]);
    expect(set?.files.find((f) => f.path === 'b.tex')).toMatchObject({ added: 1 });
  });

  it('attributes edits received from a co-author to that co-author', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const id = await a.model.createTextNow('main.tex', 'hello');
    await converged([a, b], id);
    const log = track(a.model, a.store);
    (await b.model.openText(id)).insert(5, ' world');
    await waitFor(async () => (await log.list()).some((c) => c.source.name === 'bob'));
    expect((await log.list()).find((c) => c.source.name === 'bob')?.source).toMatchObject({ kind: 'peer', name: 'bob', uid: 'u-bob', device: b.dev, provenance: 'verified' });
  });

  it('does not record documents as changes when they are first loaded', async () => {
    const store = new MemoryPersistence();
    const m1 = new ProjectModel(store, { flushMs: 1 });
    await m1.init();
    await m1.createTextNow('main.tex', 'persisted content');
    await m1.flush();
    const m2 = new ProjectModel(store, { flushMs: 1 });
    await m2.init();
    const log = track(m2, store);
    const baseline = await log.list();
    await m2.openText(m2.find('main.tex')?.id as string);
    await new Promise((r) => setTimeout(r, 150));
    expect(await log.list()).toEqual(baseline);
  });

  it('records creations, renames and deletions', async () => {
    const { model, store } = await solo();
    const keep = await model.createTextNow('keep.tex', 'k');
    const gone = await model.createTextNow('gone.tex', 'bye');
    await model.openText(gone);
    const log = track(model, store);
    await model.createTextNow('new.tex', 'fresh', MIRROR_ORIGIN);
    model.rename(keep, 'kept.tex', MIRROR_ORIGIN);
    model.delete(gone, MIRROR_ORIGIN);
    await waitFor(async () => (await log.list()).length === 1);
    const ops = Object.fromEntries((await log.list())[0]?.files.map((f) => [f.path, f]) ?? []);
    expect(ops['new.tex']?.op).toBe('create');
    expect(ops['kept.tex']).toMatchObject({ op: 'rename', from: 'keep.tex' });
    expect(ops['gone.tex']).toMatchObject({ op: 'delete', before: 'bye' });
  });
});

describe('undo', () => {
  it('retains edit and delete boundaries in one group and restores the pre-edit text', async () => {
    const {model,store}=await solo(); const id=await model.createTextNow('main.tex','original'); const log=track(model,store);
    applyTextDiff(await model.openText(id),'edited'); model.delete(id); await log.flush();
    const set=(await log.list())[0]!;
    expect(set.files.map((f)=>f.op)).toEqual(['edit','delete']);
    await log.undo(set);
    expect((await model.openText(model.find('main.tex')!.id)).toString()).toBe('original');
    await model.destroy();
  });
  it('does not remove a created file after a later contribution (audit F04)', async () => {
    const { model, store } = await solo();
    const log = track(model, store);
    const id = await model.createTextNow('new.tex', 'author A');
    await log.flush();
    const created = (await log.list())[0]!;
    applyTextDiff(await model.openText(id), 'author A plus later contribution');
    const result = await log.undo(created);
    expect(result?.partial).toEqual(['new.tex']);
    expect(model.byId(id)).toBeDefined();
    expect((await model.openText(id)).toString()).toBe('author A plus later contribution');
    expect((await log.undo(created))?.id).toBe(result?.id);
    await model.destroy();
  });

  it('leaves overlapping later text untouched instead of applying a fuzzy partial inverse', async () => {
    const { model, store } = await solo();
    const id = await model.createTextNow('main.tex', 'the original');
    const log = track(model, store);
    applyTextDiff(await model.openText(id), 'the replacement');
    await log.flush();
    const change = (await log.list())[0]!;
    applyTextDiff(await model.openText(id), 'the newer contribution');
    const result = await log.undo(change);
    expect(result?.partial).toEqual(['main.tex']);
    expect((await model.openText(id)).toString()).toBe('the newer contribution');
    await model.destroy();
  });

  it('reverses an AI rewrite while keeping a co-author edit made afterwards, on every device', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const id = await a.model.createTextNow('main.tex', 'Intro paragraph.\n\nMethod paragraph.\n\nEnd.');
    await converged([a, b], id);
    const log = track(a.model, a.store);
    // the AI rewrites the intro from the folder
    applyTextDiff(await a.model.openText(id), 'Intro rewritten by the AI.\n\nMethod paragraph.\n\nEnd.', MIRROR_ORIGIN);
    await waitFor(async () => (await log.list()).some((c) => c.source.kind === 'folder'));
    const aiSet = (await log.list()).find((c) => c.source.kind === 'folder')!;
    // then Bob edits the method paragraph
    const bt = await b.model.openText(id);
    await waitFor(() => bt.toString().includes('rewritten'));
    bt.insert(bt.toString().indexOf('Method paragraph') + 'Method paragraph'.length, ' (Bob)');
    await waitFor(async () => (await text(a, id)).includes('(Bob)'));

    const undo = await log.undo(aiSet);
    expect(undo).toMatchObject({ undoOf: aiSet.id, source: { kind: 'undo' } });
    expect(undo?.partial).toBeUndefined();
    const want = 'Intro paragraph.\n\nMethod paragraph (Bob).\n\nEnd.';
    expect(await text(a, id)).toBe(want);
    await waitFor(async () => (await text(b, id)) === want);
  });

  it('reports a partial undo when later edits overlap the change', async () => {
    const { model, store } = await solo();
    const id = await model.createTextNow('main.tex', 'The original sentence here.');
    const log = track(model, store);
    applyTextDiff(await model.openText(id), 'The AI sentence here.', MIRROR_ORIGIN);
    await waitFor(async () => (await log.list()).length === 1);
    const set = (await log.list())[0]!;
    applyTextDiff(await model.openText(id), 'Something completely different now.');
    const undo = await log.undo(set);
    expect(undo?.partial ?? ['main.tex']).toContain('main.tex');
  });

  it('undoes file creation, rename and deletion', async () => {
    const { model, store } = await solo();
    const keep = await model.createTextNow('keep.tex', 'k');
    const gone = await model.createTextNow('gone.tex', 'bye');
    await model.openText(gone);
    const log = track(model, store);
    await model.createTextNow('new.tex', 'fresh', MIRROR_ORIGIN);
    model.rename(keep, 'kept.tex', MIRROR_ORIGIN);
    model.delete(gone, MIRROR_ORIGIN);
    await waitFor(async () => (await log.list()).length === 1);
    await log.undo((await log.list())[0]!);
    expect(model.list().map((f) => f.path).sort()).toEqual(['gone.tex', 'keep.tex']);
    expect((await model.openText(model.find('gone.tex')?.id as string)).toString()).toBe('bye');
  });
});
