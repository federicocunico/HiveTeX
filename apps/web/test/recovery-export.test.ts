import { expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { decodeValue, MemoryPersistence, ProjectModel, preserveRecovery, sha256Hex, type IngressEntry } from '@hivetex/sync';
import { ArchiveTooLargeError, exportRecoveryArchive, exportRecoveryZip, memorySink, ZIP_LIMIT } from '../src/lib/recovery-export.js';
import * as Y from 'yjs';

it('archives bounded native database chunks without requesting huge history lists and includes unsaved live text', async () => {
  const store = new MemoryPersistence(), model = new ProjectModel(store); await model.init();
  const id = await model.createTextNow('main.tex','unsaved live contribution');
  const raw = new TextEncoder().encode('SQLite snapshot containing all retained history');
  let closed = false;
  Object.assign(store, { exportRawStore: async function* () { try { yield raw.slice(0, 13); yield raw.slice(13); } finally { closed = true; } } });
  store.listSnapshots = async () => { throw new Error('aggregate history exceeds IPC limit'); };
  const result = await exportRecoveryZip(model, async () => new Uint8Array());
  const files = unzipSync(result.zip), manifest = JSON.parse(strFromU8(files['.hivetex-archive/manifest.json']!));
  expect(result.missing).toEqual([]); expect(closed).toBe(true);
  const backup = manifest.entries.find((r: {kind:string}) => r.kind === 'native-store');
  expect(files[backup.file]).toEqual(raw); expect(backup.sha256).toBe(await sha256Hex(raw));
  const live = manifest.entries.find((r: {kind:string;id:string}) => r.kind === 'documents' && r.id === `f:${id}`);
  const recovered = new Y.Doc(); Y.applyUpdate(recovered,(decodeValue(strFromU8(files[live.file]!)) as {live:Uint8Array}).live);
  expect(recovered.getText('t').toString()).toBe('unsaved live contribution');
  recovered.destroy(); await model.destroy();
});

it('exports tombstones, orphan documents, private copies and immutable history with verifiable hashes', async () => {
  const store = new MemoryPersistence(), model = new ProjectModel(store); await model.init();
  const id = await model.createTextNow('deleted.tex','original deleted text'); model.delete(id);
  const orphan = new Y.Doc(); orphan.getText('t').insert(0,'legacy orphan'); await store.append('f:orphan', [Y.encodeStateAsUpdate(orphan)]);
  await preserveRecovery(store, 'private.tex',new TextEncoder().encode('private bytes'),'viewer recovery');
  await model.flush();
  const result = await exportRecoveryZip(model, async () => new Uint8Array());
  const entries = unzipSync(result.zip);
  const manifest = JSON.parse(strFromU8(entries['.hivetex-archive/manifest.json']!)) as {v:number;entries:Array<{file:string;kind:string;id:string;sha256:string}>};
  expect(manifest.v).toBe(1); expect(result.missing).toEqual([]);
  for (const record of manifest.entries) expect(await sha256Hex(entries[record.file]!)).toBe(record.sha256);
  expect(manifest.entries.some((r) => r.kind === 'documents' && r.id === 'f:orphan')).toBe(true);
  expect(manifest.entries.some((r) => r.kind === 'metadata' && r.id.startsWith('operation:record:'))).toBe(true);
  expect(manifest.entries.some((r) => r.kind === 'metadata' && r.id.startsWith('recovery:record:'))).toBe(true);
  const root = manifest.entries.find((r) => r.kind === 'documents' && r.id === 'root')!;
  const state = decodeValue(strFromU8(entries[root.file]!)) as {live:Uint8Array};
  const back = new Y.Doc(); Y.applyUpdate(back,state.live);
  expect(back.getMap('files').has(id)).toBe(false);
  expect((back.getMap('tombstones').get(id) as {v:number}|undefined)?.v).toBe(1);
  orphan.destroy();back.destroy();await model.destroy();
});

it('exports denied native input losslessly without overwriting a same-named project file or applying it', async () => {
  const model = new ProjectModel(new MemoryPersistence());
  await model.init();
  await model.createTextNow('.hivetex-recovery/ingress.json', 'the actual project file');
  const entry: IngressEntry = { attachment: 'old', seq: 3, docId: 'f:old', update: new Uint8Array([0, 127, 255]), source: 'folder', denied: true };
  const result = await exportRecoveryZip(model, async () => { throw new Error('missing'); }, async () => [entry]);
  const files = unzipSync(result.zip);
  expect(strFromU8(files['.hivetex-recovery/ingress.json']!)).toBe('the actual project file');
  const recovery = decodeValue(strFromU8(files['.hivetex-recovery-1/ingress.json']!)) as { version: number; entries: IngressEntry[]; bases: Array<{ docId: string; file: string }> };
  expect(recovery.version).toBe(1); expect(recovery.entries).toEqual([entry]);
  expect(recovery.bases[0]?.docId).toBe(entry.docId);
  expect(files[recovery.bases[0]!.file]).toBeDefined();
  expect(model.list()).toHaveLength(1);
  expect(result.missing).toEqual([]);
  await model.destroy();
});

it('restores an exported denied edit offline using the included Yjs base while leaving the shared model unchanged', async () => {
  const model = new ProjectModel(new MemoryPersistence());
  await model.init(); const id = await model.createTextNow('main.tex', 'base');
  const docId = `f:${id}`, original = await model.getDoc(docId), denied = new Y.Doc();
  Y.applyUpdate(denied, Y.encodeStateAsUpdate(original));
  const vector = Y.encodeStateVector(denied);
  denied.getText('t').insert(4, ' denied');
  const entry: IngressEntry = { attachment: 'old', seq: 1, docId, update: Y.encodeStateAsUpdate(denied, vector), denied: true };
  const result = await exportRecoveryZip(model, async () => new Uint8Array(), async () => [entry]);
  const files = unzipSync(result.zip);
  const journal = decodeValue(strFromU8(files['.hivetex-recovery/ingress.json']!)) as { entries: IngressEntry[]; bases: Array<{ docId: string; file: string }> };
  const recovered = new Y.Doc();
  Y.applyUpdate(recovered, files[journal.bases[0]!.file]!);
  for (const e of journal.entries) Y.applyUpdate(recovered, e.update);
  expect(recovered.getText('t').toString()).toBe('base denied');
  expect((await model.openText(id)).toString()).toBe('base');
  recovered.destroy(); denied.destroy(); await model.destroy();
});

it('keeps readable files and reports an unavailable native journal instead of silently omitting it', async () => {
  const model = new ProjectModel(new MemoryPersistence());
  await model.init(); await model.createTextNow('main.tex', 'unsaved copy');
  model.durabilityError('change-history', new Error('history disk full'));
  const result = await exportRecoveryZip(model, async () => new Uint8Array(), async () => { throw new Error('worker gone'); });
  const files = unzipSync(result.zip);
  expect(strFromU8(files['main.tex']!)).toBe('unsaved copy');
  expect(result.missing).toContain('native pending edit journal');
  expect(result.missing.some((item) => item.startsWith('uncommitted operation history'))).toBe(true);
  expect(strFromU8(files['RECOVERY-MISSING.txt']!)).toContain('native pending edit journal');
  model.durabilityError('change-history', null);
  await model.destroy();
});

it('refuses an archive estimated over the ZIP limit before opening the destination, and releases the database copy (5.5)', async () => {
  const store = new MemoryPersistence(), model = new ProjectModel(store); await model.init();
  await model.createTextNow('main.tex', 'text');
  let read = false, closed = false, opened = false;
  Object.assign(store, { openRawExport: async () => ({ size: ZIP_LIMIT, chunks: (async function* () { read = true; yield new Uint8Array(1); })(), close: async () => { closed = true; } }) });
  await expect(exportRecoveryArchive(model, async () => new Uint8Array(), undefined, store, [], async () => { opened = true; return memorySink(); }))
    .rejects.toBeInstanceOf(ArchiveTooLargeError);
  expect(opened).toBe(false); expect(read).toBe(false); expect(closed).toBe(true);
  await model.destroy();
});

it('streams a native database copy in bounded pieces with an incremental hash that the manifest verifies (5.5)', async () => {
  const store = new MemoryPersistence(), model = new ProjectModel(store); await model.init();
  await model.createTextNow('main.tex', 'text');
  const piece = 1024 * 1024, count = 6;
  const make = (n: number) => { const b = new Uint8Array(piece); for (let i = 0; i < piece; i++) b[i] = (i * 31 + n) & 0xff; return b; };
  let inFlight = 0, maxAhead = 0, closed = false;
  const sink = memorySink(), writes: number[] = [];
  const write = sink.write.bind(sink);
  sink.write = async (chunk) => { writes.push(chunk.length); inFlight = 0; return write(chunk); };
  Object.assign(store, { openRawExport: async () => ({ size: piece * count, close: async () => { closed = true; }, chunks: (async function* () {
    for (let n = 0; n < count; n++) { inFlight++; maxAhead = Math.max(maxAhead, inFlight); yield make(n); }
  })() }) });
  const result = await exportRecoveryArchive(model, async () => new Uint8Array(), undefined, store, [], async () => sink);
  expect(result.missing).toEqual([]); expect(closed).toBe(true);
  // The copy is written as it is read: never more than one database piece waits for the destination.
  expect(maxAhead).toBe(1);
  const files = unzipSync(sink.bytes());
  const manifest = JSON.parse(strFromU8(files['.hivetex-archive/manifest.json']!)) as {entries:Array<{file:string;kind:string;sha256:string}>};
  const copy = manifest.entries.find((r) => r.kind === 'native-store')!;
  expect(files[copy.file]!.length).toBe(piece * count);
  for (const r of manifest.entries) expect(await sha256Hex(files[r.file]!)).toBe(r.sha256);
  const whole = new Uint8Array(piece * count); for (let n = 0; n < count; n++) whole.set(make(n), n * piece);
  expect(copy.sha256).toBe(await sha256Hex(whole));
  await model.destroy();
});
