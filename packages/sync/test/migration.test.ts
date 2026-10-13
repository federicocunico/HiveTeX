import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { storeDigest } from '../src/migrate.js';
import { MemoryManifestStore, MemoryMigrationLock, type ManifestStore, migrateProject } from '../src/migration.js';
import { ProjectModel, sha256Hex } from '../src/model.js';
import { NativePersistence } from '../src/native-persistence.js';
import { IndexedDbPersistence, type Persistence } from '../src/persistence.js';
import { fakeNative } from './native-fake.js';

/** 5.4: lock, checkpoints, checksums, atomic switch and ambiguous association, with a failure at every transition. */
async function legacy() {
  const store = await IndexedDbPersistence.open('legacy', new IDBFactory());
  const model = new ProjectModel(store, { flushMs: 1 });
  await model.init();
  for (let i = 0; i < 6; i++) await model.createTextNow(`ch${i}.tex`, `chapter ${i}`);
  for (let i = 0; i < 3; i++) {
    const b = new Uint8Array(300 + i).fill(i);
    await store.putBlob(await sha256Hex(b), b);
  }
  await store.setMeta('availability', { root: 'complete' });
  await model.flush();
  return store;
}
const MUTATIONS = new Set(['transact', 'append', 'compact', 'putBlob', 'putSnapshot', 'setMeta', 'putChangeSet']);
/** A target that fails its `failAt`-th write (once), like a crash or a full disk mid-copy. */
function flaky(p: Persistence, failAt: { n: number }): Persistence {
  let calls = 0;
  return new Proxy(p, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        if (MUTATIONS.has(String(k)) && ++calls === failAt.n) return Promise.reject(new Error(`injected failure at write ${calls}`));
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
}
function flakyManifests(m: ManifestStore, failAt: { n: number }): ManifestStore {
  let writes = 0;
  return { read: (p) => m.read(p), write: async (x) => { if (++writes === failAt.n) throw new Error(`injected manifest failure ${writes}`); await m.write(x); } };
}
const assoc = { server: 'https://hivetex.example', account: 'ann' };

describe('resumable desktop store migration (5.4)', () => {
  it('migrates, verifies on a reopened target and switches the active store exactly once', async () => {
    const source = await legacy();
    const f = fakeNative();
    const manifests = new MemoryManifestStore();
    const opts = { project: 'p', source, openTarget: () => NativePersistence.open(f.invoke, 'a'.repeat(64)), manifests, lock: new MemoryMigrationLock(), association: assoc, checkpointEvery: 2 };
    const m = await migrateProject(opts);
    expect(m).toMatchObject({ state: 'done', active: 'native', association: assoc });
    expect(m.sourceDigest).toBe(m.targetDigest);
    expect(await migrateProject(opts)).toEqual(m); // idempotent
  });

  it('survives a failure at every target write and every manifest write, resuming with the source intact', async () => {
    // Count the actual transitions. An unawaited native close used to create unrelated "interruptions" past the writes.
    let targetWrites = 0, manifestWrites = 0;
    const baseline = fakeNative(), baselineManifests = new MemoryManifestStore();
    await migrateProject({ project: 'baseline', source: await legacy(), lock: new MemoryMigrationLock(), association: assoc, checkpointEvery: 2,
      manifests: { read: (p) => baselineManifests.read(p), write: async (m) => { manifestWrites++; await baselineManifests.write(m); } },
      openTarget: async () => new Proxy(await NativePersistence.open(baseline.invoke, 'd'.repeat(64)), {
        get(t, key, receiver) {
          const value = Reflect.get(t, key, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => { if (MUTATIONS.has(String(key))) targetWrites++; return value.apply(t, args); };
        },
      }),
    });
    let interruptions = 0;
    for (const where of ['target', 'manifest'] as const) {
      for (let n = 1; n <= (where === 'target' ? targetWrites : manifestWrites); n++) {
        const source = await legacy();
        const sourceBefore = (await storeDigest(source)).sha256;
        const f = fakeNative();
        const manifests = new MemoryManifestStore();
        const failAt = { n };
        const base = { project: 'p', source, lock: new MemoryMigrationLock(), association: assoc, checkpointEvery: 2 };
        const target = () => NativePersistence.open(f.invoke, 'b'.repeat(64)).then((p) => (where === 'target' ? flaky(p, failAt) : p));
        const first = migrateProject({ ...base, manifests: where === 'manifest' ? flakyManifests(manifests, failAt) : manifests, openTarget: target });
        const interrupted = await first.then(() => false, () => true);
        if (interrupted) interruptions++;
        failAt.n = -1;
        const before = await manifests.read('p');
        if (interrupted) expect(before?.active ?? 'legacy').toBe('legacy'); // nothing switched by a failed run
        const m = await migrateProject({ ...base, manifests, openTarget: target });
        expect(m.state, `${where} failure at ${n}`).toBe('done');
        expect(m.active).toBe('native');
        expect((await storeDigest(source)).sha256).toBe(sourceBefore);
        const reopened = await NativePersistence.open(f.invoke, 'b'.repeat(64));
        expect((await storeDigest(reopened)).sha256).toBe(sourceBefore);
        reopened.close();
      }
    }
    expect(targetWrites).toBeGreaterThan(0); expect(manifestWrites).toBeGreaterThan(0);
    expect(interruptions).toBe(targetWrites + manifestWrites); // every real transition was interrupted
  }, 60_000);
  it('awaits native writer release before reopening the target for verification', async () => {
    const f = fakeNative(); let closing = false;
    const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      if (cmd === 'store_open' && closing) throw new Error('native writer is still closing');
      if (cmd === 'store_close') {
        closing = true; await new Promise((r) => setTimeout(r, 50));
        const result = await f.invoke<T>(cmd, args); closing = false; return result;
      }
      return f.invoke<T>(cmd, args);
    };
    const manifest = await migrateProject({ project: 'p', source: await legacy(), lock: new MemoryMigrationLock(),
      association: assoc, manifests: new MemoryManifestStore(), openTarget: () => NativePersistence.open(invoke, 'e'.repeat(64)) });
    expect(manifest.active).toBe('native'); expect(closing).toBe(false);
  });

  it('an ambiguous legacy association is not migrated for background sharing; a concurrent run is refused', async () => {
    const source = await legacy();
    const f = fakeNative();
    const manifests = new MemoryManifestStore();
    const lock = new MemoryMigrationLock();
    const ambiguous = await migrateProject({ project: 'p', source, openTarget: () => NativePersistence.open(f.invoke, 'c'.repeat(64)), manifests, lock, association: null });
    expect(ambiguous).toMatchObject({ state: 'needs-confirmation', active: 'legacy' });
    const release = await lock.acquire('p');
    await expect(migrateProject({ project: 'p', source, openTarget: () => NativePersistence.open(f.invoke, 'c'.repeat(64)), manifests, lock, association: assoc })).rejects.toThrow('already running');
    release();
    const done = await migrateProject({ project: 'p', source, openTarget: () => NativePersistence.open(f.invoke, 'c'.repeat(64)), manifests, lock, association: assoc });
    expect(done.state).toBe('done');
    // A run for another account must not continue a copy started for the first one.
    const other = new MemoryManifestStore();
    await other.write({ ...done, state: 'copying', active: 'legacy' });
    await expect(migrateProject({ project: 'p', source, openTarget: () => NativePersistence.open(f.invoke, 'c'.repeat(64)), manifests: other, lock, association: { ...assoc, account: 'bob' } })).rejects.toThrow('another account');
  });
});
