import { ROOT_DOC_ID, fileDocId } from '@hivetex/protocol';
import diff from 'fast-diff';
import * as Y from 'yjs';
import { DocPersister, type ChangeSet, type HistorySnapshot, type OperationRecord, type PersistOptions, type Persistence, type StoreOp } from './persistence.js';
import { AuthoredOrigin } from './authorship.js';
import { MIRROR_ORIGIN, IMPORT_ORIGIN, RESTORE_ORIGIN } from './origins.js';
import { PeerConnection } from './connection.js';

export type FileKind = 'text' | 'binary' | 'dir';

export interface FileEntry {
  id: string;
  path: string;
  kind: FileKind;
  /** SHA-256 hex of the content, for binary files. */
  hash?: string;
  size?: number;
}

/** Value of the root `tombstones` map: the removed entry (every field, binary versions included) and its deletion. */
export interface Tombstone { v: 1; entry: { path: string; kind: FileKind; hash?: string; size?: number; [field: string]: unknown }; deletion: DeletedFile['deletion'] }

/** Origin of the one-time conversion of development-store tombstones (see convertLegacyTombstones). */
export const LEGACY_TOMBSTONE_ORIGIN = 'legacy-tombstone-conversion';

export interface DeletedFile extends FileEntry {
  deletion: { v: 1; id: string; at: number; path: string; hash?: string; vector?: number[]; author?: ChangeSet['source']; resolvedFrom?: string };
  /** Content or path changed after, or concurrently with, the deletion. Kept until explicitly resolved. */
  conflict: boolean;
  conflictUnknown?: boolean;
}

/**
 * Project paths are POSIX-style and relative. Anything else (absolute, `..`, backslashes, drive letters, control
 * characters) could escape a directory when a peer's project is mirrored, compiled, zipped or pushed.
 */
