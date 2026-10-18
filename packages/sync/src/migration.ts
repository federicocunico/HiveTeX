import { copyStore, type CopyCounts, storeDigest } from './migrate.js';
import type { Persistence } from './persistence.js';

/**
 * Resumable migration of one legacy desktop project store into the native store (D4, 5.4).
 *
 * idle -> copying -> verifying -> active(native)
 *
 * The source is only ever read. Progress (finished documents and blobs) is checkpointed in the manifest, so an
 * interrupted run resumes; the active-store switch is a single manifest write made only after the reopened target's
 * digest equals the source's. A legacy store is keyed by project id alone: without an established (server, account)
 * association the project is left in `needs-confirmation` and never shared in the background.
 */

export type MigrationState = 'pending' | 'copying' | 'verifying' | 'done' | 'needs-confirmation';

export interface MigrationManifest {
  v: 1;
  project: string;
  state: MigrationState;
  /** Which store the app opens for this project. Switches to 'native' exactly once, after verification. */
  active: 'legacy' | 'native';
  sourceSchema: string;
  targetSchema: string;
  association: { server: string; account: string } | null;
  progress: { docs: string[]; blobs: string[] };
  counts?: CopyCounts;
  /** Digest of the source at copy time and of the verified target. */
  sourceDigest?: string;
  targetDigest?: string;
  updatedAt: number;
}

/** Durable, atomically replaced manifests (a JSON file per project written by the native side in the desktop app). */
export interface ManifestStore {
  read(project: string): Promise<MigrationManifest | null>;
  write(m: MigrationManifest): Promise<void>;
}

export class MemoryManifestStore implements ManifestStore {
  data = new Map<string, MigrationManifest>();
  async read(project: string) {
    const m = this.data.get(project);
    return m ? (JSON.parse(JSON.stringify(m)) as MigrationManifest) : null;
  }
  async write(m: MigrationManifest) {
    this.data.set(m.project, JSON.parse(JSON.stringify(m)) as MigrationManifest);
  }
}

/** Manifests in the desktop app's data directory (store.rs write_manifest: temporary file, fsync, rename). */
export class NativeManifestStore implements ManifestStore {
  constructor(private invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>) {}
  async read(project: string) {
    const json = await this.invoke<string | null>('migration_manifest_read', { project });
    return json ? (JSON.parse(json) as MigrationManifest) : null;
  }
  async write(m: MigrationManifest) {
    await this.invoke('migration_manifest_write', { project: m.project, json: JSON.stringify(m) });
  }
}

/** One migration per project at a time, and never while a runtime writes the project (the old writer is stopped). */
export interface MigrationLock {
  acquire(project: string): Promise<() => void>;
}
export class MemoryMigrationLock implements MigrationLock {
  private held = new Set<string>();
  async acquire(project: string) {
    if (this.held.has(project)) throw new Error('migration already running for this project');
    this.held.add(project);
    return () => void this.held.delete(project);
  }
}

export interface MigrateProjectOptions {
  project: string;
  /** The legacy (IndexedDB) store, opened read-only by convention: the migration never writes to it. */
  source: Persistence;
  /** Opens the native target; called again to reopen it for verification. */
  openTarget: () => Promise<Persistence>;
  manifests: ManifestStore;
  lock: MigrationLock;
  /** The (server, account) this legacy project belongs to, if the control plane confirmed it; null when ambiguous. */
  association: { server: string; account: string } | null;
  /** Checkpoint the manifest every this many items (default 25). */
  checkpointEvery?: number;
  now?: () => number;
}

export const LEGACY_SCHEMA = 'indexeddb-v2';
export const NATIVE_SCHEMA = 'sqlite-safety-v1';

/** Runs (or resumes) the migration. Idempotent once done. Throws on failure; rerunning resumes from the checkpoint. */
export async function migrateProject(o: MigrateProjectOptions): Promise<MigrationManifest> {
  const now = o.now ?? Date.now;
  const release = await o.lock.acquire(o.project);
  try {
    let m = await o.manifests.read(o.project);
    if (m?.state === 'done') return m;
    m ??= {
      v: 1, project: o.project, state: 'pending', active: 'legacy', sourceSchema: LEGACY_SCHEMA, targetSchema: NATIVE_SCHEMA,
      association: null, progress: { docs: [], blobs: [] }, updatedAt: now(),
    };
    if (!o.association) {
      m = { ...m, state: 'needs-confirmation', active: 'legacy', updatedAt: now() };
      await o.manifests.write(m);
      return m;
    }
    if (m.association && (m.association.server !== o.association.server || m.association.account !== o.association.account)) {
      throw new Error('migration was started for another account or server');
    }
    m = { ...m, state: 'copying', association: o.association, updatedAt: now() };
    await o.manifests.write(m);

    const target = await o.openTarget();
    try {
      const done = { docs: new Set(m.progress.docs), blobs: new Set(m.progress.blobs) };
      let sinceCheckpoint = 0;
      const every = o.checkpointEvery ?? 25;
      const checkpoint = async () => {
        sinceCheckpoint = 0;
        m = { ...(m as MigrationManifest), progress: { docs: [...done.docs], blobs: [...done.blobs] }, updatedAt: now() };
        await o.manifests.write(m);
      };
      const counts = await copyStore(o.source, target, {
        done,
        onItem: async (kind, id) => {
          (kind === 'doc' ? done.docs : done.blobs).add(id);
          if (++sinceCheckpoint >= every) await checkpoint();
        },
      });
      await checkpoint();
      m = { ...m, state: 'verifying', counts, updatedAt: now() };
      await o.manifests.write(m);
    } finally {
      await target.close();
    }

    // Verify on a reopened target: what a restart would see.
    const source = await storeDigest(o.source);
    const reopened = await o.openTarget();
    let verified: Awaited<ReturnType<typeof storeDigest>>;
    try {
      verified = await storeDigest(reopened);
    } finally {
      await reopened.close();
    }
    if (verified.sha256 !== source.sha256) {
      // A source that changed since the copy (or a damaged target) restarts the copy from scratch.
      m = { ...m, state: 'copying', progress: { docs: [], blobs: [] }, sourceDigest: source.sha256, targetDigest: verified.sha256, updatedAt: now() };
      await o.manifests.write(m);
      throw new Error('migrated store does not match its source');
    }
    // The single atomic switch.
    m = { ...m, state: 'done', active: 'native', sourceDigest: source.sha256, targetDigest: verified.sha256, updatedAt: now() };
    await o.manifests.write(m);
    return m;
  } finally {
    release();
  }
}
