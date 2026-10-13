// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { ROOT_DOC_ID } from '@hivetex/protocol';
import { IndexedDbPersistence, ProjectModel } from '@hivetex/sync';
import { describe, expect, it } from 'vitest';
import { createLocalProject, listLocalProjects, publishLocalProject } from '../src/lib/local-projects.js';
import type { ProjectInfo } from '../src/lib/session.svelte.js';

describe('publishing a local project', () => {
  it('creates the shared project, copies files and history to it, then forgets the local copy', async () => {
    const local = createLocalProject('Thesis');
    const store = await IndexedDbPersistence.open(`hivetex-project-${local.id}`);
    const model = new ProjectModel(store, { flushMs: 1 });
    await model.init();
    model.markComplete(ROOT_DOC_ID);
    const id = await model.createTextNow('main.tex', '\documentclass{article}\n');
    const snapshot = await model.captureSnapshot();
    await model.flush();
    await store.putBlob('h1', new Uint8Array([1, 2, 3]));
    store.close();

    const calls: string[] = [];
    const info = await publishLocalProject(local, async () => {
      calls.push('create');
      return { id: 'srv1', slug: 'thesis-abcdefghijklmnop', role: 'owner', defaultRole: 'editor', passwordProtected: true, epoch: 1 } as ProjectInfo;
    });
    expect(calls).toEqual(['create']);
    expect(info.id).toBe('srv1');

    const shared = await IndexedDbPersistence.open('hivetex-project-srv1');
    const copy = new ProjectModel(shared);
    await copy.init();
    expect((await shared.listSnapshots()).map((item) => item.id)).toEqual([snapshot.id]);
    expect(copy.byId(id)?.path).toBe('main.tex'); // same file id: same history
    expect((await copy.openText(id)).toString()).toBe('\documentclass{article}\n');
    expect(Array.from((await shared.getBlob('h1')) ?? [])).toEqual([1, 2, 3]);
    shared.close();
    expect(listLocalProjects().map((p) => p.id)).not.toContain(local.id);
    expect(JSON.parse(localStorage.getItem('hivetex.proj.srv1') as string).slug).toBe('thesis-abcdefghijklmnop');
  });

  it('leaves the local project untouched when the server refuses', async () => {
    const local = createLocalProject('Paper');
    await expect(publishLocalProject(local, async () => Promise.reject(new Error('ID unavailable')), 'u1')).rejects.toThrow('ID unavailable');
    expect(listLocalProjects().map((p) => p.id)).toContain(local.id);
  });
});
