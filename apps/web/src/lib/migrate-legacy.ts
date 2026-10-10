/**
 * One-time migration of what this device stored under the product's previous name (p2platex): device keys, offline
 * project copies, folder locations, settings. Runs before anything opens storage; safe to call on every start.
 * A failure leaves the old data in place and the migration runs again on the next start.
 */

const OLD = 'p2platex';
const NEW = 'hivetex';
const DONE_KEY = `${NEW}.migrated`;

type KV = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

export interface MigrationEnv {
  local?: KV | undefined;
  session?: KV | undefined;
  idb?: IDBFactory | undefined;
}

/** `p2platex.x` -> `hivetex.x`; an existing new key wins. */
function migrateKeys(store: KV) {
  const old: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(`${OLD}.`)) old.push(k);
  }
  for (const k of old) {
    const target = `${NEW}${k.slice(OLD.length)}`;
    const v = store.getItem(k);
    if (v !== null && store.getItem(target) === null) store.setItem(target, v);
    store.removeItem(k);
  }
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** Opens `name` only if it exists (opening a missing database would create it). */
function openExisting(idb: IDBFactory, name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let created = false;
    const r = idb.open(name);
    r.onupgradeneeded = (e) => {
      if ((e as IDBVersionChangeEvent).oldVersion === 0) {
        created = true;
        r.transaction?.abort();
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => (created ? resolve(null) : reject(r.error));
    r.onblocked = () => reject(new Error(`${name} is blocked`));
  });
}

async function deleteDb(idb: IDBFactory, name: string) {
  await new Promise<void>((resolve, reject) => {
    const r = idb.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
    r.onblocked = () => resolve();
  });
}

/** Copies every object store (schema, indexes and records) of `from` into a new database `to`, then deletes `from`. */
async function copyDb(idb: IDBFactory, from: IDBDatabase, to: string) {
  const names = [...from.objectStoreNames];
  const tx = names.length ? from.transaction(names, 'readonly') : null;
  const stores = await Promise.all(
    names.map(async (n) => {
      const s = (tx as IDBTransaction).objectStore(n);
      const [keys, values] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      const indexes = [...s.indexNames].map((i) => {
        const ix = s.index(i);
        return { name: i, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry };
      });
      return { name: n, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes, keys, values };
    }),
  );
  const version = from.version;
  from.close();
  await deleteDb(idb, to); // a partial copy from an interrupted earlier run
  const target = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = idb.open(to, version);
    r.onupgradeneeded = () => {
      for (const s of stores) {
        const os = r.result.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
        for (const i of s.indexes) os.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    if (stores.length) {
      const wtx = target.transaction(stores.map((s) => s.name), 'readwrite');
      for (const s of stores) {
        const os = wtx.objectStore(s.name);
        s.values.forEach((v, i) => {
          if (s.keyPath === null) os.put(v, s.keys[i]);
          else os.put(v);
        });
      }
      await new Promise<void>((resolve, reject) => {
        wtx.oncomplete = () => resolve();
        wtx.onerror = () => reject(wtx.error);
        wtx.onabort = () => reject(wtx.error);
      });
    }
  } finally {
    target.close();
  }
}

async function legacyDatabaseNames(idb: IDBFactory, local: KV | undefined): Promise<string[]> {
  if (typeof idb.databases === 'function') {
    return (await idb.databases()).map((d) => d.name ?? '').filter((n) => n.startsWith(`${OLD}-`));
  }
  // No databases() (older browsers): the fixed names plus the projects this device knows about.
  const names = [`${OLD}-device`, `${OLD}-locations`];
  try {
    for (const p of JSON.parse(local?.getItem(`${NEW}.projects`) ?? '[]') as Array<{ id?: string }>) if (p.id) names.push(`${OLD}-project-${p.id}`);
  } catch {
    /* no cached list */
  }
  return names;
}

export async function migrateLegacyStorage(env: MigrationEnv = defaultEnv()): Promise<boolean> {
  const { local, session, idb } = env;
  if (local?.getItem(DONE_KEY) === '1') return false;
  if (local) migrateKeys(local);
  if (session) migrateKeys(session);
  if (idb) {
    for (const name of await legacyDatabaseNames(idb, local)) {
      const from = await openExisting(idb, name);
      if (!from) continue;
      const to = `${NEW}${name.slice(OLD.length)}`;
      const existing = await openExisting(idb, to);
      if (existing) {
        // Already migrated (or created fresh since): keep the new data, drop the old copy.
        existing.close();
        from.close();
      } else await copyDb(idb, from, to);
      await deleteDb(idb, name);
    }
  }
  local?.setItem(DONE_KEY, '1');
  return true;
}

function defaultEnv(): MigrationEnv {
  const safe = <T>(f: () => T) => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  return {
    local: safe(() => localStorage),
    session: safe(() => sessionStorage),
    idb: typeof indexedDB === 'undefined' ? undefined : indexedDB,
  };
}
