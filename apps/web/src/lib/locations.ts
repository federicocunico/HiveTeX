/**
 * Where each project lives on THIS device: in the app (IndexedDB) or in a folder the user picked. Kept in IndexedDB
 * because web folder handles (File System Access API) can be stored there but not in localStorage. Never sent to the
 * server: folder paths are private to the device.
 */

export type Location =
  | { kind: 'app' }
  | {
      kind: 'folder';
      /** Folder name shown in the UI. */
      label: string;
      /** Desktop: absolute path picked through the native dialog (allowlisted on the Rust side). */
      desktopPath?: string;
      /** Web (Chromium): directory handle picked with showDirectoryPicker. */
      handle?: FileSystemDirectoryHandle;
    };

const DB = 'hivetex-locations';
const STORE = 'locations';

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void, factory: IDBFactory): Promise<T | undefined> {
  const db = await openDb(factory);
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const r = fn(tx.objectStore(STORE));
      let out: T | undefined;
      if (r) r.onsuccess = () => (out = r.result);
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const defaultFactory = () => (typeof indexedDB === 'undefined' ? null : indexedDB);

export async function getLocation(projectId: string, factory = defaultFactory()): Promise<Location> {
  if (!factory) return { kind: 'app' };
  return ((await withStore<Location>('readonly', (s) => s.get(projectId), factory)) as Location | undefined) ?? { kind: 'app' };
}

export async function setLocation(projectId: string, loc: Location, factory = defaultFactory()): Promise<void> {
  if (!factory) return;
  await withStore<unknown>('readwrite', (s) => (loc.kind === 'app' ? s.delete(projectId) : s.put(loc, projectId)) as IDBRequest<unknown>, factory);
}

export async function removeLocation(projectId: string, factory = defaultFactory()): Promise<void> {
  if (!factory) return;
  await withStore('readwrite', (s) => s.delete(projectId), factory);
}

/** Every project that uses a folder on this device (for the projects page). */
export async function allLocations(factory = defaultFactory()): Promise<Record<string, Location>> {
  if (!factory) return {};
  const out: Record<string, Location> = {};
  const db = await openDb(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return;
        out[String(c.key)] = c.value as Location;
        c.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  return out;
}

export const folderLabel = (pathOrName: string) => pathOrName.split(/[\\/]/).filter(Boolean).pop() ?? pathOrName;

/** Moves the old `hivetex.mirror.<projectId>` localStorage entries (desktop paths) into the registry, once. */
export async function migrateLegacyMirrors(storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'> = localStorage, factory = defaultFactory()) {
  if (!factory) return 0;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith('hivetex.mirror.')) keys.push(k);
  }
  for (const k of keys) {
    const path = storage.getItem(k);
    if (path) await setLocation(k.slice('hivetex.mirror.'.length), { kind: 'folder', label: folderLabel(path), desktopPath: path }, factory);
    storage.removeItem(k);
  }
  return keys.length;
}
