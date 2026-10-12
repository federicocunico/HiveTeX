import * as Y from 'yjs';

/** Frozen copy of the project's content, used for local history. */
export interface HistorySnapshot {
  id: string;
  at: number;
  files: Array<{ path: string; kind: 'text' | 'binary' | 'dir'; text?: string; hash?: string; size?: number }>;
}

/** One file touched by a change set (see changelog.ts). */
export interface ChangeSetFile {
  fileId: string;
  path: string;
  op: 'edit' | 'create' | 'delete' | 'rename' | 'binary';
  /** Previous path for renames. */
  from?: string;
  /** diff-match-patch patch text (before -> after) for text edits, creations and deletions. */
  patch?: string;
  added?: number;
  removed?: number;
  /** Full text before the change, kept for deleted text files so they can be restored. */
  before?: string;
  hashBefore?: string;
  sizeBefore?: number;
  hashAfter?: string;
}

/** A group of consecutive edits from one source (this device's folder or editor, a co-author, or an undo). */
export interface ChangeSet {
  id: string;
  source: { kind: 'folder' | 'editor' | 'peer' | 'undo'; name: string };
  startedAt: number;
  endedAt: number;
  files: ChangeSetFile[];
  /** For undo sets: the change set that was undone. */
  undoOf?: string;
  /** Files an undo could not fully apply because later edits overlap. */
  partial?: string[];
}

export const CHANGES_KEEP_MS = 7 * 24 * 3600 * 1000;
export const CHANGES_KEEP_MIN = 500;

/** Which change sets survive pruning: everything from the last 7 days, and at least the newest 500. */
export function changesToKeep(all: ChangeSet[], now: number): Set<string> {
  const sorted = [...all].sort((a, b) => b.endedAt - a.endedAt);
  const keep = new Set<string>();
  sorted.forEach((c, i) => {
    if (i < CHANGES_KEEP_MIN || now - c.endedAt <= CHANGES_KEEP_MS) keep.add(c.id);
  });
  return keep;
}

/** One step of an atomic `Persistence.transact`: all steps commit together or none does. */
export type StoreOp =
  | { op: 'append'; docId: string; updates: Uint8Array[] }
  | { op: 'compact'; docId: string; state: Uint8Array }
  /** `value: undefined` removes the key. */
  | { op: 'meta'; key: string; value: unknown };

export interface Persistence {
  /** Applies document and metadata changes as one all-or-nothing transition (recovery journals, document replacement). */
  transact(ops: StoreOp[]): Promise<void>;
  load(docId: string): Promise<Uint8Array[]>;
  append(docId: string, updates: Uint8Array[]): Promise<void>;
  /** Replaces every stored update of the doc with a single compacted state. */
  compact(docId: string, state: Uint8Array): Promise<void>;
  listDocs(): Promise<string[]>;
  putBlob(hash: string, bytes: Uint8Array): Promise<void>;
  getBlob(hash: string): Promise<Uint8Array | undefined>;
  listBlobs(): Promise<string[]>;
  putSnapshot(s: HistorySnapshot): Promise<void>;
  listSnapshots(): Promise<HistorySnapshot[]>;
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
  /** Every metadata key (complete export and migration, 5.3). */
  listMetaKeys?(): Promise<string[]>;
  putChangeSet(c: ChangeSet): Promise<void>;
  /** Newest first. */
  listChangeSets(): Promise<ChangeSet[]>;
  /** Removes change sets outside the retention window; returns how many were removed. */
  pruneChangeSets(now?: number): Promise<number>;
  close(): void | Promise<void>;
}

