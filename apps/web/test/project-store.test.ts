// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { IndexedDbPersistence, ProjectModel, storeDigest } from '@hivetex/sync';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeNative } from '../../../packages/sync/test/native-fake.js';

/**
 * 5.5/5.6: the desktop's project stores, with the native store commands faked (their SQLite side is tested in Rust).
 * Covers the documented recovery procedure: an interrupted migration falls back to the legacy store and resumes on
 * the next open; turning the feature off never reopens a stale copy; a downgrade first exports back to IndexedDB.
 */
const world = vi.hoisted(() => ({ invoke: null as null | ((cmd: string, a?: Record<string, unknown>) => Promise<unknown>), manifests: new Map<string, string>(), failTransactAt: 0, transacts: 0 }));
vi.mock('../src/lib/api.js', async (orig) => ({ ...(await orig<typeof import('../src/lib/api.js')>()), isDesktop: true, apiBase: () => 'https://hivetex.example', sessionOrigin: () => 'https://hivetex.example' }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, a: Record<string, unknown> = {}) => {
    if (cmd === 'migration_manifest_read') return world.manifests.get(a.project as string) ?? null;
    if (cmd === 'migration_manifest_write') return void world.manifests.set(a.project as string, a.json as string);
    if (cmd === 'store_transact' && world.failTransactAt && ++world.transacts === world.failTransactAt) throw new Error('disk full');
    return world.invoke?.(cmd, a);
  },
}));
import { exportToLegacy, openProjectStore, removeProjectStore, hasNativeProjectStore, MigrationAssociationRequired,
  confirmLegacyAssociation, exportLegacyRecovery } from '../src/lib/project-store.js';

const ref = { kind: 'shared' as const, project: 'proj-1', account: 'ann' };
async function legacyProject(texts = 3, associated = true) {
  const store = await IndexedDbPersistence.open('hivetex-project-proj-1');
  const model = new ProjectModel(store, { flushMs: 1 });
  await model.init();
  const ids: string[] = [];
  for (let i = 0; i < texts; i++) ids.push(await model.createTextNow(`ch${i}.tex`, `chapter ${i}`));
  await model.flush();
  if (associated) await store.setMeta('storeAssociation', { server: 'https://hivetex.example', account: 'ann' });
  store.close();
  return ids;
}
const textIn = async (store: import('@hivetex/sync').Persistence, id: string) => {
  const m = new ProjectModel(store, { flushMs: 1 });
  await m.init();
  return (await m.openText(id)).toString();
};

beforeEach(async () => {
  world.invoke = fakeNative().invoke as never;
  world.manifests.clear();
  world.failTransactAt = 0;
  world.transacts = 0;
  localStorage.clear();
  await new Promise<void>((r) => { const q = indexedDB.deleteDatabase('hivetex-project-proj-1'); q.onsuccess = q.onerror = () => r(); });
});

