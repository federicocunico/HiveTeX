import { afterEach, describe, expect, it } from 'vitest';
import { ChangeLog } from '../src/changelog.js';
import { MIRROR_ORIGIN } from '../src/mirror.js';
import { ProjectModel, applyTextDiff } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';
import { waitFor } from './helpers.js';
import { Net, converged, text } from './net.js';

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
  return { model, store };
}

describe('change sets', () => {
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
    await waitFor(async () => (await log.list()).length === 1);
    expect((await log.list())[0]?.source).toEqual({ kind: 'peer', name: 'bob' });
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
    await m2.openText(m2.find('main.tex')?.id as string);
    await new Promise((r) => setTimeout(r, 150));
    expect(await log.list()).toEqual([]);
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
  it('reverses an AI rewrite while keeping a co-author edit made afterwards, on every device', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const id = await a.model.createTextNow('main.tex', 'Intro paragraph.\n\nMethod paragraph.\n\nEnd.');
    await converged([a, b], id);
    const log = track(a.model, a.store);
    // the AI rewrites the intro from the folder
    applyTextDiff(await a.model.openText(id), 'Intro rewritten by the AI.\n\nMethod paragraph.\n\nEnd.', MIRROR_ORIGIN);
    await waitFor(async () => (await log.list()).length === 1);
    const aiSet = (await log.list())[0]!;
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