export class MemoryPersistence implements Persistence {
  docs = new Map<string, Uint8Array[]>();
  blobs = new Map<string, Uint8Array>();
  snaps: HistorySnapshot[] = [];
  meta = new Map<string, unknown>();
  async transact(ops: StoreOp[]) {
    for (const o of ops) {
      if (o.op === 'append') await this.append(o.docId, o.updates);
      else if (o.op === 'compact') await this.compact(o.docId, o.state);
      else if (o.value === undefined) this.meta.delete(o.key);
      else this.meta.set(o.key, o.value);
    }
  }
  async load(docId: string) {
    return [...(this.docs.get(docId) ?? [])];
  }
  async append(docId: string, updates: Uint8Array[]) {
    const arr = this.docs.get(docId) ?? [];
    arr.push(...updates);
    this.docs.set(docId, arr);
  }
  async compact(docId: string, state: Uint8Array) {
    this.docs.set(docId, [state]);
  }
  async listDocs() {
    return [...this.docs.keys()];
  }
  async putBlob(hash: string, bytes: Uint8Array) {
    this.blobs.set(hash, bytes);
  }
  async getBlob(hash: string) {
    return this.blobs.get(hash);
  }
  async listBlobs() {
    return [...this.blobs.keys()];
  }
  async putSnapshot(s: HistorySnapshot) {
    this.snaps.push(s);
  }
  async listSnapshots() {
    // Oldest first, like the IndexedDB and native stores.
    return [...this.snaps].sort((a, b) => a.at - b.at);
  }
  async getMeta(key: string) {
    return this.meta.get(key);
  }
  async setMeta(key: string, value: unknown) {
    this.meta.set(key, value);
  }
  async listMetaKeys() {
    return [...this.meta.keys()];
  }
  changes = new Map<string, ChangeSet>();
  async putChangeSet(c: ChangeSet) {
    this.changes.set(c.id, c);
  }
  async listChangeSets() {
    return [...this.changes.values()].sort((a, b) => b.endedAt - a.endedAt);
  }
  async pruneChangeSets(now = Date.now()) {
    const keep = changesToKeep([...this.changes.values()], now);
    let n = 0;
    for (const id of [...this.changes.keys()]) if (!keep.has(id)) (this.changes.delete(id), n++);
    return n;
  }
  close() {}
}

