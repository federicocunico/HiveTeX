import { expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { decodeValue, MemoryPersistence, ProjectModel, type IngressEntry } from '@hivetex/sync';
import { exportRecoveryZip } from '../src/lib/recovery-export.js';
import * as Y from 'yjs';

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
  const result = await exportRecoveryZip(model, async () => new Uint8Array(), async () => { throw new Error('worker gone'); });
  const files = unzipSync(result.zip);
  expect(strFromU8(files['main.tex']!)).toBe('unsaved copy');
  expect(result.missing).toContain('native pending edit journal');
  expect(strFromU8(files['RECOVERY-MISSING.txt']!)).toContain('native pending edit journal');
  await model.destroy();
});
