import * as Y from 'yjs';
import { isBytes } from './bytes.js';
import { type OperationDelta, type OperationView, applyDelta, decodeView, deltaOf, docOfView, encodeView, removedShare, viewOf } from './operation-view.js';

/** Frozen copy of the project's content, used for local history. */
export interface HistorySnapshot {
  id: string;
  at: number;
  settings?: Record<string, unknown>;
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
  /** Exact text resulting from this operation, used to validate a selective inverse after later edits. */
  after?: string;
  /** Causal frontier after a creation; body equality alone cannot detect later net-zero contributions. */
  frontierAfter?: number[];
  hashBefore?: string;
  sizeBefore?: number;
  hashAfter?: string;
}

/** A group of consecutive edits from one source (this device's folder or editor, a co-author, or an undo). */
export interface ChangeSet {
  id: string;
  source: { kind: 'folder' | 'editor' | 'peer' | 'undo' | 'import' | 'restore'; name: string; actorName?: string; uid?: string; device?: string; provenance?: 'verified' | 'unknown'; origin?: 'editor' | 'folder' | 'undo' | 'import' | 'restore' };
  operationIds?: string[];
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

/** An open native database snapshot: `size` bytes in chunks of at most 1 MiB; `close` releases the copy. */
export interface RawStoreExport {
  size: number;
  chunks: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
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
  /**
   * Metadata keys in key order: every key (complete export and migration, 5.3), or only those starting with `prefix`,
   * read as a key range (hot paths never scan unrelated history, D6).
   */
  listMetaKeys?(prefix?: string): Promise<string[]>;
  /** Coherent native database snapshot in bounded chunks; includes every persisted table, regardless of list size. */
  exportRawStore?(): AsyncIterable<Uint8Array>;
  /** The same snapshot with its size known before any byte is read (an export can be refused up front, D7). */
  openRawExport?(): Promise<RawStoreExport>;
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
    // All or nothing: every op is validated before the first write, so the maps are never copied (a large store
    // would cost O(store) per transaction).
    for (const o of ops) if (o.op === 'meta' && typeof o.key !== 'string') throw new Error('Invalid metadata key');
    for (const o of ops) {
      if (o.op === 'append') this.docs.set(o.docId, [...(this.docs.get(o.docId) ?? []), ...o.updates]);
      else if (o.op === 'compact') this.docs.set(o.docId, [o.state]);
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
  async listMetaKeys(prefix?: string) {
    const keys = [...this.meta.keys()];
    return (prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix))).sort();
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
/** Keys starting with `prefix`: [prefix, prefix with its last code unit incremented). */
export function prefixEnd(prefix: string) {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}
const prefixRange = (prefix?: string) => (prefix ? IDBKeyRange.bound(prefix, prefixEnd(prefix), false, true) : undefined);
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export class IndexedDbPersistence implements Persistence {
  private db!: IDBDatabase;
  private superseded = false;

  /**
   * `onBlocked` fires while another tab or window keeps an older version open (the upgrade waits for it to close);
   * `onVersionChange` after this connection closed itself because a newer version asked to upgrade.
   */
  static async open(name: string, factory: IDBFactory = indexedDB, o: { onBlocked?: () => void; onVersionChange?: () => void } = {}): Promise<IndexedDbPersistence> {
    const p = new IndexedDbPersistence();
    p.db = await new Promise<IDBDatabase>((resolve, reject) => {
      // Older clients explicitly request v2 and refuse this database with VersionError, rather than corrupting
      // tombstones and recovery metadata they cannot interpret. The upgrade is additive.
      const r = factory.open(name, 3);
      r.onblocked = () => o.onBlocked?.();
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
    // Never block a newer build's upgrade: close, then fail later calls with a reason instead of waiting silently.
    p.db.onversionchange = () => { p.superseded = true; p.db.close(); o.onVersionChange?.(); };
    return p;
  }

  private tx(stores: string | string[], mode: IDBTransactionMode = 'readonly') {
    if (this.superseded) throw new Error('This project store was upgraded by a newer HiveTeX tab or window; reload this tab to continue.');
    return this.db.transaction(stores, mode);
  }

  async transact(ops: StoreOp[]) {
    const tx = this.tx(['updates', 'meta'], 'readwrite');
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
    const tx = this.tx('updates', 'readonly');
    const rows = await req(tx.objectStore('updates').index('doc').getAll(docId));
    return rows.map((r: { update: Uint8Array }) => r.update);
  }
  async append(docId: string, updates: Uint8Array[]) {
    const tx = this.tx('updates', 'readwrite');
    for (const update of updates) tx.objectStore('updates').add({ docId, update });
    await done(tx);
  }
  async compact(docId: string, state: Uint8Array) {
    const tx = this.tx('updates', 'readwrite');
    const store = tx.objectStore('updates');
    const keys = await req(store.index('doc').getAllKeys(docId));
    for (const k of keys) store.delete(k);
    store.add({ docId, update: state });
    await done(tx);
  }
  async listDocs() {
    // Distinct index keys only: never read every stored update to name the documents (D6).
    const tx = this.tx('updates', 'readonly');
    const index = tx.objectStore('updates').index('doc');
    return new Promise<string[]>((resolve, reject) => {
      const out: string[] = [];
      const r = index.openKeyCursor(null, 'nextunique');
      r.onsuccess = () => { const c = r.result; if (!c) return resolve(out); out.push(String(c.key)); c.continue(); };
      r.onerror = () => reject(r.error);
    });
  }
  async putBlob(hash: string, bytes: Uint8Array) {
    const tx = this.tx('blobs', 'readwrite');
    tx.objectStore('blobs').put(bytes, hash);
    await done(tx);
  }
  async getBlob(hash: string) {
    const tx = this.tx('blobs', 'readonly');
    return (await req(tx.objectStore('blobs').get(hash))) as Uint8Array | undefined;
  }
  async listBlobs() {
    const tx = this.tx('blobs', 'readonly');
    return (await req(tx.objectStore('blobs').getAllKeys())) as string[];
  }
  async putSnapshot(s: HistorySnapshot) {
    const tx = this.tx('snapshots', 'readwrite');
    tx.objectStore('snapshots').put(s);
    await done(tx);
  }
  async listSnapshots() {
    const tx = this.tx('snapshots', 'readonly');
    return ((await req(tx.objectStore('snapshots').getAll())) as HistorySnapshot[]).sort((a, b) => a.at - b.at);
  }
  async getMeta(key: string) {
    const tx = this.tx('meta', 'readonly');
    return req(tx.objectStore('meta').get(key));
  }
  async setMeta(key: string, value: unknown) {
    const tx = this.tx('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    await done(tx);
  }
  async listMetaKeys(prefix?: string) {
    const tx = this.tx('meta', 'readonly');
    return ((await req(tx.objectStore('meta').getAllKeys(prefixRange(prefix)))) as IDBValidKey[]).map(String);
  }
  async putChangeSet(c: ChangeSet) {
    const tx = this.tx('changes', 'readwrite');
    tx.objectStore('changes').put(c);
    await done(tx);
  }
  async listChangeSets() {
    const tx = this.tx('changes', 'readonly');
    return ((await req(tx.objectStore('changes').getAll())) as ChangeSet[]).sort((a, b) => b.endedAt - a.endedAt);
  }
  async pruneChangeSets(now = Date.now()) {
    const all = await this.listChangeSets();
    const keep = changesToKeep(all, now);
    const drop = all.filter((c) => !keep.has(c.id));
    if (drop.length === 0) return 0;
    const tx = this.tx('changes', 'readwrite');
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
  describeOrigin?: (origin: unknown) => ChangeSet['source'];
  onOperation?: (record: OperationRecord) => void;
  flushMs?: number;
  compactAfter?: number;
  /** First retry delay after a failed write; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Called whenever a document's save state changes (see DocPersister.status). */
  onStatus?: (docId: string) => void;
  /** A pause longer than this starts a new journal group with its own deduplicated preimage (default 3 s, as Changes). */
  groupIdleMs?: number;
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
  private journal: StoreOp[] = [];
  /** Projection after the last journaled change (undefined: compute before the next one). */
  private view: OperationView | null | undefined;
  private stateBefore: Uint8Array | null = null;
  private prev: string | undefined;
  private group = '';
  private lastAt = 0;
  private snapshots = new Map<string, Uint8Array>();
  private knownSnapshots = new Set<string>();
  private beforeHandler: (tr: Y.Transaction) => void;
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
    // The projection before the next change is the one after the previous journaled change, so it is computed only
    // when nothing journaled it yet (first change of this persister, or after hydration). Unknown shapes keep a state.
    this.beforeHandler = (tr) => {
      if (tr.origin === this || this.view !== undefined) return;
      this.view = viewOf(this.docId, this.doc);
      this.stateBefore = this.view ? null : Y.encodeStateAsUpdate(this.doc);
    };
    doc.on('beforeTransaction', this.beforeHandler);
    this.handler = (u, origin) => {
      if (origin === this) { this.view = undefined; return; }
      const id = crypto.randomUUID();
      const source = this.opts.describeOrigin?.(origin) ?? { kind: 'editor', name: 'Unknown original author', provenance: 'unknown' };
      const at = Date.now();
      const record: OperationRecord = { v: 2, id, docId: this.docId, at, source, state: 'applied' };
      const authoredOpId = (origin as { operation?: { id?: unknown } } | null)?.operation?.id;
      if (typeof authoredOpId === 'string') record.authoredOpId = authoredOpId;
      const before = this.view ?? null, after = viewOf(this.docId, this.doc);
      const group = `${source.kind}:${source.uid ?? source.name}:${source.device ?? ''}`;
      if (before && after) {
        const delta = deltaOf(before, after);
        // A chain of reversible deltas starts at a deduplicated preimage: at each group start and before destructive changes.
        const snapshot = !this.prev || group !== this.group || at - this.lastAt > (this.opts.groupIdleMs ?? 3000) || removedShare(before, delta) > 0.5;
        if (snapshot) this.snapshots.set(id, encodeView(before));
        else record.prev = this.prev!;
        const encoded = new TextEncoder().encode(JSON.stringify(delta));
        if (encoded.length <= 16 * 1024) record.delta = delta;
        else record.deltaChunks = this.chunks(id, 'delta', encoded);
      } else {
        // No projection (a future shared type): keep the exact state and update, like the first journal format.
        record.beforeChunks = this.chunks(id, 'before', this.stateBefore ?? Y.encodeStateAsUpdate(new Y.Doc()));
        record.updateChunks = this.chunks(id, 'update', u);
      }
      this.view = after ?? undefined;
      this.stateBefore = after ? null : Y.encodeStateAsUpdate(this.doc);
      this.prev = before && after ? id : undefined; this.group = group; this.lastAt = at;
      this.journal.push({ op: 'meta', key: `operation:record:${id}`, value: record });
      this.opts.onOperation?.(record);
      this.pending.push(u);
      this.arm();
    };
    doc.on('update', this.handler);
  }

  private chunks(id: string, name: string, value: Uint8Array) {
    const size = 256 * 1024, count = Math.ceil(value.length / size);
    for (let n = 0; n < count; n++) this.journal.push({ op: 'meta', key: `operation:bytes:${id}:${name}:${n}`, value: value.slice(n * size, (n + 1) * size) });
    return count;
  }

  /** Content-addressed preimages: a snapshot already stored (or earlier in this batch) is referenced, not written again. */
  private async expandSnapshots(journal: StoreOp[]) {
    if (!this.snapshots.size) return journal;
    const out: StoreOp[] = [];
    const batch = new Set<string>();
    for (const op of journal) {
      const record = op.op === 'meta' && op.key.startsWith('operation:record:') ? op.value as OperationRecord : null;
      const bytes = record && this.snapshots.get(record.id);
      if (record && bytes) {
        const hash = await sha256Hex(bytes);
        record.snapshot = hash;
        if (!batch.has(hash) && !this.knownSnapshots.has(hash) && !(await this.store.getMeta(snapshotKey(hash)))) {
          const size = 256 * 1024, count = Math.ceil(bytes.length / size);
          for (let n = 0; n < count; n++) out.push({ op: 'meta', key: `${snapshotKey(hash)}:${n}`, value: bytes.slice(n * size, (n + 1) * size) });
          out.push({ op: 'meta', key: snapshotKey(hash), value: { v: 1, chunks: count, size: bytes.length } });
        }
        batch.add(hash);
        this.snapshots.delete(record.id);
      }
      out.push(op);
    }
    return out;
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
    }, this);
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
    let journal = this.journal;
    this.pending = [];
    this.journal = [];
    this.inflight++;
    let committed = 0;
    let separate = false;
    const groups: StoreOp[][] = [];
    try {
      if (batch.length > 0) {
        try {
          journal = await this.expandSnapshots(journal);
          let group: StoreOp[] = [];
          for (const op of journal) {
            group.push(op);
            if (op.op === 'meta' && op.key.startsWith('operation:record:')) { groups.push(group); group = []; }
          }
          const bytes = batch.reduce((n, u) => n + u.byteLength, 0) + journal.reduce((n, op) => n + (op.op === 'meta' && isBytes(op.value) ? op.value.byteLength : 256), 0);
          separate = bytes > 4 * 1024 * 1024 && groups.length === batch.length && group.length === 0;
          if (separate) {
            // Do not combine arbitrarily many full preimages into one unbounded IPC/SQLite transaction.
            // Each operation's document update and history commit together; a failed suffix is retried in order.
            for (let n = 0; n < batch.length; n++) {
              await this.store.transact([{ op: 'append', docId: this.docId, updates: [batch[n]!] }, ...groups[n]!]);
              committed++;
            }
          } else await this.store.transact([{ op: 'append', docId: this.docId, updates: [Y.mergeUpdates(batch)] }, ...journal]);
          this.stored += separate ? batch.length : 1;
          for (const op of journal) {
            const hash = op.op === 'meta' && op.key.startsWith('operation:record:') ? (op.value as OperationRecord).snapshot : undefined;
            if (hash) this.knownSnapshots.add(hash);
          }
        } catch (e) {
          if (!this.discarded) {
            // Retain exact update/record pairing, including only the uncommitted suffix of a large batch.
            this.pending = [...batch.slice(separate ? committed : 0), ...this.pending];
            this.journal = [...(separate ? groups.slice(committed).flat() : journal), ...this.journal];
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
    this.doc.off('beforeTransaction', this.beforeHandler);
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
    this.doc.off('beforeTransaction', this.beforeHandler);
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

/** Immutable recovery material committed atomically with the document update, before Changes grouping. */
export interface OperationRecord {
  authoredOpId?: string;
  /** 1: unreleased first format (full preimage per operation), read only. 2: reversible delta, written today. */
  v: 1 | 2;
  id: string;
  docId: string;
  at: number;
  source: ChangeSet['source'];
  /** Previous operation of this document's chain; the chain starts at a record with `snapshot`. */
  prev?: string;
  /** Reversible change, inline when small, else `deltaChunks` JSON chunks. */
  delta?: OperationDelta;
  deltaChunks?: number;
  /** Content hash of the full projection before this operation, stored once per distinct content. */
  snapshot?: string;
  /** Exact state and update: v1, and v2 documents without a projection (unknown shared types). */
  beforeChunks?: number;
  updateChunks?: number;
  state: 'applied';
}

const snapshotKey = (hash: string) => `operation:snapshot:${hash}`;
async function sha256Hex(bytes: Uint8Array) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}
async function readChunks(store: Persistence, key: (n: number) => string, count: unknown) {
  if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > 4096) throw new Error('Invalid operation content descriptor');
  const parts: Uint8Array[] = [];
  for (let n = 0; n < (count as number); n++) {
    const value = await store.getMeta(key(n));
    if (!isBytes(value)) throw new Error('Incomplete operation content');
    parts.push(value);
  }
  const bytes = new Uint8Array(parts.reduce((sum, b) => sum + b.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

/**
 * Projections before and after a journaled operation: v2 walks back to its chain's preimage and replays the deltas
 * (`cache` holds recent results, so replaying a journal in order stays linear). Null: no projection (exact states only).
 */
export async function operationViews(store: Persistence, record: OperationRecord, cache = new Map<string, OperationView>()): Promise<{ before: OperationView; after: OperationView } | null> {
  if (record.beforeChunks !== undefined) return null;
  const stack: OperationRecord[] = [];
  let base: OperationView | undefined;
  for (let r = record; ; ) {
    stack.push(r);
    if (r.snapshot) {
      const descriptor = await store.getMeta(snapshotKey(r.snapshot)) as { v?: number; chunks?: number } | undefined;
      if (descriptor?.v !== 1) throw new Error('Operation preimage is missing');
      const bytes = await readChunks(store, (n) => `${snapshotKey(r.snapshot!)}:${n}`, descriptor.chunks);
      if (await sha256Hex(bytes) !== r.snapshot) throw new Error('Operation preimage failed integrity verification');
      base = decodeView(r.docId, bytes);
      break;
    }
    const cached = r.prev && cache.get(r.prev);
    if (cached) { base = cached; break; }
    const prev = r.prev ? await store.getMeta(`operation:record:${r.prev}`) as OperationRecord | undefined : undefined;
    if (!prev || prev.v !== 2 || prev.docId !== r.docId || stack.length > 1_000_000) throw new Error('Operation history chain is incomplete');
    r = prev;
  }
  let before = base, after = base;
  for (const r of stack.reverse()) {
    const delta = r.delta ?? (r.deltaChunks !== undefined
      ? JSON.parse(new TextDecoder().decode(await readChunks(store, (n) => `operation:bytes:${r.id}:delta:${n}`, r.deltaChunks))) as OperationDelta
      : undefined);
    if (!delta) throw new Error('Operation delta is missing');
    before = after;
    after = applyDelta(after, delta, 1);
    cache.set(r.id, after);
    // Only recent projections are kept: a long journal must not hold every intermediate text in memory.
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
  }
  return { before, after };
}

/** Operation records, oldest first; `include` selects by record id from the keys alone, before any value is read. */
export async function listOperations(store: Persistence, include: (id: string) => boolean = () => true): Promise<OperationRecord[]> {
  if (!store.listMetaKeys) throw new Error('Operation listing is unavailable');
  const keys = (await store.listMetaKeys('operation:record:')).filter((k) => k.startsWith('operation:record:') && include(k.slice(17)));
  const records = await Promise.all(keys.map((k) => store.getMeta(k)));
  if (records.some((r) => (r as OperationRecord)?.v !== 1 && (r as OperationRecord)?.v !== 2)) throw new Error('Unsupported operation journal version; export before opening with older software');
  return (records as OperationRecord[]).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** Documents before and after a journaled operation (for readers that use Yjs accessors; see operationViews). */
export async function operationStates(store: Persistence, record: OperationRecord, cache?: Map<string, OperationView>) {
  const views = await operationViews(store, record, cache);
  if (views) return { before: docOfView(views.before), after: docOfView(views.after) };
  const read = (name: string, count: unknown) => readChunks(store, (n) => `operation:bytes:${record.id}:${name}:${n}`, count);
  const before = new Y.Doc();
  Y.applyUpdate(before, await read('before', record.beforeChunks));
  const after = new Y.Doc();
  Y.applyUpdate(after, Y.encodeStateAsUpdate(before));
  Y.applyUpdate(after, await read('update', record.updateChunks));
  return { before, after };
}
