import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { expect, it } from 'vitest';
import { ROOT_DOC_ID } from '@hivetex/protocol';
import { ProjectModel, applyTextDiff } from '../src/model.js';
import { MemoryPersistence, IndexedDbPersistence, listOperations, operationStates } from '../src/persistence.js';
import { NativePersistence } from '../src/native-persistence.js';
import { fakeNative } from './native-fake.js';
import { ChangeLog } from '../src/changelog.js';
import { encodeFrame, FrameReader, type WireMessage } from '../src/worker-ipc.js';

it('upgrades a v2 browser store additively and refuses the old opener after new edits', async () => {
  const factory = new IDBFactory(), name = 'sacrificial-upgrade';
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open(name,2);
    r.onupgradeneeded = () => {
      const db = r.result; db.createObjectStore('updates',{autoIncrement:true}).createIndex('doc','docId');
      db.createObjectStore('blobs'); db.createObjectStore('snapshots',{keyPath:'id'}); db.createObjectStore('meta'); db.createObjectStore('changes',{keyPath:'id'});
    };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  await new Promise<void>((resolve,reject) => {
    const tx = old.transaction('meta','readwrite'); tx.objectStore('meta').put('retained old bytes','legacy');
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  }); old.close();
  const upgraded = await IndexedDbPersistence.open(name,factory);
  expect(await upgraded.getMeta('legacy')).toBe('retained old bytes');
  await upgraded.setMeta('new-edit','retained post-upgrade bytes'); upgraded.close();
  const downgrade = await new Promise<DOMException | null>((resolve) => { const r = factory.open(name,2); r.onerror = () => resolve(r.error); r.onsuccess = () => { r.result.close(); resolve(null); }; });
  expect(downgrade?.name).toBe('VersionError');
  const reopened = await IndexedDbPersistence.open(name,factory);
  expect(await reopened.getMeta('new-edit')).toBe('retained post-upgrade bytes'); reopened.close();
});

it('retains an acknowledged large-batch prefix and retries only its failed suffix with exact operation history', async () => {
  class FailSecond extends MemoryPersistence {
    armed = false; calls = 0;
    override async transact(ops: import('../src/persistence.js').StoreOp[]) {
      if (this.armed && ops.some((o) => o.op === 'meta' && o.key.startsWith('operation:record:')) && ++this.calls === 2) throw new Error('suffix disk full');
      return super.transact(ops);
    }
  }
  const store = new FailSecond(), model = new ProjectModel(store,{flushMs:100_000}); await model.init();
  const id = await model.createTextNow('large.tex','x'.repeat(2*1024*1024)); await model.flush();
  // Records hold deltas, not full preimages: the operations themselves must be large for the batch to be split.
  const big = (s: string) => `${s} ${'y'.repeat(1536*1024)}`;
  const body = await model.openText(id); body.insert(0,big('one')); body.insert(0,big('two')); body.insert(0,big('three'));
  store.armed = true;
  await expect(model.flush()).rejects.toThrow('suffix disk full');
  expect(model.saveState.failing).toBe(true);
  const committed = (await listOperations(store)).filter((r) => r.docId === `f:${id}`);
  expect(committed).toHaveLength(2);
  await model.flush();
  const all = (await listOperations(store)).filter((r) => r.docId === `f:${id}`);
  expect(all).toHaveLength(4); expect(new Set(all.map((r) => r.id)).size).toBe(4);
  const reopened = new ProjectModel(store); await reopened.init();
  expect((await reopened.openText(id)).toString() === body.toString()).toBe(true);
  await reopened.destroy(); await model.destroy();
});

