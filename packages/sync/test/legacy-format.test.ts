import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { ROOT_DOC_ID } from '@hivetex/protocol';
import { sign, toB64u } from '@hivetex/crypto';
import { MemoryPersistence } from '../src/persistence.js';
import { ProjectModel } from '../src/model.js';
import { ChangeLog } from '../src/changelog.js';
import { TestAuthority, identity } from '../src/testkit.js';
import { type AuthoredOperation, verifyOperation } from '../src/authorship.js';
import { projectAuthoredOperation } from '../src/history-projection.js';

/**
 * Stores written by the first apply of audit-sync-data-safety (never released): journal records with a full preimage
 * (v1), tombstones as a `deleted` field inside `files`, and signed envelopes carrying `before` (v1). They reopen with
 * the same Changes and Recovery, are converted where needed, and the old shapes are never written again.
 */
it('reopens an apply-format store with identical Changes and Recovery, converting tombstones once', async () => {
  const store = new MemoryPersistence();
  // Root as the apply wrote it: main.tex live, gone.tex deleted in place.
  const root = new Y.Doc();
  const deletion = { v: 1, id: 'del1', at: 1_000, path: 'gone.tex', author: { kind: 'editor', name: 'Alice', uid: 'u-Alice', device: 'd-A' } };
  root.transact(() => {
    const files = root.getMap<Y.Map<unknown>>('files');
    const main = new Y.Map<unknown>(); main.set('path', 'main.tex'); main.set('kind', 'text'); files.set('main1', main);
    const gone = new Y.Map<unknown>(); gone.set('path', 'gone.tex'); gone.set('kind', 'text'); gone.set('deleted', deletion); files.set('gone1', gone);
  });
  await store.append(ROOT_DOC_ID, [Y.encodeStateAsUpdate(root)]);
  const text = new Y.Doc(); text.getText('t').insert(0, 'before');
  const before = Y.encodeStateAsUpdate(text), sv = Y.encodeStateVector(text);
  text.transact(() => { text.getText('t').delete(0, 6); text.getText('t').insert(0, 'after'); });
  const update = Y.encodeStateAsUpdate(text, sv);
  await store.append('f:main1', [Y.encodeStateAsUpdate(text)]);
  const goneText = new Y.Doc(); goneText.getText('t').insert(0, 'retained');
  await store.append('f:gone1', [Y.encodeStateAsUpdate(goneText)]);
  await store.transact([
    { op: 'meta', key: 'operation:bytes:r1:before:0', value: before },
    { op: 'meta', key: 'operation:bytes:r1:update:0', value: update },
    { op: 'meta', key: 'operation:record:r1', value: { v: 1, id: 'r1', docId: 'f:main1', at: 2_000, source: { kind: 'editor', name: 'Alice' }, beforeChunks: 1, updateChunks: 1, state: 'applied' } },
    { op: 'meta', key: 'safetyFormat', value: { v: 1 } },
  ]);
  const recordKeys = () => [...store.meta.keys()].filter((k) => k.startsWith('operation:record:'));

  for (let open = 0; open < 2; open++) {
    const model = new ProjectModel(store); await model.init(); model.markComplete(ROOT_DOC_ID);
    // Recovery: the same deleted file, deletion token and author; nothing of it left inside `files`.
    expect(model.list().map((f) => f.path)).toEqual(['main.tex']);
    expect(model.deletedFiles()).toMatchObject([{ id: 'gone1', path: 'gone.tex', deletion }]);
    expect([...model.files.keys()]).toEqual(['main1']);
    expect(model.tombstones.get('gone1')).toMatchObject({ v: 1, entry: { path: 'gone.tex', kind: 'text' }, deletion });
    // Changes: the v1 record is read as a snapshot, exactly as the apply showed it.
    const log = new ChangeLog({ model, store }); log.start();
    const groups = await log.list();
    expect(groups.filter((g) => g.operationIds?.includes('r1'))).toMatchObject([{ files: [{ fileId: 'main1', path: 'main.tex', op: 'edit', before: 'before', after: 'after' }] }]);
    log.stop();
    if (open === 1) {
      model.restoreDeleted('gone1', 'del1');
      expect(model.byId('gone1')?.path).toBe('gone.tex');
      expect((await model.openText('gone1')).toString()).toBe('retained');
    }
    await model.flush(); await model.destroy();
  }
  // New records use the delta format; the v1 record is untouched.
  const records = recordKeys().map((k) => store.meta.get(k) as { v: number; id: string; beforeChunks?: number });
  expect(records.find((r) => r.id === 'r1')).toMatchObject({ v: 1, beforeChunks: 1 });
  expect(records.filter((r) => r.id !== 'r1').every((r) => r.v === 2 && r.beforeChunks === undefined)).toBe(true);
});

it('still verifies and projects a v1 signed envelope that carries a full preimage, and never signs one', async () => {
  const auth = await TestAuthority.create(), writer = await identity('Alice', 'editor');
  const ticket = await auth.mint({ pid: 'p', uid: writer.uid, uname: writer.uname, dev: writer.dev, keys: writer.keys, role: writer.role });
  const doc = new Y.Doc(); doc.getText('t').insert(0, 'old');
  const before = Y.encodeStateAsUpdate(doc), sv = Y.encodeStateVector(doc);
  doc.getText('t').insert(3, ' text');
  const update = Y.encodeStateAsUpdate(doc, sv);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', update as Uint8Array<ArrayBuffer>)), (x) => x.toString(16).padStart(2, '0')).join('');
  const op: Omit<AuthoredOperation, 'signature'> = { v: 1, id: 'legacy-op', pid: 'p', docId: 'f:x', at: Date.now(), uid: writer.uid, device: writer.dev, source: 'editor', dependencies: [], hash: digest, update: toB64u(update), before: toB64u(before), ticket };
  const layout = ['hivetex/authored-operation/v1', op.id, op.pid, op.docId, op.at, op.uid, op.device, op.source, op.dependencies, op.hash, op.update, op.before, op.ticket];
  const signed = { ...op, signature: toB64u(await sign(writer.keys, new TextEncoder().encode(JSON.stringify(layout)))) } as AuthoredOperation;
  const { claims } = await verifyOperation(signed, 'p', auth.trusted, { historical: true });
  expect(projectAuthoredOperation(signed, claims).files).toMatchObject([{ op: 'edit', before: 'old', after: 'old text' }]);
  // Tampering with the signed preimage breaks the v1 signature.
  await expect(verifyOperation({ ...signed, before: toB64u(update) }, 'p', auth.trusted, { historical: true })).rejects.toThrow();
});