describe('desktop project stores (5.5, 5.6)', () => {
  it('migrates a legacy project on first open and opens the native store afterwards', async () => {
    const ids = await legacyProject();
    const first = await openProjectStore(ref);
    expect(first.kind).toBe('native');
    expect(await textIn(first.store, ids[1] as string)).toBe('chapter 1');
    first.store.close();
    expect(JSON.parse([...world.manifests.values()][0] as string)).toMatchObject({ state: 'done', active: 'native', association: { server: 'https://hivetex.example', account: 'ann' } });
    const again = await openProjectStore(ref);
    expect(again.kind).toBe('native');
    again.store.close();
  });

  it('recovery: an interrupted migration keeps the legacy store working and completes on a later open', async () => {
    const ids = await legacyProject();
    world.failTransactAt = 2;
    const interrupted = await openProjectStore(ref);
    expect(interrupted.kind).toBe('indexeddb');
    expect(interrupted.migrationError).toBeTruthy();
    // The member keeps working on the legacy store meanwhile.
    const m = new ProjectModel(interrupted.store, { flushMs: 1 });
    await m.init();
    (await m.openText(ids[0] as string)).insert(0, 'edited meanwhile: ');
    await m.flush();
    interrupted.store.close();
    world.failTransactAt = 0;
    let opened = await openProjectStore(ref);
    // The source changed after the partial copy: the copy restarts and is verified again (at most one more open).
    if (opened.kind !== 'native') {
      opened.store.close();
      opened = await openProjectStore(ref);
    }
    expect(opened.kind).toBe('native');
    expect(await textIn(opened.store, ids[0] as string)).toBe('edited meanwhile: chapter 0');
    opened.store.close();
  });

  it('turning the feature off never reopens the stale legacy copy of a migrated project', async () => {
    const ids = await legacyProject();
    const n = await openProjectStore(ref);
    const m = new ProjectModel(n.store, { flushMs: 1 });
    await m.init();
    (await m.openText(ids[2] as string)).insert(0, 'after migration: ');
    await m.flush();
    n.store.close();
    localStorage.setItem('hivetex.nativeStore', 'off');
    const again = await openProjectStore(ref);
    expect(again.kind).toBe('native');
    expect(await textIn(again.store, ids[2] as string)).toBe('after migration: chapter 2');
    again.store.close();
  });

  it('a downgrade first exports back to IndexedDB, verified, with every later edit', async () => {
    const ids = await legacyProject();
    const n = await openProjectStore(ref);
    const m = new ProjectModel(n.store, { flushMs: 1 });
    await m.init();
    (await m.openText(ids[0] as string)).insert(0, 'native edit: ');
    await m.flush();
    const nativeDigest = (await storeDigest(n.store)).sha256;
    n.store.close();
    await exportToLegacy(ref);
    const legacy = await IndexedDbPersistence.open('hivetex-project-proj-1');
    expect((await storeDigest(legacy)).sha256).toBe(nativeDigest);
    expect(await textIn(legacy, ids[0] as string)).toBe('native edit: chapter 0');
    legacy.close();
    expect(JSON.parse([...world.manifests.values()][0] as string).active).toBe('legacy');
  });

  it('a new project starts native without a migration, and removal deletes both stores', async () => {
    const fresh = await openProjectStore({ kind: 'shared', project: 'proj-new', account: 'ann' });
    expect(fresh.kind).toBe('native');
    fresh.store.close();
    await removeProjectStore({ kind: 'shared', project: 'proj-new', account: 'ann' });
  });
  it('reads a retained native pointer without acquiring a second writer', async () => {
    const opened = await openProjectStore(ref);
    // Keeping this writer open models the authoritative worker owning the project.
    expect(await hasNativeProjectStore(ref)).toBe(true);
    await expect(openProjectStore(ref)).rejects.toThrow('already open');
    await opened.store.close();
  });
  it('an unassociated cache requires explicit confirmation and stays intact through local export and migration', async () => {
    const ids = await legacyProject(2, false);
    const original = await IndexedDbPersistence.open('hivetex-project-proj-1');
    const before = (await storeDigest(original)).sha256; original.close();
    await expect(openProjectStore(ref)).rejects.toBeInstanceOf(MigrationAssociationRequired);
    expect(JSON.parse([...world.manifests.values()][0] as string).state).toBe('needs-confirmation');
    const raw = new TextDecoder().decode(await exportLegacyRecovery(ref));
    expect(raw).toContain(ids[0]);
    await confirmLegacyAssociation(ref);
    const native = await openProjectStore(ref); expect(native.kind).toBe('native');
    await native.store.close();
    const untouched = await IndexedDbPersistence.open('hivetex-project-proj-1');
    expect((await storeDigest(untouched)).sha256).toBe(before); untouched.close();
  });
  it('a cache recorded for another account cannot be confirmed into this account', async () => {
    await legacyProject();
    const source = await IndexedDbPersistence.open('hivetex-project-proj-1');
    await source.setMeta('storeAssociation', { server: 'https://hivetex.example', account: 'other' }); source.close();
    await expect(openProjectStore(ref)).rejects.toMatchObject({ mayConfirm: false });
    await expect(confirmLegacyAssociation(ref)).rejects.toMatchObject({ mayConfirm: false });
  });
});
