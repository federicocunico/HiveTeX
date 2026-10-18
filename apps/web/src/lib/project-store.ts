import type { Persistence } from '@hivetex/sync';
import { sessionOrigin, isDesktop } from './api.js';
import { toast } from '../ui/toast.svelte.js';

/**
 * The one place that opens, copies and deletes a project's stored contents (5.5). In the browser that is the IndexedDB
 * database of the project, as before. In the desktop app it is the native SQLite store of (server, account, project)
 * (D4): a legacy IndexedDB copy is migrated once, resumably, and stays untouched as the recovery source.
 * `localStorage['hivetex.nativeStore'] = 'off'` stops new migrations (feature rollback, 12.3), but a project already
 * migrated stays on its native store: reopening the stale IndexedDB copy would silently lose every later edit. Going
 * back to IndexedDB (before a binary downgrade) is the explicit, verified `exportToLegacy`.
 */

export type StoreRef = { kind: 'shared'; project: string; account: string } | { kind: 'local'; id: string };

const legacyName = (ref: StoreRef) => `hivetex-project-${ref.kind === 'shared' ? ref.project : ref.id}`;

export function nativeStoreEnabled() {
  try {
    return isDesktop && localStorage.getItem('hivetex.nativeStore') !== 'off';
  } catch {
    return isDesktop;
  }
}

/** Opens a project's IndexedDB store; an upgrade held by another tab, or superseded by a newer one, is said (5.6). */
function openIndexedDb(sync: typeof import('@hivetex/sync'), name: string) {
  return sync.IndexedDbPersistence.open(name, indexedDB, {
    onBlocked: () => toast('Another HiveTeX tab or window still has this project open with an older version. Close it to continue opening the project here.', 'info', 15_000),
    onVersionChange: () => toast('A newer HiveTeX version opened this project in another tab. Reload this tab to keep editing here.', 'error', 30_000),
  });
}

async function invoke() {
  return (await import('@tauri-apps/api/core')).invoke;
}

async function scopeOf(ref: StoreRef) {
  const { storeScope } = await import('@hivetex/sync');
  return ref.kind === 'local' ? `local-${ref.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}` : storeScope(sessionOrigin(), ref.account, ref.project);
}

let lock: import('@hivetex/sync').MemoryMigrationLock | null = null;
export class MigrationAssociationRequired extends Error {
  constructor(readonly ref: StoreRef, readonly mayConfirm: boolean) {
    super(mayConfirm ? 'This older cache has no recorded account/server association. Confirm its origin before migration.'
      : 'This cached project belongs to a different account or server. Export it locally to recover it.');
  }
}
const associationOf = (ref: StoreRef) => ref.kind === 'shared'
  ? { server: sessionOrigin(), account: ref.account } : { server: 'local', account: 'local' };

/** Whether a legacy IndexedDB database of this project exists (without creating one). */
async function legacyExists(name: string): Promise<boolean> {
  const dbs = await (indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> }).databases?.();
  return dbs ? dbs.some((d) => d.name === name) : true;
}

export interface OpenedStore {
  store: Persistence;
  kind: 'indexeddb' | 'native';
  /** Set when the desktop could not migrate yet and fell back to the legacy store (it retries on the next open). */
  migrationError?: unknown;
}
/** Read the active-store pointer without acquiring a SQLite writer (a seed may already own it). */
export async function hasNativeProjectStore(ref: StoreRef): Promise<boolean> {
  if (!isDesktop) return false;
  const { NativeManifestStore } = await import('@hivetex/sync');
  const manifest = await new NativeManifestStore(await invoke()).read(await scopeOf(ref));
  return manifest?.active === 'native';
}

export async function openProjectStore(ref: StoreRef): Promise<OpenedStore> {
  const sync = await import('@hivetex/sync');
  if (!isDesktop) return { store: await openIndexedDb(sync, legacyName(ref)), kind: 'indexeddb' };
  const call = await invoke();
  const scope = await scopeOf(ref);
  const manifests = new sync.NativeManifestStore(call);
  const openNative = () => sync.NativePersistence.open(call, scope);
  const m = await manifests.read(scope);
  if (m?.active === 'native') return { store: await openNative(), kind: 'native' };
  if (!nativeStoreEnabled()) return { store: await openIndexedDb(sync, legacyName(ref)), kind: 'indexeddb' };
  if (!(await legacyExists(legacyName(ref)))) {
    // Nothing to migrate: a new project starts in the native store.
    await manifests.write({ v: 1, project: scope, state: 'done', active: 'native', sourceSchema: sync.LEGACY_SCHEMA, targetSchema: sync.NATIVE_SCHEMA, association: null, progress: { docs: [], blobs: [] }, updatedAt: Date.now() });
    return { store: await openNative(), kind: 'native' };
  }
  const source = await openIndexedDb(sync, legacyName(ref));
  try {
    lock ??= new sync.MemoryMigrationLock();
    // Current membership does not establish who authored an older unscoped cache.
    const expected = associationOf(ref);
    const recorded = m?.association ?? await source.getMeta('storeAssociation') as { server: string; account: string } | undefined;
    const association = ref.kind === 'local' ? expected : recorded ?? null;
    if (association && (association.server !== expected.server || association.account !== expected.account)) {
      throw new MigrationAssociationRequired(ref, false);
    }
    const done = await sync.migrateProject({ project: scope, source, openTarget: openNative, manifests, lock, association });
    if (done.active !== 'native') throw new MigrationAssociationRequired(ref, true);
    source.close();
    return { store: await openNative(), kind: 'native' };
  } catch (migrationError) {
    if (migrationError instanceof MigrationAssociationRequired) { source.close(); throw migrationError; }
    // The legacy store keeps working; the copy resumes (and is verified again) next time.
    return { store: source, kind: 'indexeddb', migrationError };
  }
}

