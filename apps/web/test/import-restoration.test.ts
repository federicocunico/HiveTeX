// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { MemoryPersistence, ProjectModel, listRecovery, readRecovery } from '@hivetex/sync';
import { zipSync, strToU8 } from 'fflate';
import { ProjectSession } from '../src/lib/session.svelte.js';
import { readArchive } from '../src/lib/import/sources.js';
import { planFor } from '../src/lib/import/apply.js';
import * as Y from 'yjs';

beforeEach(() => localStorage.clear());

it('restores a legacy incomplete root only after explicit full replacement and retains its local CRDT history', async () => {
  const store = new MemoryPersistence();
  const model = new ProjectModel(store);
  await model.init();
  const oldId = await model.createTextNow('old.tex', 'valuable local work');
  const session = new ProjectSession({ id: 'old-project', slug: 'old', role: 'owner', defaultRole: 'editor', passwordProtected: false }, { id: 'u', username: 'user' });
  session.model = model; session.store = store; session.files = model.list();
  session.blobs = { add: async () => { throw new Error('no binary in this import'); } } as any;
  const bundle = readArchive('restored.zip', zipSync({ 'main.tex': strToU8('complete original source') }));
  const plan = await planFor(model, bundle);
  expect(model.availability('root')).toBe('partial');
  await session.applyImport(plan, { mode: 'replace', resolutions: new Map(), defaultResolution: 'overwrite', main: 'main.tex' });
  expect(model.availability('root')).toBe('complete');
  expect(model.list().map(f => f.path)).toEqual(['main.tex']);
  const kept = (await listRecovery(store)).find(r => r.fileId === oldId)!;
  const before = new Y.Doc(); Y.applyUpdate(before, await readRecovery(store, kept.id));
  expect(before.getText('t').toString()).toBe('valuable local work');
  expect(model.deletedFiles().some(f => f.id === oldId)).toBe(true);
  await model.destroy();
});