// ---------------------------------------------------------------------------------------------
// IndexedDB (browser + Tauri webview)
// ---------------------------------------------------------------------------------------------

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export class IndexedDbPersistence implements Persistence {
  private db!: IDBDatabase;

  static async open(name: string, factory: IDBFactory = indexedDB): Promise<IndexedDbPersistence> {
    const p = new IndexedDbPersistence();
    p.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(name, 2);
      r.onupgradeneeded = (ev) => {
        const db = r.result;
        if (ev.oldVersion < 1) {
          db.createObjectStore('updates', { autoIncrement: true }).createIndex('doc', 'docId');
          db.createObjectStore('blobs');
          db.createObjectStore('snapshots', { keyPath: 'id' });
          db.createObjectStore('meta');
        }
        if (ev.oldVersion < 2) db.createObjectStore('changes', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return p;
  }

  async transact(ops: StoreOp[]) {
    const tx = this.db.transaction(['updates', 'meta'], 'readwrite');
    const finished = done(tx);
    finished.catch(() => {});
    // Aborting the transaction on any error is what makes the whole transition atomic.
    try {
      const updates = tx.objectStore('updates');
      const meta = tx.objectStore('meta');
      for (const o of ops) {
        if (o.op === 'append') {
          for (const update of o.updates) updates.add({ docId: o.docId, update });
        } else if (o.op === 'compact') {
          for (const k of await req(updates.index('doc').getAllKeys(o.docId))) updates.delete(k);
          updates.add({ docId: o.docId, update: o.state });
        } else if (o.value === undefined) meta.delete(o.key);
        else meta.put(o.value, o.key);
      }
    } catch (e) {
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      await finished.catch(() => {});
      throw e;
    }
    await finished;
  }
  async load(docId: string) {
    const tx = this.db.transaction('updates', 'readonly');
    const rows = await req(tx.objectStore('updates').index('doc').getAll(docId));
    return rows.map((r: { update: Uint8Array }) => r.update);
  }
  async append(docId: string, updates: Uint8Array[]) {
    const tx = this.db.transaction('updates', 'readwrite');
    for (const update of updates) tx.objectStore('updates').add({ docId, update });
    await done(tx);
  }
  async compact(docId: string, state: Uint8Array) {
    const tx = this.db.transaction('updates', 'readwrite');
    const store = tx.objectStore('updates');
    const keys = await req(store.index('doc').getAllKeys(docId));
    for (const k of keys) store.delete(k);
    store.add({ docId, update: state });
    await done(tx);
  }
  async listDocs() {
    const tx = this.db.transaction('updates', 'readonly');
    const rows = (await req(tx.objectStore('updates').getAll())) as Array<{ docId: string }>;
    return [...new Set(rows.map((r) => r.docId))];
  }
  async putBlob(hash: string, bytes: Uint8Array) {
    const tx = this.db.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(bytes, hash);
    await done(tx);
  }
  async getBlob(hash: string) {
    const tx = this.db.transaction('blobs', 'readonly');
    return (await req(tx.objectStore('blobs').get(hash))) as Uint8Array | undefined;
  }
  async listBlobs() {
    const tx = this.db.transaction('blobs', 'readonly');
    return (await req(tx.objectStore('blobs').getAllKeys())) as string[];
  }
  async putSnapshot(s: HistorySnapshot) {
    const tx = this.db.transaction('snapshots', 'readwrite');
    tx.objectStore('snapshots').put(s);
    await done(tx);
  }
  async listSnapshots() {
    const tx = this.db.transaction('snapshots', 'readonly');
    return ((await req(tx.objectStore('snapshots').getAll())) as HistorySnapshot[]).sort((a, b) => a.at - b.at);
  }
  async getMeta(key: string) {
    const tx = this.db.transaction('meta', 'readonly');
    return req(tx.objectStore('meta').get(key));
  }
  async setMeta(key: string, value: unknown) {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    await done(tx);
  }
  async listMetaKeys() {
    const tx = this.db.transaction('meta', 'readonly');
    return ((await req(tx.objectStore('meta').getAllKeys())) as IDBValidKey[]).map(String);
  }
  async putChangeSet(c: ChangeSet) {
    const tx = this.db.transaction('changes', 'readwrite');
    tx.objectStore('changes').put(c);
    await done(tx);
  }
  async listChangeSets() {
    const tx = this.db.transaction('changes', 'readonly');
    return ((await req(tx.objectStore('changes').getAll())) as ChangeSet[]).sort((a, b) => b.endedAt - a.endedAt);
  }
  async pruneChangeSets(now = Date.now()) {
    const all = await this.listChangeSets();
    const keep = changesToKeep(all, now);
    const drop = all.filter((c) => !keep.has(c.id));
    if (drop.length === 0) return 0;
    const tx = this.db.transaction('changes', 'readwrite');
    for (const c of drop) tx.objectStore('changes').delete(c.id);
    await done(tx);
    return drop.length;
  }
  close() {
    this.db.close();
  }
}


// ---------------------------------------------------------------------------------------------
// Doc persistence driver: batched writes, retry with backoff, periodic compaction
// ---------------------------------------------------------------------------------------------

export interface PersistOptions {
  flushMs?: number;
  compactAfter?: number;
  /** First retry delay after a failed write; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Called whenever a document's save state changes (see DocPersister.status). */
  onStatus?: (docId: string) => void;
}

/** Whether a document's edits are safely stored. `failing` stays true until a write commits. */
export interface SaveStatus {
  /** Edits exist that are not committed to storage yet (normal for a moment after typing). */
  unsaved: boolean;
  failing: boolean;
  error: unknown;
}

export class DocPersister {
  private pending: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stored = 0;
  /** Never rejects: one failed write must not stop the ones after it. */
  private chain: Promise<void> = Promise.resolve();
  private inflight = 0;
  private error: unknown = null;
  private failures = 0;
  private compactDue = false;
  private discarded = false;
  private gate: Promise<unknown> | null = null;
  private handler: (u: Uint8Array, origin: unknown) => void;

  constructor(
    private store: Persistence,
    private docId: string,
    private doc: Y.Doc,
    private opts: PersistOptions = {},
  ) {
    this.handler = (u, origin) => {
      if (origin === this) return;
      this.pending.push(u);
      this.arm();
    };
    doc.on('update', this.handler);
  }

  private arm() {
    if (!this.timer && !this.retryTimer && !this.discarded) this.timer = setTimeout(() => void this.flush().catch(() => {}), this.opts.flushMs ?? 250);
  }

  get status(): SaveStatus {
    return { unsaved: this.pending.length > 0 || this.inflight > 0, failing: this.error !== null, error: this.error };
  }

  private setError(e: unknown) {
    const first = this.error === null;
    this.error = e ?? new Error('storage write failed');
    if (first) this.opts.onStatus?.(this.docId);
  }

  private clearError() {
    if (this.error === null) return;
    this.error = null;
    this.failures = 0;
    this.opts.onStatus?.(this.docId);
  }

  /** Loads stored updates into the doc. Returns how many were applied. */
  async hydrate(): Promise<number> {
    const updates = await this.store.load(this.docId);
    this.doc.transact(() => {
      for (const u of updates) Y.applyUpdate(this.doc, u, this);
    });
    this.stored = updates.length;
    return updates.length;
  }

  /** Writes what is pending. Rejects if storage failed; the edits are then retained and retried with backoff. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = this.retryTimer = null;
    const run = this.chain.then(() => this.write());
    this.chain = run.catch(() => {});
    return run;
  }

  private async write() {
    if (this.gate) await this.gate;
    if (this.discarded) return;
    const batch = this.pending;
    this.pending = [];
    this.inflight++;
    try {
      if (batch.length > 0) {
        try {
          await this.store.append(this.docId, [Y.mergeUpdates(batch)]);
          this.stored += 1;
        } catch (e) {
          if (!this.discarded) {
            // Keep the unsaved edits (merged, to bound memory); updates that arrived meanwhile are already in `pending`.
            this.pending = [Y.mergeUpdates([...batch, ...this.pending])];
            this.setError(e);
            this.scheduleRetry();
          }
          throw e;
        }
      }
      if (!this.discarded) this.clearError();
      if (this.stored >= (this.opts.compactAfter ?? 500) || this.compactDue) {
        try {
          await this.store.compact(this.docId, Y.encodeStateAsUpdate(this.doc));
          this.stored = 1;
          this.compactDue = false;
        } catch (e) {
          // The batch above is committed: only the housekeeping failed, so nothing is retained or appended twice.
          this.compactDue = true;
          if (!this.discarded) this.scheduleRetry();
          throw e;
        }
      }
    } finally {
      this.inflight--;
    }
  }

  private scheduleRetry() {
    if (this.retryTimer || this.discarded) return;
    const delay = Math.min(this.opts.maxRetryMs ?? 30_000, (this.opts.retryMs ?? 500) * 2 ** Math.min(this.failures, 16));
    this.failures++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush().catch(() => {});
    }, delay);
  }

  /** Writes everything, then stops listening. Rejects (and keeps listening and retrying) if the edits could not be saved. */
  async destroy() {
    await this.flush();
    this.doc.off('update', this.handler);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Queues updates made before this persister existed. */
  enqueue(updates: Uint8Array[]) {
    if (!updates.length) return;
    this.pending.push(...updates);
    this.arm();
  }

  /** Holds every write until `gate` settles (a document replacement must be stored before anything is appended to it). */
  holdUntil(gate: Promise<unknown>) {
    this.gate = gate;
  }

  /**
   * Stops persisting this document and drops unsaved updates (its state is being replaced). The returned promise
   * settles once a write already under way has finished, so it cannot land after the replacement.
   */
  discard(): Promise<void> {
    this.discarded = true;
    this.doc.off('update', this.handler);
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.timer = this.retryTimer = null;
    this.pending = [];
    if (this.error !== null) {
      this.error = null;
      this.opts.onStatus?.(this.docId);
    }
    return this.chain;
  }
}