/** Explicit confirmation belongs to the native manifest; the original cache remains untouched. */
export async function confirmLegacyAssociation(ref: StoreRef): Promise<void> {
  const sync = await import('@hivetex/sync');
  const source = await openIndexedDb(sync, legacyName(ref));
  const expected = associationOf(ref);
  try {
    const recorded = await source.getMeta('storeAssociation') as { server: string; account: string } | undefined;
    if (recorded && (recorded.server !== expected.server || recorded.account !== expected.account)) throw new MigrationAssociationRequired(ref, false);
    const project = await scopeOf(ref), manifests = new sync.NativeManifestStore(await invoke());
    const current = await manifests.read(project);
    if (current?.association && (current.association.server !== expected.server || current.association.account !== expected.account)) throw new MigrationAssociationRequired(ref, false);
    await manifests.write({ v: 1, project, state: 'pending', active: 'legacy', sourceSchema: sync.LEGACY_SCHEMA,
      targetSchema: sync.NATIVE_SCHEMA, association: expected, progress: { docs: [], blobs: [] }, updatedAt: Date.now() });
  } finally { source.close(); }
}

/** Complete local recovery of an unassociated cache: raw Yjs identities, metadata/recovery, assets and history. */
export async function exportLegacyRecovery(ref: StoreRef): Promise<Uint8Array> {
  const sync = await import('@hivetex/sync');
  const source = await openIndexedDb(sync, legacyName(ref));
  try {
    const docs = await Promise.all((await source.listDocs()).map(async (id) => ({ id, updates: await source.load(id) })));
    const blobs = await Promise.all((await source.listBlobs()).map(async (hash) => ({ hash, bytes: await source.getBlob(hash) })));
    const meta = await Promise.all((await source.listMetaKeys()).map(async (key) => ({ key, value: await source.getMeta(key) })));
    return new TextEncoder().encode(sync.encodeValue({ v: 1, docs, blobs, meta, snapshots: await source.listSnapshots(), changes: await source.listChangeSets() }));
  } finally { source.close(); }
}

/** Deletes a project's stored contents on this device (native store and any legacy IndexedDB copy). */
export async function removeProjectStore(ref: StoreRef): Promise<void> {
  if (nativeStoreEnabled()) {
    const call = await invoke();
    await call('store_delete', { scope: await scopeOf(ref) }).catch(() => {});
  }
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(legacyName(ref));
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

/** Copies documents, images, history and change log (not device metadata) from one project's store to another's. */
export async function copyProjectContent(from: StoreRef, to: StoreRef): Promise<void> {
  const { copyStore } = await import('@hivetex/sync');
  const a = await openProjectStore(from);
  let b: OpenedStore | null = null;
  try {
    b = await openProjectStore(to);
    await copyStore(a.store, b.store, { skipMeta: () => true });
  } finally {
    await a.store.close();
    await b?.store.close();
  }
}

/**
 * Before installing an older desktop version (which only knows IndexedDB): copies the native store back into a fresh
 * IndexedDB database, verifies it against the native store, and makes IndexedDB the active store again. Without this,
 * an older version would open the copy from before the migration and every later edit would be missing.
 */
export async function exportToLegacy(ref: StoreRef): Promise<{ docs: number; blobs: number }> {
  if (!isDesktop) throw new Error('only the desktop app has a native store');
  const sync = await import('@hivetex/sync');
  const call = await invoke();
  const scope = await scopeOf(ref);
  const manifests = new sync.NativeManifestStore(call);
  const m = await manifests.read(scope);
  if (m?.active !== 'native') throw new Error('this project is not in the native store');
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(legacyName(ref));
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
  const native = await sync.NativePersistence.open(call, scope);
  const legacy = await openIndexedDb(sync, legacyName(ref));
  try {
    const counts = await sync.copyStore(native, legacy);
    const [a, b] = await Promise.all([sync.storeDigest(native), sync.storeDigest(legacy)]);
    if (a.sha256 !== b.sha256) throw new Error(`the exported copy does not match the native store (${(Object.keys(a.parts) as Array<keyof typeof a.parts>).filter((key) => a.parts[key] !== b.parts[key]).join(', ')})`);
    await manifests.write({ ...m, state: 'pending', active: 'legacy', progress: { docs: [], blobs: [] }, updatedAt: Date.now() });
    return { docs: counts.docs, blobs: counts.blobs };
  } finally {
    await native.close();
    legacy.close();
  }
}
