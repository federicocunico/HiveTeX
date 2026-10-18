import { expect, it } from 'vitest';
import { ROOT_DOC_ID } from '@hivetex/protocol';
import { ProjectModel, applyTextDiff } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';
async function project() { const store = new MemoryPersistence(); const model = new ProjectModel(store); await model.init(); model.markComplete(ROOT_DOC_ID); return { model, store }; }

for (const phase of ['checkpoint', 'prepared', 'committed', 'completed'] as const) it(`reopens durably at restore phase ${phase} without losing the recovery point or applying twice`, async () => {
  const { model, store } = await project();
  const id = await model.createTextNow('main.tex', 'target'); const target = await model.captureSnapshot();
  applyTextDiff(await model.openText(id), 'current contribution'); await model.flush();
  const plan = await model.previewRestore(target.id);
  let reached!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const snapshot = store.putSnapshot.bind(store), meta = store.setMeta.bind(store), transact = store.transact.bind(store);
  store.putSnapshot = async (value) => { await snapshot(value); if (phase === 'checkpoint') { reached(); await gate; } };
  store.setMeta = async (key, value) => { await meta(key, value); if (phase === 'prepared' && key.startsWith('restore:pending:')) { reached(); await gate; } };
  store.transact = async (ops) => {
    const completion = ops.some((o) => o.op === 'meta' && o.key.startsWith('restore:pending:'));
    if (completion && phase === 'committed') { reached(); await gate; }
    await transact(ops);
    if (completion && phase === 'completed') { reached(); await gate; }
  };
  const restoring = model.restore(target.id, () => true, plan.revision, plan.requestId);
  await arrived;
  // Only the committed store survives process termination; pending model updates are deliberately not copied.
  const copy = new MemoryPersistence();
  copy.docs = structuredClone(store.docs); copy.meta = structuredClone(store.meta); copy.blobs = structuredClone(store.blobs);
  copy.snaps = structuredClone(store.snaps); copy.changes = structuredClone(store.changes);
  const reopened = new ProjectModel(copy); await reopened.init();
  const state = (await reopened.openText(id)).toString();
  expect(state).toBe(phase === 'committed' || phase === 'completed' ? 'target' : 'current contribution');
  expect((await copy.listSnapshots()).some((s) => s.id !== target.id && s.files.some((f) => f.text === 'current contribution'))).toBe(true);
  if (phase === 'prepared' || phase === 'committed') {
    // 5.3: the interrupted request is listed and completes on retry, keeping the original recovery point.
    const [pending] = await reopened.interruptedRestores();
    expect(pending?.requestId).toBe(plan.requestId);
    await reopened.restore(target.id, () => true, undefined, plan.requestId);
    expect((await reopened.openText(id)).toString()).toBe('target');
    expect(await reopened.interruptedRestores()).toEqual([]);
    expect(((await copy.getMeta(`restore:pending:${plan.requestId}`)) as { undoId: string }).undoId).toBe(pending!.undoId);
  }
  if (phase === 'completed') {
    const revision = reopened.changeSeq;
    await reopened.restore(target.id, () => true, undefined, plan.requestId);
    expect(reopened.changeSeq).toBe(revision);
  }
  release(); await restoring; await model.destroy(); await reopened.destroy();
});

it('prunes display groups without dropping tombstones, old exact assets, snapshots or operation evidence', async () => {
  const { model, store } = await project();
  const id = await model.createTextNow('retained.tex', 'exact old text'); model.delete(id);
  const bytes = new TextEncoder().encode('exact old binary'); await store.putBlob('retained-binary', bytes);
  await model.flush(); const records = (await store.listMetaKeys()).filter((k) => k.startsWith('operation:record:'));
  const snapshot = await model.captureSnapshot();
  for (let n = 0; n < 501; n++) await store.putChangeSet({id:`old-${n}`,source:{kind:'editor',name:'old'},startedAt:n,endedAt:n,files:[]});
  expect(await store.pruneChangeSets(Date.now())).toBe(1);
  expect((await store.listChangeSets()).length).toBe(500);
  expect((await model.openText(id)).toString()).toBe('exact old text'); expect(model.deletedFiles()[0]?.id).toBe(id);
  expect(await store.getBlob('retained-binary')).toEqual(bytes);
  expect((await store.listMetaKeys()).filter((k) => k.startsWith('operation:record:'))).toEqual(records);
  expect((await store.listSnapshots())[0]?.id).toBe(snapshot.id); await model.destroy();
});

