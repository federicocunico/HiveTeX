import { generateDeviceKeys } from '@hivetex/crypto';
import { expect, it } from 'vitest';
import { WorkerProjects, type ProjectOpen } from '../src/worker/projects.js';
import { ProjectRuntime, type RuntimeAdapters } from '../src/runtime.js';
import { MemoryPersistence } from '../src/persistence.js';
import { MemoryIngressJournal } from '../src/ingress.js';

it('clears editor awareness only on last detach and retains optional seed availability', async () => {
  const keys = await generateDeviceKeys();
  const project: ProjectOpen = {
    server: 'http://localhost:3000', account: 'a', project: 'local-p',
    scope: 'local-p', role: 'editor', isLocal: true, createdHere: true,
  };
  const host = new WorkerProjects({
    emit: () => {},
    create: async () => {
      const store = new MemoryPersistence();
      const runtime = new ProjectRuntime({
        projectId: project.project, isLocal: true, createdHere: true,
        role: 'editor', keys, deviceId: 'device-1', canWrite: () => true,
        store, adapters: {} as RuntimeAdapters,
      });
      await runtime.open();
      return { runtime, store, journal: new MemoryIngressJournal(), close: async () => {
        await runtime.close(); await runtime.model.destroy();
      } };
    },
  });
  await host.open(project, 'one');
  const background = host.registry.attach(project, 'background');
  const actor = await background.runtime;
  await host.open(project, 'two');
  const editing = { user: { name: 'ann' }, file: 'main.tex', cursor: { anchor: 3 }, deviceId: 'device-1', seed: false };
  actor.runtime.mesh.awareness.setLocalState(editing);
  await host.detach('one');
  expect(actor.runtime.mesh.awareness.getLocalState()).toEqual(editing);
  await host.detach('two');
  expect(actor.runtime.mesh.awareness.getLocalState()).toEqual({ seed: true, deviceId: 'device-1' });
  expect(host.registry.demand(project)).toEqual(['background']);
  await host.open(project, 'reopened');
  actor.runtime.mesh.awareness.setLocalState(editing);
  expect(actor.runtime.mesh.awareness.getLocalState()?.seed).toBe(false);
  await host.detach('reopened');
  await background.release();
  await host.stop();
});
