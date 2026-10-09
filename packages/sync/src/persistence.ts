import * as Y from 'yjs';

/** Frozen copy of the project's content, used for local history. */
export interface HistorySnapshot {
  id: string;
  at: number;
  files: Array<{ path: string; kind: 'text' | 'binary' | 'dir'; text?: string; hash?: string; size?: number }>;
}

export interface Persistence {
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
  close(): void;
}

export class MemoryPersistence implements Persistence {
  docs = new Map<string, Uint8Array[]>();
  blobs = new Map<string, Uint8Array>();
  snaps: HistorySnapshot[] = [];
  meta = new Map<string, unknown>();
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
    return [...this.snaps];
  }
  async getMeta(key: string) {
    return this.meta.get(key);
  }
  async setMeta(key: string, value: unknown) {
    this.meta.set(key, value);
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
      const r = factory.open(name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('updates', { autoIncrement: true }).createIndex('doc', 'docId');
        db.createObjectStore('blobs');
        db.createObjectStore('snapshots', { keyPath: 'id' });
        db.createObjectStore('meta');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return p;
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
  close() {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Doc persistence driver: batched writes, periodic compaction
// ---------------------------------------------------------------------------------------------

export interface PersistOptions {
  flushMs?: number;
  compactAfter?: number;
}

export class DocPersister {
  private pending: Uint8Array[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stored = 0;
  private flushing: Promise<void> = Promise.resolve();
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
      if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.opts.flushMs ?? 250);
    };
    doc.on('update', this.handler);
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

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing = this.flushing.then(async () => {
      const batch = this.pending;
      this.pending = [];
      if (batch.length === 0) return;
      await this.store.append(this.docId, [Y.mergeUpdates(batch)]);
      this.stored += 1;
      if (this.stored >= (this.opts.compactAfter ?? 500)) {
        await this.store.compact(this.docId, Y.encodeStateAsUpdate(this.doc));
        this.stored = 1;
      }
    });
    return this.flushing;
  }

  async destroy() {
    this.doc.off('update', this.handler);
    await this.flush();
  }
}
