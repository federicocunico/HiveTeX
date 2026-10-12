import { describe, expect, it } from 'vitest';
import { ActorConflicts } from '../src/editor-bridge.js';
import { OfflineFork } from '../src/fork.js';
import { ProjectModel } from '../src/model.js';
import { MemoryPersistence } from '../src/persistence.js';

/** 7.3: revision-checked conflict resolution through the actor. */
async function world(role: { edit: boolean } = { edit: true }) {
  const store = new MemoryPersistence();
  const model = new ProjectModel(store, { flushMs: 2 });
  await model.init();
  const id = await model.createTextNow('main.tex', 'shared text\n');
  const fork = () => new OfflineFork({ model, isLinked: () => true, canEdit: () => role.edit, confirm: async () => 'confirmed' });
  const f = fork();
  await f.start();
  await f.mergeIn([{ path: 'main.tex', kind: 'text', text: 'my offline text\n' }]);
  return { store, model, id, fork: f, makeFork: fork, role, conflicts: new ActorConflicts({ fork: f, canApply: () => role.edit }) };
}

describe('actor conflict resolution (7.3)', () => {
  it('a reloaded renderer sees the same conflict revision and can resolve with it', async () => {
    const w = await world();
    const shown = w.conflicts.list()[0];
    const afterReload = w.conflicts.list()[0];
    expect(afterReload?.rev).toBe(shown?.rev);
    expect(await w.conflicts.resolveText(shown?.id as string, shown?.rev as string, ['mine'])).toBe('resolved');
    expect((await w.model.openText(w.id)).toString()).toBe('my offline text\n');
    expect(w.conflicts.list()).toEqual([]);
  });

  it('a resolution based on what an older renderer showed is refused as stale and publishes nothing', async () => {
    const w = await world();
    const shown = w.conflicts.list()[0] as ReturnType<ActorConflicts['list']>[number];
    // Another attachment resolved it first: the late answer must not apply anything.
    expect(await w.conflicts.resolveText(shown.id, shown.rev, ['theirs'])).toBe('resolved');
    const before = (await w.model.openText(w.id)).toString();
    expect(await w.conflicts.resolveText(shown.id, shown.rev, ['mine'])).toBe('not-found');
    expect((await w.model.openText(w.id)).toString()).toBe(before);
    // A conflict that changed since it was shown (re-merged after the others edited) refuses the old revision.
    const w2 = await world();
    const old = w2.conflicts.list()[0] as ReturnType<ActorConflicts['list']>[number];
    const c = w2.fork.conflicts[0] as { theirsAtMerge: string };
    c.theirsAtMerge = 'changed meanwhile\n';
    expect(await w2.conflicts.resolveText(old.id, old.rev, ['mine'])).toBe('stale');
    expect((await w2.model.openText(w2.id)).toString()).toBe('shared text\n');
  });

  it('a demoted member cannot publish a resolution, and conflicts survive an interrupted session with stable revisions', async () => {
    const w = await world();
    const shown = w.conflicts.list()[0] as ReturnType<ActorConflicts['list']>[number];
    w.role.edit = false;
    expect(await w.conflicts.resolveText(shown.id, shown.rev, ['mine'])).toBe('denied');
    expect((await w.model.openText(w.id)).toString()).toBe('shared text\n');
    // The session ends before the decision; a new fork on the same store restores the same conflict.
    w.fork.stop();
    w.role.edit = true;
    const again = w.makeFork();
    await again.start();
    const restored = new ActorConflicts({ fork: again, canApply: () => true }).list()[0];
    expect(restored?.rev).toBe(shown.rev);
  });
});