export function isSafePath(p: string): boolean {
  if (!p || p.length > 512 || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function assertSafe(path: string) {
  if (!isSafePath(path)) throw new Error(`Invalid file path: ${path}`);
}

/** One change in `ProjectModel.applyBatch`. With `id`, `text`/`binary` overwrite that existing file. */
export type BatchOp =
  | { op: 'text'; path: string; text: string; id?: string }
  | { op: 'binary'; path: string; hash: string; size: number; id?: string }
  | { op: 'delete'; id: string }
  | { op: 'setting'; key: string; value: unknown };

export type DocUpdateListener = (docId: string, update: Uint8Array, origin: unknown) => void;

export const LOCAL_ORIGIN = Symbol('local');

const newId = () => {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Applies the minimal diff turning `ytext` into `next` as a single transaction (keeps remote cursors stable). */
export function applyTextDiff(ytext: Y.Text, next: string, origin: unknown = LOCAL_ORIGIN) {
  const cur = ytext.toString();
  if (cur === next) return;
  const ops = diff(cur, next);
  ytext.doc?.transact(() => {
    let pos = 0;
    for (const [op, text] of ops) {
      if (op === diff.EQUAL) pos += text.length;
      else if (op === diff.INSERT) {
        ytext.insert(pos, text);
        pos += text.length;
      } else ytext.delete(pos, text.length);
    }
  }, origin);
}

/**
 * What this device holds of a document, independent of whether it is loaded or stored and of whether any peer is
 * connected. `unknown`: nothing is known of its content (a file-table entry or an allocated empty document says
 * nothing). `partial`: some content is here but nobody confirmed it is all of it. `complete`: created on this device,
 * or confirmed by a peer (an empty answer included), or restored from storage as such.
 */
export type Availability = 'unknown' | 'partial' | 'complete';

/** Metadata key of the persisted completeness record (see ProjectModel.markComplete). */
const AVAILABILITY_KEY = 'availability';
// Include Yjs's delete set: a deletion of characters does not advance its state vector.
export const docFrontier = (doc: Y.Doc) => [...Y.encodeStateVector(doc), -1, ...Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc))];
const frontier = docFrontier;

/** Whether this device's edits are safely stored locally; independent of whether any peer has them. */
export interface SaveState {
  /** True while a write failed and its edits are only held in memory (they keep being retried). */
  failing: boolean;
  /** Documents whose edits are not safely stored. */
  docs: string[];
  error: unknown;
}

/**
 * The project's CRDT state: a root document (file table + settings) and one lazily-loaded document per
 * text file. Files are keyed by a stable random id so rename/move is a single field update (never
 * delete+create), which makes concurrent rename+edit converge without duplicates.
 */
export class ProjectModel {
  private durability = new Set<Promise<unknown>>();
  private durabilityErrors = new Map<string, unknown>();
  private durabilityWaiters = new Set<(error: unknown) => void>();
  trackDurability(work: Promise<unknown>) {
    this.durability.add(work);
    void work.then(() => this.durability.delete(work), () => this.durability.delete(work));
  }
  /** Keys whose failure stays visible in saveState and keeps retrying, but does not make flush() reject (provenance). */
  private softErrors = new Set<string>();
  durabilityError(key: string, error: unknown | null, opts: { blocking?: boolean } = {}) {
    if (error === null) { this.durabilityErrors.delete(key); this.softErrors.delete(key); }
    else if (opts.blocking === false) { this.durabilityErrors.set(key, error); this.softErrors.add(key); }
    else { this.durabilityErrors.set(key, error); this.softErrors.delete(key); for (const reject of this.durabilityWaiters) reject(error); }
    this.refreshSave();
  }
  localAuthor: { uid?: string; device?: string; name: string } = { name: 'This device' };
  private operationListeners = new Set<(record: OperationRecord) => void>();
  onOperation(cb: (record: OperationRecord) => void) { this.operationListeners.add(cb); return () => this.operationListeners.delete(cb); }

  operationSource(origin: unknown): ChangeSet['source'] {
    if (origin instanceof AuthoredOrigin) return { kind: 'peer', name: origin.claims.uname, uid: origin.claims.uid, device: origin.claims.dev, provenance: 'verified' };
    if (origin instanceof PeerConnection) return { kind: 'peer', name: 'Unknown original author (legacy sync)', provenance: 'unknown' };
    const kind = origin === MIRROR_ORIGIN || (origin as { kind?: string } | null)?.kind === 'folder' ? 'folder' : origin === 'changelog-undo' ? 'undo' : origin === IMPORT_ORIGIN ? 'import' : origin === RESTORE_ORIGIN ? 'restore' : 'editor';
    return { kind, ...this.localAuthor, ...(this.localAuthor.uid ? { actorName: this.localAuthor.name } : {}), ...(kind === 'folder' ? { name: 'Folder on this device' } : kind === 'undo' ? { name: 'Undo' } : {}) };
  }
  private rootDoc = new Y.Doc();
  private docs = new Map<string, Y.Doc>();
  private replacedListeners = new Set<(docId: string) => void>();
  private beforeChangeListeners = new Set<(docId: string, doc: Y.Doc, origin: unknown) => void>();
  private unobserveFiles: () => void = () => {};
  private persisters = new Map<string, DocPersister>();
  private loading = new Map<string, Promise<Y.Doc>>();
  private listeners = new Set<DocUpdateListener>();
  private fileListeners = new Set<() => void>();
  private saveListeners = new Set<(s: SaveState) => void>();
  private replaceFailing = new Map<object, { docs: string[]; error: unknown }>();
  private saveKey = '';
  private closed = false;
  /** Documents known to be complete (persisted under AVAILABILITY_KEY). */
  private complete = new Set<string>();
  /** Local creation evidence, independent of the completeness of subsequently received text bodies. */
  private initializedHere = false;
  private availListeners = new Set<(docId: string) => void>();
  private availTimer: ReturnType<typeof setTimeout> | null = null;
  private availWrite: Promise<void> = Promise.resolve();
  /** Documents that were in storage when the project opened (not necessarily loaded yet): some content, so at least partial. */
  private storedAtOpen = new Set<string>();
  /** Counts updates per document, so a decision taken over several awaits can tell whether the document moved. */
  private revs = new Map<string, number>();
  /** Counts every document update seen, across documents: a consumer that captured it knows which later edits it did not include. */
  private seq = 0;

  constructor(
    readonly store: Persistence,
    private persistOpts: PersistOptions = {},
  ) {
    this.attachRoot();
  }

  /** The root document (file table + settings). It can be replaced (offline merge, see fork.ts): read it each time. */
  get root(): Y.Doc {
    return this.rootDoc;
  }

  private attachRoot() {
    this.docs.set(ROOT_DOC_ID, this.rootDoc);
    this.rootDoc.on('update', (u: Uint8Array, origin: unknown) => this.emit(ROOT_DOC_ID, u, origin));
    this.watchBefore(ROOT_DOC_ID, this.rootDoc);
    const files = this.files;
    const onFiles = () => {
      for (const l of this.fileListeners) l();
    };
    files.observeDeep(onFiles);
    this.unobserveFiles = () => files.unobserveDeep(onFiles);
  }

  private watchBefore(docId: string, doc: Y.Doc) {
    doc.on('beforeTransaction', (tr: Y.Transaction) => {
      if (tr.origin instanceof DocPersister) return;
      for (const l of this.beforeChangeListeners) l(docId, doc, tr.origin);
    });
  }

  /** Called before every transaction on any document that does not come from local storage (so the state before a change can be kept). */
  onBeforeChange(l: (docId: string, doc: Y.Doc, origin: unknown) => void) {
    this.beforeChangeListeners.add(l);
    return () => this.beforeChangeListeners.delete(l);
  }

  /** Called after a document was replaced by `replaceDoc`: holders of the old document (editors, observers) re-attach. */
  onDocReplaced(l: (docId: string) => void) {
    this.replacedListeners.add(l);
    return () => this.replacedListeners.delete(l);
  }

  /**
   * Replaces a document by a new one built from `state`, also in local storage. Used by the offline merge to share
   * the last shared state instead of offline edits (fork.ts). The old document is left alive for whoever still holds it.
   */
  replaceDoc(docId: string, state: Uint8Array, meta: StoreOp[] = []): Promise<void> {
    return this.replaceDocs([{ docId, state }], meta);
  }

  /**
   * Replaces several documents at once, together with metadata (e.g. a recovery journal), as one atomic storage
   * transition. The in-memory swap is synchronous, so no edit can land between the old and the new document. Writes
   * to the old documents that are still under way finish first, and nothing is written to the new ones before the
   * replacement is stored, so a delayed write can never resurrect replaced content. If storage fails, the returned
   * promise rejects but the replacement keeps being retried, and edits made meanwhile are retained.
   */
  replaceDocs(items: Array<{ docId: string; state: Uint8Array }>, meta: StoreOp[] = []): Promise<void> {
    const settled: Promise<void>[] = [];
    const persisters: DocPersister[] = [];
    for (const { docId, state } of items) {
      const old = this.persisters.get(docId);
      if (old) settled.push(old.discard());
      this.persisters.delete(docId);
      const doc = new Y.Doc({ gc: true });
      Y.applyUpdate(doc, state);
      if (docId === ROOT_DOC_ID) {
        this.unobserveFiles();
        this.rootDoc = doc;
        this.attachRoot();
      } else {
        this.docs.set(docId, doc);
        doc.on('update', (u: Uint8Array, origin: unknown) => this.emit(docId, u, origin));
        this.watchBefore(docId, doc);
      }
      this.revs.set(docId, (this.revs.get(docId) ?? 0) + 1);
      this.seq++;
      const persister = new DocPersister(this.store, docId, doc, this.persistenceOptions());
      this.persisters.set(docId, persister);
      persisters.push(persister);
    }
    const ops: StoreOp[] = [...items.map(({ docId, state }): StoreOp => ({ op: 'compact', docId, state })), ...meta];
    const group = {};
    let reject: (e: unknown) => void = () => {};
    let resolve: () => void = () => {};
    const committed = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const gate = (async () => {
      const base = this.persistOpts.retryMs ?? 500;
      for (let n = 0; ; n++) {
        try {
          await Promise.all(settled);
          await this.store.transact(ops);
          this.replaceFailing.delete(group);
          this.refreshSave();
          resolve();
          return;
        } catch (e) {
          this.replaceFailing.set(group, { docs: items.map((i) => i.docId), error: e });
          this.refreshSave();
          if (n === 0) reject(e);
          if (this.closed) return;
          await new Promise((r) => setTimeout(r, Math.min(this.persistOpts.maxRetryMs ?? 30_000, base * 2 ** Math.min(n, 16))));
        }
      }
    })();
    for (const p of persisters) p.holdUntil(gate);
    for (const l of this.fileListeners) l();
    for (const { docId } of items) for (const l of this.replacedListeners) l(docId);
    return committed.then(() => Promise.all(persisters.map((p) => p.flush()))).then(() => {});
  }

  private persistenceOptions(): PersistOptions {
    return {
      ...this.persistOpts,
      describeOrigin: (origin) => this.operationSource(origin),
      onOperation: (record) => { for (const cb of this.operationListeners) cb(record); },
      onStatus: (docId) => {
        this.persistOpts.onStatus?.(docId);
        this.refreshSave();
      },
    };
  }

  /** Local durability right now (see SaveState). */
  get saveState(): SaveState {
    const docs: string[] = [];
    let error: unknown = null;
    for (const [key, value] of this.durabilityErrors) { docs.push(`history:${key}`); error ??= value; }
    for (const [id, p] of this.persisters) {
      const st = p.status;
      if (!st.failing) continue;
      docs.push(id);
      error ??= st.error;
    }
    for (const f of this.replaceFailing.values()) {
      for (const d of f.docs) if (!docs.includes(d)) docs.push(d);
      error ??= f.error;
    }
    return { failing: docs.length > 0, docs, error };
  }

  /** Subscribes to changes of saveState: it flips to failing on a failed write and back once a write commits. */
  onSaveState(l: (s: SaveState) => void) {
    this.saveListeners.add(l);
    return () => this.saveListeners.delete(l);
  }

  private refreshSave() {
    const st = this.saveState;
    const key = [...st.docs].sort().join('|');
    if (key === this.saveKey) return;
    this.saveKey = key;
    for (const l of this.saveListeners) l(st);
  }

  get files(): Y.Map<Y.Map<unknown>> {
    return this.root.getMap('files') as Y.Map<Y.Map<unknown>>;
  }
  get settings(): Y.Map<unknown> {
    return this.root.getMap('settings');
  }
  get meta(): Y.Map<unknown> {
    return this.root.getMap('meta');
  }

  async init() {
    const format = await this.store.getMeta('safetyFormat') as { v?: number } | undefined;
    if (format && format.v !== 1) throw new Error('Unsupported recovery format; preserve and export this store with a compatible version');
    if (!format) await this.store.setMeta('safetyFormat', { v: 1 });
    if (!this.localAuthor.uid) {
      const author = await this.store.getMeta('localAuthor') as typeof this.localAuthor | undefined;
      if (author && typeof author.uid === 'string' && typeof author.name === 'string') this.localAuthor = author;
    }
    const p = new DocPersister(this.store, ROOT_DOC_ID, this.root, this.persistenceOptions());
    this.persisters.set(ROOT_DOC_ID, p);
    await p.hydrate();
    this.convertLegacyTombstones();
    await this.loadAvailability();
  }

  // ---- availability ----

  /**
   * Restores which documents are complete. A store written before completeness was tracked has no record: the
   * documents it holds were all that this device had, so they stay usable and count as complete (a fresh store
   * starts an empty record, so content that merely arrived later is never mistaken for it).
   */
  private async loadAvailability() {
    let rec: unknown;
    try {
      rec = await this.store.getMeta(AVAILABILITY_KEY);
    } catch {
      return;
    }
    const docs = (rec as { docs?: unknown } | undefined)?.docs;
    this.initializedHere = (rec as { v?: unknown; initializedHere?: unknown } | undefined)?.v === 1
      && (rec as { initializedHere?: unknown }).initializedHere === true;
    const stored = await this.store.listDocs();
    for (const d of stored) this.storedAtOpen.add(d);
    if (Array.isArray(docs)) {
      for (const d of docs) if (typeof d === 'string') this.complete.add(d);
      if (this.initializedHere && !this.complete.has(ROOT_DOC_ID)) this.markComplete(ROOT_DOC_ID);
      return;
    }
    for (const d of stored) this.complete.add(d);
    this.scheduleAvailability();
  }

  /** For local creation, or an explicitly confirmed complete-source replacement (never a merge import). */
  async initializeLocal(replacedSources = false) {
    if (replacedSources) for (const f of this.list()) if (f.kind === 'text') this.markComplete(fileDocId(f.id));
    this.initializedHere = true;
    this.markComplete(ROOT_DOC_ID);
    this.scheduleAvailability();
    await this.flush();
  }

  /** What this device holds of the document right now (synchronous: it never consults peers or storage). */
  availability(docId: string): Availability {
    if (this.complete.has(docId)) return 'complete';
    return (this.docs.get(docId)?.store.clients.size ?? 0) > 0 || this.storedAtOpen.has(docId) ? 'partial' : 'unknown';
  }

  /**
   * Records that the document holds all of its content: it was created here, or a peer confirmed its full state.
   * The record is saved after the document's own edits, so a record never vouches for content that was not stored.
   */
  markComplete(docId: string) {
    if (this.complete.has(docId)) return;
    this.complete.add(docId);
    this.scheduleAvailability();
    for (const l of this.availListeners) l(docId);
  }

  /** Fires when a document becomes complete. */
  onAvailability(l: (docId: string) => void) {
    this.availListeners.add(l);
    return () => this.availListeners.delete(l);
  }

  /** Text files whose content is not complete on this device (listed in the file table, not received or only partly). */
  missingText(): FileEntry[] {
    return this.list().filter((f) => f.kind === 'text' && this.availability(fileDocId(f.id)) !== 'complete');
  }

  /** Updates seen by a document so far; unchanged means the document did not move in between. */
  revision(docId: string): number {
    return this.revs.get(docId) ?? 0;
  }

  /** Updates of any document seen so far (already counted when update listeners run). */
  get changeSeq(): number {
    return this.seq;
  }

  private scheduleAvailability(delay = this.persistOpts.flushMs ?? 250) {
    if (this.availTimer || this.closed) return;
    this.availTimer = setTimeout(() => {
      this.availTimer = null;
      this.writeAvailability().catch(() => this.scheduleAvailability(this.persistOpts.retryMs ?? 500));
    }, delay);
  }

  private writeAvailability(): Promise<void> {
    const run = async () => {
      const docs = [...this.complete];
      // Content first: the record must never outlive the edits it vouches for.
      await Promise.all([...this.persisters.values()].map((p) => p.flush()));
      try {
        await this.store.setMeta(AVAILABILITY_KEY, { v: 1, docs, ...(this.initializedHere ? { initializedHere: true } : {}) });
        this.durabilityError('availability', null);
      } catch (error) {
        this.durabilityError('availability', error);
        this.scheduleAvailability(this.persistOpts.retryMs ?? 500);
        throw error;
      }
    };
    const next = this.availWrite.then(run, run);
    this.availWrite = next;
    void next.catch(() => {});
    return next;
  }

  onDocUpdate(l: DocUpdateListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  onFilesChanged(l: () => void) {
    this.fileListeners.add(l);
    return () => this.fileListeners.delete(l);
  }
  private emit(docId: string, u: Uint8Array, origin: unknown) {
    this.revs.set(docId, (this.revs.get(docId) ?? 0) + 1);
    this.seq++;
    for (const l of this.listeners) l(docId, u, origin);
  }

  // ---- doc management (lazy) ----

  loadedDocIds() {
    return [...this.docs.keys()];
  }

  /** Doc ids with persisted data (so offline edits to unopened files still sync on reconnect). */
  async knownDocIds(): Promise<string[]> {
    const persisted = await this.store.listDocs();
    return [...new Set([ROOT_DOC_ID, ...persisted, ...this.docs.keys()])];
  }

  getLoadedDoc(docId: string): Y.Doc | undefined {
    return this.docs.get(docId);
  }

  /** Loads (or creates) a file document. Concurrent callers share one load. */
  async getDoc(docId: string): Promise<Y.Doc> {
    const existing = this.docs.get(docId);
    if (existing) return existing;
    const inflight = this.loading.get(docId);
    if (inflight) return inflight;
    const p = (async () => {
      const doc = new Y.Doc({ gc: true });
      const persister = new DocPersister(this.store, docId, doc, this.persistenceOptions());
      try {
        await persister.hydrate();
      } catch (e) {
        this.loading.delete(docId); // a failed load is not remembered: the next request tries again
        throw e;
      }
      doc.on('update', (u: Uint8Array, origin: unknown) => this.emit(docId, u, origin));
      this.watchBefore(docId, doc);
      this.docs.set(docId, doc);
      this.persisters.set(docId, persister);
      this.loading.delete(docId);
      return doc;
    })();
    this.loading.set(docId, p);
    return p;
  }

  async openText(fileId: string): Promise<Y.Text> {
    return (await this.getDoc(fileDocId(fileId))).getText('t');
  }

  /** Releases a file doc from memory (state remains persisted). */
  async unload(docId: string) {
    if (docId === ROOT_DOC_ID) return;
    const p = this.persisters.get(docId);
    // Unsaved edits (storage failing) stay in memory: the document is only released once they are written.
    try {
      await p?.destroy();
    } catch {
      return;
    }
    this.persisters.delete(docId);
    this.docs.get(docId)?.destroy();
    this.docs.delete(docId);
  }

  async flush() {
    for (const [key, error] of this.durabilityErrors) if (!this.softErrors.has(key)) throw error;
    let reject: (error: unknown) => void = () => {};
    const failed = new Promise<never>((_resolve, rej) => { reject = rej; });
    failed.catch(() => {});
    this.durabilityWaiters.add(reject);
    try {
    await Promise.all([...this.persisters.values()].map((p) => p.flush()));
    await Promise.race([Promise.all([...this.durability]), failed]);
    if (this.availTimer) {
      clearTimeout(this.availTimer);
      this.availTimer = null;
      await this.writeAvailability();
    }
    await this.availWrite;
    } finally { this.durabilityWaiters.delete(reject); }
  }

  /** Writes everything and stops. Rejects if some edits could not be saved (they stay in memory, and the failure stays visible). */
  async destroy() {
    this.closed = true;
    if (this.availTimer) clearTimeout(this.availTimer);
    this.availTimer = null;
    const results = await Promise.allSettled([...this.persisters.values()].map((p) => p.destroy()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    await this.writeAvailability().catch(() => {});
  }

  // ---- file table ----

  list(): FileEntry[] {
    const out: FileEntry[] = [];
    this.files.forEach((m, id) => {
      if (m.get('deleted')) return;
      const raw = String(m.get('path'));
      out.push({
        id,
        path: isSafePath(raw) ? raw : `_unsafe_/${id}`,
        kind: m.get('kind') as FileKind,
        ...(m.get('hash') ? { hash: String(m.get('hash')) } : {}),
        ...(m.get('size') !== undefined ? { size: Number(m.get('size')) } : {}),
      });
    });
    // Deterministic view: if two files concurrently claimed one path, the lowest id keeps it and the
    // other is shown with a numeric suffix (both stay editable; nothing is overwritten or lost).
    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    const seen = new Set<string>();
    for (const f of out) {
      let p = f.path;
      for (let n = 2; seen.has(p); n++) p = withSuffix(f.path, n);
      seen.add(p);
      f.path = p;
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  find(path: string): FileEntry | undefined {
    return this.list().find((f) => f.path === path);
  }

  byId(id: string): FileEntry | undefined {
    return this.list().find((f) => f.id === id);
  }

  /** Puts back a file entry under its id (offline merge: a file added or kept on this device). */
  putEntry(id: string, entry: { path: string; kind: FileKind; hash?: string | null; size?: number }, origin: unknown = LOCAL_ORIGIN) {
    assertSafe(entry.path);
    this.root.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('path', entry.path);
      m.set('kind', entry.kind);
      if (entry.hash) m.set('hash', entry.hash);
      if (entry.size !== undefined) m.set('size', entry.size);
      this.files.set(id, m);
    }, origin);
  }

  createText(path: string, content = '', origin: unknown = LOCAL_ORIGIN): string {
    assertSafe(path);
    const id = newId();
    // Created here: this device is where its content comes from, so even an empty file is complete.
    this.markComplete(fileDocId(id));
    this.root.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('path', path);
      m.set('kind', 'text');
      this.files.set(id, m);
    }, origin);
    if (content) {
      void this.getDoc(fileDocId(id)).then((d) => d.transact(() => d.getText('t').insert(0, content), origin));
    }
    return id;
  }

  /** Creates a text file and waits until its content has been written. */
  async createTextNow(path: string, content = '', origin: unknown = LOCAL_ORIGIN, canApply: () => boolean = () => true): Promise<string> {
    assertSafe(path);
    if (!canApply()) throw new Error('denied');
    const id = newId(), d = await this.getDoc(fileDocId(id));
    if (!canApply()) throw new Error('denied');
    // Loading precedes the mutation boundary: a demotion cannot leave a published empty entry behind.
    if (content) d.transact(() => d.getText('t').insert(0, content), origin);
    this.markComplete(fileDocId(id));
    this.putEntry(id, { path, kind: 'text' }, origin);
    return id;
  }

  createDir(path: string, origin: unknown = LOCAL_ORIGIN): string {
    assertSafe(path);
    const id = newId();
    this.root.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('path', path);
      m.set('kind', 'dir');
      this.files.set(id, m);
    }, origin);
    return id;
  }

  createBinary(path: string, hash: string, size: number, origin: unknown = LOCAL_ORIGIN): string {
    assertSafe(path);
    const id = newId();
    this.root.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('path', path);
      m.set('kind', 'binary');
      m.set('hash', hash);
      m.set('size', size);
      m.set(`version:${hash}`, { hash, size, parent: null, at: Date.now() });
      this.files.set(id, m);
    }, origin);
    return id;
  }

  setBinary(id: string, hash: string, size: number, origin: unknown = LOCAL_ORIGIN) {
    this.root.transact(() => {
      const m = this.files.get(id);
      const parent = m?.get('hash');
      if (parent && !m?.has(`version:${parent}`)) m?.set(`version:${parent}`, { hash: parent, size: m.get('size') ?? 0, parent: null, at: Date.now() });
      if (parent !== hash) m?.set(`version:${hash}`, { hash, size, parent: parent ?? null, at: Date.now() });
      m?.set('hash', hash);
      m?.set('size', size);
    }, origin);
  }

  binaryVersions(id: string): Array<{ hash: string; size: number; parent: string | null; at: number }> {
    const m = this.files.get(id);
    return m ? [...m].filter(([key]) => key.startsWith('version:')).map(([, v]) => v as { hash: string; size: number; parent: string | null; at: number }) : [];
  }

  binaryConflicts(): Array<{ id: string; path: string; hashes: string[] }> {
    const result: Array<{ id: string; path: string; hashes: string[] }> = [];
    for (const f of this.list()) if (f.kind === 'binary') {
      const resolution = this.files.get(f.id)?.get('binaryResolution') as { hash: string; seen: string[] } | undefined;
      const branches = new Map<string, string[]>();
      for (const v of this.binaryVersions(f.id)) if (v.parent) {
        const values = branches.get(v.parent) ?? []; values.push(v.hash); branches.set(v.parent, values);
      }
      const hashes = [...new Set([...branches.values()].filter((g) => g.length > 1 && (!resolution || g.some((h) => !resolution.seen.includes(h)))).flat())];
      if (hashes.length && resolution && !hashes.includes(resolution.hash)) hashes.push(resolution.hash);
      if (hashes.length) result.push({ id: f.id, path: f.path, hashes });
    }
    return result;
  }

  resolveBinary(id: string, hash: string, canApply: () => boolean = () => true, expectedRevision?: number) {
    const version = this.binaryVersions(id).find((v) => v.hash === hash);
    if (!version) throw new Error('Unknown binary version');
    if (expectedRevision !== undefined && this.changeSeq !== expectedRevision) throw new Error('File changed after conflict preview; refresh before deciding');
    if (!canApply()) throw new Error('denied');
    this.root.transact(() => {
      const entry = this.files.get(id);
      entry?.set('hash', version.hash); entry?.set('size', version.size);
      entry?.set('binaryResolution', { hash, seen: this.binaryVersions(id).map((v) => v.hash), id: newId(), at: Date.now(), author: this.operationSource(LOCAL_ORIGIN) });
    }, LOCAL_ORIGIN);
  }

  async recoveryFiles(): Promise<Array<FileEntry & { orphan?: boolean; conflict?: boolean; deletionId?: string }>> {
    const known = await this.knownDocIds();
    const deleted = this.deletedFiles().map((f) => ({ ...f, deletionId: f.deletion.id }));
    const entries = new Set([...this.list(), ...deleted].map((f) => f.id));
    const orphans = known.filter((doc) => doc.startsWith('f:') && !entries.has(doc.slice(2)))
      .map((doc) => ({ id: doc.slice(2), path: `Recovered/${doc.slice(2)}.tex`, kind: 'text' as const, orphan: true }));
    return [...deleted, ...orphans];
  }

  async recoveryState() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const revision = this.changeSeq;
      const files = await this.recoveryFiles();
      if (revision === this.changeSeq) return { files, binary: this.binaryConflicts(), revision };
    }
    throw new Error('Recovery changed while loading; refresh before deciding');
  }

  /** Rename and move are the same operation: change the path. */
  rename(id: string, newPath: string, origin: unknown = LOCAL_ORIGIN) {
    assertSafe(newPath);
    this.root.transact(() => this.files.get(id)?.set('path', newPath), origin);
  }

  /** Moves a directory and everything under it. */
  renameTree(oldPath: string, newPath: string) {
    this.root.transact(() => {
      for (const f of this.list()) {
        if (f.path === oldPath) this.rename(f.id, newPath);
        else if (f.path.startsWith(`${oldPath}/`)) this.rename(f.id, newPath + f.path.slice(oldPath.length));
      }
    }, LOCAL_ORIGIN);
  }

  /** Recoverable deletions: entries moved out of `files`, so a previous release (0.8.0) sees an ordinary deletion. */
  get tombstones(): Y.Map<Tombstone> {
    return this.root.getMap('tombstones') as Y.Map<Tombstone>;
  }

  delete(id: string, origin: unknown = LOCAL_ORIGIN) {
    const m = this.files.get(id);
    if (!m || m.get('deleted')) return;
    const doc = this.docs.get(fileDocId(id));
    const deletion: DeletedFile['deletion'] = {
      v: 1, id: newId(), at: Date.now(), path: String(m.get('path')),
      author: this.operationSource(origin),
      ...(m.get('hash') ? { hash: String(m.get('hash')) } : {}),
      ...(doc && this.availability(fileDocId(id)) === 'complete' ? { vector: frontier(doc) } : {}),
    };
    // The entry (same id) and its document stay recoverable; a concurrent edit is compared against the frontier.
    this.root.transact(() => { this.tombstones.set(id, { v: 1, entry: m.toJSON() as Tombstone['entry'], deletion }); this.files.delete(id); }, origin);
  }

  /** Moves development-store tombstones (a `deleted` field inside `files`) to the tombstone map. Idempotent. */
  convertLegacyTombstones() {
    const legacy = [...this.files].filter(([, m]) => (m.get('deleted') as { v?: unknown } | undefined)?.v === 1);
    if (!legacy.length) return 0;
    this.root.transact(() => {
      for (const [id, m] of legacy) {
        const { deleted, ...entry } = m.toJSON() as Tombstone['entry'] & { deleted: DeletedFile['deletion'] };
        if (!this.tombstones.has(id)) this.tombstones.set(id, { v: 1, entry, deletion: deleted });
        this.files.delete(id);
      }
    }, LEGACY_TOMBSTONE_ORIGIN);
    return legacy.length;
  }

  deletedFiles(): DeletedFile[] {
    const result: DeletedFile[] = [];
    const add = (id: string, entry: Record<string, unknown>, deletion: DeletedFile['deletion'] | undefined) => {
      if (!deletion || deletion.v !== 1) return;
      const kind = entry.kind as FileKind;
      const doc = this.docs.get(fileDocId(id));
      const vector = doc ? frontier(doc) : undefined;
      const conflictUnknown = kind === 'text' && (!doc || this.availability(fileDocId(id)) !== 'complete' || !deletion.vector);
      const conflict = String(entry.path) !== deletion.path || (kind === 'binary'
        ? entry.hash !== deletion.hash
        : kind === 'text' && (!vector || !deletion.vector || vector.length !== deletion.vector.length || vector.some((v, i) => v !== deletion.vector?.[i])));
      result.push({ id, path: String(entry.path), kind, deletion, conflict, conflictUnknown,
        ...(entry.hash ? { hash: String(entry.hash) } : {}),
        ...(entry.size !== undefined ? { size: Number(entry.size) } : {}),
      });
    };
    // A live entry wins over a tombstone (a restore concurrent with another deletion): nothing visible is hidden.
    this.tombstones.forEach((t, id) => { if (!this.files.has(id) && t?.v === 1 && t.entry) add(id, t.entry, t.deletion); });
    this.files.forEach((m, id) => { add(id, m.toJSON() as Record<string, unknown>, m.get('deleted') as DeletedFile['deletion'] | undefined); });
    return result.sort((a, b) => b.deletion.at - a.deletion.at);
  }

  /** Explicit, collaborative recovery. The deletion token prevents a stale dialog from undoing a newer delete. */
  restoreDeleted(id: string, deletionId: string, path?: string, canApply: () => boolean = () => true) {
    const f = this.deletedFiles().find((item) => item.id === id && item.deletion.id === deletionId);
    if (!f) throw new Error('Deletion changed; refresh Recovery before restoring');
    const dest = path ?? f.path;
    assertSafe(dest);
    if (this.find(dest)) throw new Error('Recovery path is occupied; choose another name');
    if (!canApply()) throw new Error('denied');
    this.root.transact(() => {
      const legacy = this.files.get(id);
      if (legacy) { legacy.set('path', dest); legacy.delete('deleted'); return; }
      const t = this.tombstones.get(id);
      const m = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(t?.entry ?? {})) if (k !== 'deleted') m.set(k, v);
      m.set('path', dest);
      this.files.set(id, m);
      this.tombstones.delete(id);
    }, LOCAL_ORIGIN);
  }

  confirmDeletion(id: string, deletionId: string, expectedRevision: number, canApply: () => boolean = () => true) {
    const f = this.deletedFiles().find((item) => item.id === id && item.deletion.id === deletionId);
    if (!f || this.changeSeq !== expectedRevision) throw new Error('File changed after conflict preview; refresh before deciding');
    if (!canApply()) throw new Error('denied');
    if (f.kind === 'text' && this.availability(fileDocId(id)) !== 'complete') throw new Error('File content is not complete; receive it before resolving the deletion');
    const doc = this.docs.get(fileDocId(id));
    const deletion = { ...f.deletion, id: newId(), at: Date.now(), path: f.path,
      author: this.operationSource(LOCAL_ORIGIN), resolvedFrom: f.deletion.id,
      ...(f.hash ? { hash: f.hash } : {}), ...(doc ? { vector: frontier(doc) } : {}) };
    this.root.transact(() => {
      const legacy = this.files.get(id);
      if (legacy) legacy.set('deleted', deletion);
      else this.tombstones.set(id, { ...this.tombstones.get(id)!, deletion });
    }, LOCAL_ORIGIN);
  }

  /**
   * Removes duplicate entries for the same path whose content is identical, keeping the lowest id. This is
   * what happens when two devices imported the same GitHub backup / zip independently and later merged.
   * Entries with different content are left alone (both stay visible; nothing is overwritten).
   *
   * Equality needs the complete contents: a text file that is missing, partly received or still being reconciled
   * (`settled` says no) is never compared, so two bodies that have not arrived yet cannot look identical. The decision
   * is taken over several awaits, so right before deleting it is checked again, synchronously, against the entries and
   * the document revisions it started from; anything that moved in between keeps both files until a fresh pass.
   */
  async dedupeIdentical(opts: { settled?: (docId: string) => boolean } = {}): Promise<number> {
    const byPath = new Map<string, Array<{ id: string; kind: FileKind; hash?: string }>>();
    this.files.forEach((m, id) => {
      if (m.get('deleted')) return;
      const path = String(m.get('path'));
      const arr = byPath.get(path) ?? [];
      arr.push({ id, kind: m.get('kind') as FileKind, ...(m.get('hash') ? { hash: String(m.get('hash')) } : {}) });
      byPath.set(path, arr);
    });
    const entryOf = (id: string) => this.files.get(id);
    const sig = (id: string) => {
      const m = entryOf(id);
      return m ? `${String(m.get('path'))}|${String(m.get('kind'))}|${String(m.get('hash') ?? '')}` : null;
    };
    let removed = 0;
    for (const entries of byPath.values()) {
      if (entries.length < 2) continue;
      entries.sort((a, b) => (a.id < b.id ? -1 : 1));
      const keep = entries[0] as (typeof entries)[number];
      for (const e of entries.slice(1)) {
        if (e.kind !== keep.kind) continue;
        const start = [entryOf(keep.id), entryOf(e.id), sig(keep.id), sig(e.id)] as const;
        let still: () => boolean;
        if (e.kind === 'dir') still = () => true;
        else if (e.kind === 'binary') {
          if (!e.hash || e.hash !== keep.hash) continue;
          still = () => true;
        } else {
          const ids = [fileDocId(keep.id), fileDocId(e.id)];
          const ready = () => ids.every((d) => this.complete.has(d) && (opts.settled?.(d) ?? true));
          if (!ready()) continue;
          const revs = ids.map((d) => this.revision(d));
          const [a, b] = [(await this.openText(keep.id)).toString(), (await this.openText(e.id)).toString()];
          if (a !== b) continue;
          still = () => ready() && ids.every((d, i) => this.revision(d) === revs[i]) && this.docs.get(ids[0] as string)?.getText('t').toString() === this.docs.get(ids[1] as string)?.getText('t').toString();
        }
        // Nothing is awaited from here to the deletion: the checks and the delete happen as one step.
        if (entryOf(keep.id) !== start[0] || entryOf(e.id) !== start[1] || sig(keep.id) !== start[2] || sig(e.id) !== start[3] || !still()) continue;
        this.delete(e.id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Applies many file changes so peers see one coherent tree: new text documents are filled first, then every
   * file-table change (creates, deletes, binary updates, settings) lands in a single root transaction, and existing
   * text files are overwritten as minimal edits (keeping their identity for open editors). Paths are validated
   * before anything changes.
   */
  async applyBatch(ops: BatchOp[], canApply: () => boolean = () => true, origin: unknown = IMPORT_ORIGIN): Promise<{ created: Map<string, string> }> {
    for (const o of ops) if (o.op === 'text' || o.op === 'binary') assertSafe(o.path);
    const created = new Map<string, string>();
    const newTexts: Array<{ id: string; path: string; text: string }> = [];
    for (const o of ops) {
      if (o.op === 'text' && !o.id) {
        const id = newId();
        newTexts.push({ id, path: o.path, text: o.text });
        created.set(o.path, id);
      }
    }
    const textDocs = new Map<string, Y.Text>();
    for (const t of newTexts) if (t.text) textDocs.set(t.id, (await this.getDoc(fileDocId(t.id))).getText('t'));
    for (const o of ops) if (o.op === 'text' && o.id) textDocs.set(o.id, await this.openText(o.id));
    // All awaited loading precedes the mutation boundary; a demotion/stop can refuse the entire batch.
    if (!canApply()) throw new Error('denied');
    for (const t of newTexts) {
      this.markComplete(fileDocId(t.id));
      if (t.text) textDocs.get(t.id)?.doc?.transact(() => textDocs.get(t.id)?.insert(0, t.text), origin);
    }
    this.root.transact(() => {
      for (const o of ops) {
        if (o.op === 'delete') this.delete(o.id, origin);
        else if (o.op === 'setting') this.settings.set(o.key, o.value);
        else if (o.op === 'binary') {
          const cur = o.id ? this.files.get(o.id) : undefined;
          if (cur) {
            this.setBinary(o.id!, o.hash, o.size, origin);
          } else {
            const id = this.createBinary(o.path, o.hash, o.size, origin);
            created.set(o.path, id);
          }
        }
      }
      for (const t of newTexts) {
        const m = new Y.Map<unknown>();
        m.set('path', t.path);
        m.set('kind', 'text');
        this.files.set(t.id, m);
      }
    }, origin);
    for (const o of ops) if (o.op === 'text' && o.id) applyTextDiff(textDocs.get(o.id) as Y.Text, o.text, origin);
    return { created };
  }

  // ---- history ----

  async previewRestore(snapshotId: string): Promise<{ requestId: string; revision: number; snapshot: HistorySnapshot }> {
    const snapshot = (await this.store.listSnapshots()).find((s) => s.id === snapshotId);
    if (!snapshot) throw new Error('snapshot not found');
    for (const f of snapshot.files) if (f.kind === 'binary' && (!f.hash || !(await this.store.getBlob(f.hash)))) throw new Error(`Restore asset is unavailable: ${f.path}`);
    return { requestId: crypto.randomUUID(), revision: this.changeSeq, snapshot };
  }

  /** Records the project's content for History. Refuses while text is missing: a snapshot with empty stand-ins would restore as deletions. */
  async captureSnapshot(): Promise<HistorySnapshot> {
    const missing = this.missingText();
    if (this.availability(ROOT_DOC_ID) !== 'complete' || missing.length > 0) {
      throw new Error(`Not every file has been received yet, so no snapshot was taken: ${missing.length ? missing.map((f) => f.path).join(', ') : 'the file list'}`);
    }
    // Complete every lazy load first, then capture tree, texts and settings synchronously at one revision.
    for (let pass = 0; ; pass++) {
      await Promise.all(this.list().filter((f) => f.kind === 'text').map((f) => this.openText(f.id)));
      if (this.list().every((f) => f.kind !== 'text' || this.docs.has(fileDocId(f.id)))) break;
      if (pass >= 5) throw new Error('Project kept changing while preparing the snapshot; retry');
    }
    if (this.missingText().length) throw new Error('Snapshot content is incomplete');
    if (new Set(this.list().map((f) => f.path)).size !== this.list().length) throw new Error('Duplicate project paths must be renamed before taking a restorable snapshot');
    const files: HistorySnapshot['files'] = this.list().map((f) => f.kind === 'text'
      ? { path: f.path, kind: 'text', text: this.docs.get(fileDocId(f.id))!.getText('t').toString() }
      : f.kind === 'binary' ? { path: f.path, kind: 'binary', ...(f.hash ? { hash: f.hash } : {}), size: f.size ?? 0 }
      : { path: f.path, kind: 'dir' });
    const snap: HistorySnapshot = { id: newId(), at: Date.now(), files, settings: structuredClone(this.settings.toJSON()) };
    for (const f of files) if (f.kind === 'binary' && (!f.hash || !(await this.store.getBlob(f.hash)))) throw new Error(`Snapshot asset is unavailable: ${f.path}`);
    await this.store.putSnapshot(snap);
    return snap;
  }

  /**
   * Restores a snapshot as ordinary edits (so it syncs to everyone and can itself be undone by
   * restoring the pre-restore snapshot, which is captured first).
   */
  private restoring = new Map<string, Promise<{ undoId: string }>>();
  restore(snapshotId: string, canApply: () => boolean = () => true, expectedRevision?: number, requestId: string = crypto.randomUUID()): Promise<{ undoId: string }> {
    const known = this.restoring.get(requestId);
    if (known) return known;
    const run = this.runRestore(snapshotId, canApply, expectedRevision, requestId);
    this.restoring.set(requestId, run);
    void run.then(() => this.restoring.delete(requestId), () => this.restoring.delete(requestId));
    return run;
  }

  /** Checkpoints of interrupted restores, newest first (keys under `restore:pending:` only). */
  async interruptedRestores(): Promise<Array<RestoreRequest & { requestId: string }>> {
    const keys = (await this.store.listMetaKeys?.('restore:pending:') ?? []).filter((k) => k.startsWith('restore:pending:'));
    const all = await Promise.all(keys.map(async (k) => ({ ...(await this.store.getMeta(k) as RestoreRequest), requestId: k.slice(16) })));
    return all.filter((r) => r.stage === 'prepared').sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }

  /** Cancels an interrupted restore by restoring its recovery point (the state before it), then closes it. */
  async abandonRestore(requestId: string, canApply: () => boolean = () => true): Promise<{ undoId: string }> {
    const journalId = `restore:pending:${requestId}`;
    const prior = await this.store.getMeta(journalId) as RestoreRequest | undefined;
    if (prior?.stage !== 'prepared') throw new Error('No interrupted restore to cancel; refresh History');
    const result = await this.restore(prior.undoId, canApply, undefined, `${requestId.slice(0, 90)}-cancel`);
    await this.store.setMeta(journalId, { ...prior, stage: 'abandoned' });
    return result;
  }

  private async runRestore(snapshotId: string, canApply: () => boolean, expectedRevision: number | undefined, requestId: string): Promise<{ undoId: string }> {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(requestId)) throw new Error('Invalid restore request identifier');
    const snaps = await this.store.listSnapshots();
    const target = snaps.find((s) => s.id === snapshotId);
    if (!target) throw new Error('snapshot not found');
    const prior = await this.store.getMeta(`restore:pending:${requestId}`) as RestoreRequest | undefined;
    if (prior?.snapshotId !== undefined && prior.snapshotId !== snapshotId) throw new Error('Restore request belongs to another snapshot');
    if (prior?.stage === 'completed') return { undoId: prior.undoId };
    if (prior?.stage === 'abandoned') throw new Error('This restore was cancelled; preview the version again to restore it');
    // An interrupted restore is completed from the current state (History "Complete"), keeping its original recovery point.
    const resume = prior?.stage === 'prepared' ? prior : undefined;
    const revision = resume ? this.changeSeq : expectedRevision ?? this.changeSeq;
    if (new Set(target.files.map((f) => f.path)).size !== target.files.length) throw new Error('Snapshot contains ambiguous duplicate paths; recover its versions separately');
    for (const f of target.files) {
      assertSafe(f.path);
      if (f.kind === 'binary' && (!f.hash || !(await this.store.getBlob(f.hash)))) throw new Error(`Restore asset is unavailable: ${f.path}`);
      if (f.kind === 'text' && typeof f.text !== 'string') throw new Error(`Restore text is unavailable: ${f.path}`);
    }
    const undo = resume ? { id: resume.undoId } : await this.captureSnapshot();
    const want = new Map(target.files.map((f) => [f.path, f]));
    const have = new Map(this.list().map((f) => [f.path, f]));
    // All loading, recovery capture and I/O precedes the synchronous mutation boundary.
    await Promise.all([...have.values()].filter((f) => f.kind === 'text').map((f) => this.openText(f.id)));
    const stagedTexts = new Map<string, { id: string; doc: Y.Doc }>();
    for (const f of target.files) if (f.kind === 'text' && have.get(f.path)?.kind !== 'text') {
      const id = newId(); stagedTexts.set(f.path, { id, doc: await this.getDoc(fileDocId(id)) });
    }
    const journalId = `restore:pending:${requestId}`;
    const changed = 'Project changed after restore preview; refresh the preview before replacing any files';
    // Preconditions precede the checkpoint: a refused restore leaves nothing pending (D4).
    if (!canApply()) throw new Error('denied');
    if (this.changeSeq !== revision) throw new Error(changed);
    if (!resume) {
      await this.store.setMeta(journalId, { v: 1, stage: 'prepared', snapshotId, undoId: undo.id, revision, at: Date.now() } satisfies RestoreRequest);
      // The checkpoint write yields: withdraw it if the project moved meanwhile, before any mutation.
      if (!canApply() || this.changeSeq !== revision) {
        await this.store.setMeta(journalId, { v: 1, stage: 'withdrawn', snapshotId, undoId: undo.id, revision, at: Date.now() } satisfies RestoreRequest);
        throw new Error(canApply() ? changed : 'denied');
      }
    }
    // No awaits until the full plan is applied. A crash is recoverable from the prepared journal and undo snapshot.
    for (const [path, f] of have) if (!want.has(path)) this.delete(f.id, RESTORE_ORIGIN);
    for (const [path, w] of want) {
      if (!canApply()) throw new Error('denied');
      const cur = have.get(path);
      if (w.kind === 'text') {
        if (cur && cur.kind === 'text') {
          const text = this.docs.get(fileDocId(cur.id))!.getText('t');
          applyTextDiff(text, w.text ?? '', RESTORE_ORIGIN);
        }
        else {
          if (cur) this.delete(cur.id, RESTORE_ORIGIN);
          const staged = stagedTexts.get(path)!;
          applyTextDiff(staged.doc.getText('t'), w.text ?? '', RESTORE_ORIGIN);
          this.markComplete(fileDocId(staged.id));
          this.putEntry(staged.id, { path, kind: 'text' }, RESTORE_ORIGIN);
        }
      } else if (w.kind === 'binary') {
        if (cur?.kind === 'binary') this.setBinary(cur.id, w.hash ?? '', w.size ?? 0, RESTORE_ORIGIN);
        else {
          if (cur) this.delete(cur.id, RESTORE_ORIGIN);
          this.createBinary(path, w.hash ?? '', w.size ?? 0, RESTORE_ORIGIN);
        }
      } else if (cur?.kind !== 'dir') { if (cur) this.delete(cur.id, RESTORE_ORIGIN); this.createDir(path, RESTORE_ORIGIN); }
    }
    if (target.settings) this.root.transact(() => {
      for (const key of [...this.settings.keys()]) if (!(key in target.settings!)) this.settings.delete(key);
      for (const [key, value] of Object.entries(target.settings!)) this.settings.set(key, structuredClone(value));
    }, RESTORE_ORIGIN);
    await this.flush();
    await this.store.transact([
      { op: 'meta', key: journalId, value: { v: 1, stage: 'completed', snapshotId, undoId: undo.id, revision } },
    ]);
    return { undoId: undo.id };
  }
}

/** Durable checkpoint `restore:pending:<request id>`; `undoId` is the snapshot captured before the restore. */
export interface RestoreRequest { v: 1; stage: 'prepared' | 'completed' | 'abandoned' | 'withdrawn'; snapshotId: string; undoId: string; revision?: number; at?: number }

function withSuffix(path: string, n: number) {
  const i = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return i > slash + 1 ? `${path.slice(0, i)} (${n})${path.slice(i)}` : `${path} (${n})`;
}