it('saves and reopens a 7 MiB document with history through the native adapter and bounded IPC codec', async () => {
  const backend = fakeNative().invoke;
  const invoke: import('../src/native-persistence.js').StoreInvoke = async (cmd, args) => {
    const request = new FrameReader().push(encodeFrame({v:1,gen:1,kind:'req',id:1,method:'native.call',params:{cmd,args}}))[0] as Extract<WireMessage,{kind:'req'}>;
    const params = request.params as {cmd:string;args:Record<string,unknown>};
    const value = await backend(params.cmd, params.args);
    const response = new FrameReader().push(encodeFrame({v:1,gen:1,kind:'res',id:1,ok:true,result:value}))[0] as Extract<WireMessage,{kind:'res';ok:true}>;
    return response.result as any;
  };
  const store = await NativePersistence.open(invoke, 'd'.repeat(64));
  const model = new ProjectModel(store,{flushMs:100_000}); await model.init(); model.markComplete(ROOT_DOC_ID);
  const text = 'a'.repeat(7*1024*1024), id = await model.createTextNow('large.tex',text);
  await model.flush();
  const body = await model.openText(id); body.insert(0,'first '); body.insert(0,'second '); body.insert(0,'third ');
  await model.flush(); await model.destroy();
  const reopened = new ProjectModel(store); await reopened.init();
  expect((await reopened.openText(id)).toString() === `third second first ${text}`).toBe(true);
  expect((await listOperations(store)).filter((r) => r.docId === `f:${id}`)).toHaveLength(4);
  await reopened.destroy(); await store.close();
});

for (const kind of ['memory','indexeddb','sqlite'] as const) it(`${kind}: acknowledged edits survive a crash before grouping with exact preimages`, async () => {
  const store = kind === 'memory' ? new MemoryPersistence() : kind === 'indexeddb' ? await IndexedDbPersistence.open('journal', new IDBFactory()) : await NativePersistence.open(fakeNative().invoke, 'c'.repeat(64));
  const model = new ProjectModel(store, { flushMs: 100_000 }); await model.init(); model.markComplete(ROOT_DOC_ID);
  const id = await model.createTextNow('main.tex', 'before');
  const log = new ChangeLog({ model, store, idleMs: 100_000 }); log.start();
  applyTextDiff(await model.openText(id), 'after');
  await model.flush();
  // No ChangeLog.flush: simulate termination after the data acknowledgement, before the grouping timer.
  log.stop(); await model.destroy();
  const records = await listOperations(store);
  // Millisecond timestamps can tie; SQLite's key order is not a causal order. Identify the actual edit by its state.
  const fileStates = await Promise.all(records.filter((r) => r.docId === `f:${id}`).map((r) => operationStates(store, r)));
  const edits = fileStates.filter((s) => s.after.getText('t').toString() === 'after');
  expect(edits).toHaveLength(1);
  const states = edits[0]!;
  expect(states.before.getText('t').toString()).toBe('before');
  expect(states.after.getText('t').toString()).toBe('after');
  for (const s of fileStates) { s.before.destroy(); s.after.destroy(); }
  const reopened = new ProjectModel(store); await reopened.init();
  const recovered = new ChangeLog({ model: reopened, store }); recovered.start();
  const groups = await recovered.list();
  expect(groups.some((g) => g.files.some((f) => f.before === 'before' && f.after === 'after'))).toBe(true);
  const again = await recovered.list(); expect(again.map((g) => g.id)).toEqual(groups.map((g) => g.id));
  recovered.stop(); await reopened.destroy(); await store.close();
});

it('refuses a future format without changing the original store', async () => {
  const store = new MemoryPersistence(); store.meta.set('safetyFormat', { v: 99, keep: 'future' });
  const before = [...store.meta];
  await expect(new ProjectModel(store).init()).rejects.toThrow('Unsupported recovery format');
  expect([...store.meta]).toEqual(before); expect(store.docs.size).toBe(0);
});

for (const kind of ['memory','indexeddb'] as const) it(`${kind}: a metadata failure after the document append rolls back both state and journal`, async () => {
  const store = kind === 'memory' ? new MemoryPersistence() : await IndexedDbPersistence.open('atomic-journal',new IDBFactory());
  await store.append('root',[new Uint8Array([0,0])]);
  await expect(store.transact([
    {op:'append',docId:'root',updates:[new Uint8Array([1,2])]},
    {op:'meta',key:null as unknown as string,value:{v:1}},
  ])).rejects.toThrow();
  expect((await store.load('root')).map((u) => [...u])).toEqual([[0,0]]);
  expect((await store.listMetaKeys!()).length).toBe(0);
  await store.close();
});