it('captures one coherent lazy state with settings and restores it once with a durable recovery point', async () => {
  const { model, store } = await project();
  const a = await model.createTextNow('a.tex', 'old A'), b = await model.createTextNow('b.tex', 'old B');
  model.settings.set('main','a.tex'); model.settings.set('engine','xelatex');
  const snapshot = await model.captureSnapshot();
  applyTextDiff(await model.openText(a), 'new A'); applyTextDiff(await model.openText(b), 'new B');
  model.settings.set('main','b.tex'); model.settings.set('engine','pdflatex');
  const plan = await model.previewRestore(snapshot.id);
  const [first, duplicate] = await Promise.all([model.restore(snapshot.id, () => true, plan.revision, plan.requestId), model.restore(snapshot.id, () => true, plan.revision, plan.requestId)]);
  expect(duplicate).toEqual(first); expect((await model.openText(a)).toString()).toBe('old A');
  expect(model.settings.toJSON()).toEqual({ main:'a.tex',engine:'xelatex' });
  expect((await store.listSnapshots()).find((s) => s.id === first.undoId)?.files.find((f) => f.path === 'a.tex')?.text).toBe('new A');
  await model.destroy();
});

it('refuses remote edits after the preview and revocation during preparation before replacing any file', async () => {
  const { model } = await project();
  const id = await model.createTextNow('main.tex','original'); const snapshot = await model.captureSnapshot();
  const plan = await model.previewRestore(snapshot.id);
  applyTextDiff(await model.openText(id),'later contribution');
  await expect(model.restore(snapshot.id,()=>true,plan.revision,plan.requestId)).rejects.toThrow('changed after restore preview');
  expect((await model.openText(id)).toString()).toBe('later contribution');
  await expect(model.restore(snapshot.id,()=>false)).rejects.toThrow('denied');
  expect((await model.openText(id)).toString()).toBe('later contribution'); await model.destroy();
});

it('refuses missing assets and exposes prepared recovery after an interrupted commit', async () => {
  const { model, store } = await project();
  const id = await model.createTextNow('main.tex','current');
  await store.putSnapshot({ id:'missing',at:0,files:[{path:'fig.png',kind:'binary',hash:'f'.repeat(64),size:5}] });
  await expect(model.restore('missing')).rejects.toThrow('asset is unavailable');
  expect((await model.openText(id)).toString()).toBe('current');
  const undo = await model.captureSnapshot();
  await store.setMeta('restore:pending:interrupted',{v:1,stage:'prepared',snapshotId:undo.id,undoId:undo.id,revision:model.changeSeq});
  expect((await model.interruptedRestores()).map((r) => r.requestId)).toEqual(['interrupted']);
  await model.restore(undo.id,()=>true,model.changeSeq,'interrupted');
  expect((await model.openText(id)).toString()).toBe('current'); expect(await model.interruptedRestores()).toEqual([]); await model.destroy();
});

it('captures text synchronously after lazy loads and refuses an incomplete project', async () => {
  const { model } = await project();
  const a = await model.createTextNow('a.tex', 'before A'), b = await model.createTextNow('b.tex', 'before B');
  const open = model.openText.bind(model);
  let changed = false;
  model.openText = async (id) => {
    if (id === b && !changed) { changed = true; applyTextDiff(await open(a), 'after A'); applyTextDiff(await open(b), 'after B'); }
    return open(id);
  };
  const snapshot = await model.captureSnapshot();
  expect(snapshot.files.filter((f) => f.kind === 'text').map((f) => f.text)).toEqual(['after A', 'after B']);
  model.putEntry('unreceived', { path: 'missing.tex', kind: 'text' });
  await expect(model.captureSnapshot()).rejects.toThrow();
  await model.destroy();
});
