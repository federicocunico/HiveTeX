import { ROOT_DOC_ID, fileDocId } from '@hivetex/protocol';
import diff from 'fast-diff';
import * as Y from 'yjs';
import { DocPersister, type HistorySnapshot, type PersistOptions, type Persistence, type StoreOp } from './persistence.js';

export type FileKind = 'text' | 'binary' | 'dir';

export interface FileEntry {
  id: string;
  path: string;
  kind: FileKind;
  /** SHA-256 hex of the content, for binary files. */
  hash?: string;
  size?: number;
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
  private availListeners = new Set<(docId: string) => void>();
  private availTimer: ReturnType<typeof setTimeout> | null = null;
  private availWrite: Promise<void> = Promise.resolve();
  /** Documents that were in storage when the project opened (not necessarily loaded yet): some content, so at least partial. */
  private storedAtOpen = new Set<string>();
  /** Counts updates per document, so a decision taken over several awaits can tell whether the document moved. */
  private revs = new Map<string, number>();

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
    const p = new DocPersister(this.store, ROOT_DOC_ID, this.root, this.persistenceOptions());
    this.persisters.set(ROOT_DOC_ID, p);
    await p.hydrate();
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
    const stored = await this.store.listDocs();
    for (const d of stored) this.storedAtOpen.add(d);
    if (Array.isArray(docs)) {
      for (const d of docs) if (typeof d === 'string') this.complete.add(d);
      return;
    }
    for (const d of stored) this.complete.add(d);
    this.scheduleAvailability();
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
    return this.list().filter((f) => f.kind === 'text' && !this.complete.has(fileDocId(f.id)));
  }

  /** Updates seen by a document so far; unchanged means the document did not move in between. */
  revision(docId: string): number {
    return this.revs.get(docId) ?? 0;
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
      await this.store.setMeta(AVAILABILITY_KEY, { v: 1, docs });
    };
    const next = this.availWrite.then(run, run);
    this.availWrite = next.catch(() => {});
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
    await Promise.all([...this.persisters.values()].map((p) => p.flush()));
    if (this.availTimer) {
      clearTimeout(this.availTimer);
      this.availTimer = null;
      await this.writeAvailability();
    }
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
  async createTextNow(path: string, content = '', origin: unknown = LOCAL_ORIGIN): Promise<string> {
    const id = this.createText(path, '', origin);
    if (content) {
      const d = await this.getDoc(fileDocId(id));
      d.transact(() => d.getText('t').insert(0, content), origin);
    }
    return id;
  }

  createDir(path: string): string {
    assertSafe(path);
    const id = newId();
    this.root.transact(() => {
      const m = new Y.Map<unknown>();
      m.set('path', path);
      m.set('kind', 'dir');
      this.files.set(id, m);
    }, LOCAL_ORIGIN);
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
      this.files.set(id, m);
    }, origin);
    return id;
  }

  setBinary(id: string, hash: string, size: number, origin: unknown = LOCAL_ORIGIN) {
    this.root.transact(() => {
      const m = this.files.get(id);
      m?.set('hash', hash);
      m?.set('size', size);
    }, origin);
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

  delete(id: string, origin: unknown = LOCAL_ORIGIN) {
    this.root.transact(() => this.files.delete(id), origin);
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
        this.files.delete(e.id);
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
  async applyBatch(ops: BatchOp[]): Promise<{ created: Map<string, string> }> {
    for (const o of ops) if (o.op === 'text' || o.op === 'binary') assertSafe(o.path);
    const created = new Map<string, string>();
    const newTexts: Array<{ id: string; path: string; text: string }> = [];
    for (const o of ops) {
      if (o.op === 'text' && !o.id) {
        const id = newId();
        this.markComplete(fileDocId(id));
        newTexts.push({ id, path: o.path, text: o.text });
        created.set(o.path, id);
      }
    }
    for (const t of newTexts) if (t.text) (await this.getDoc(fileDocId(t.id))).getText('t').insert(0, t.text);
    this.root.transact(() => {
      for (const o of ops) {
        if (o.op === 'delete') this.files.delete(o.id);
        else if (o.op === 'setting') this.settings.set(o.key, o.value);
        else if (o.op === 'binary') {
          const cur = o.id ? this.files.get(o.id) : undefined;
          if (cur) {
            cur.set('hash', o.hash);
            cur.set('size', o.size);
          } else {
            const id = newId();
            const m = new Y.Map<unknown>();
            m.set('path', o.path);
            m.set('kind', 'binary');
            m.set('hash', o.hash);
            m.set('size', o.size);
            this.files.set(id, m);
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
    }, LOCAL_ORIGIN);
    for (const o of ops) if (o.op === 'text' && o.id) applyTextDiff(await this.openText(o.id), o.text);
    return { created };
  }

  // ---- history ----

  async captureSnapshot(): Promise<HistorySnapshot> {
    const files: HistorySnapshot['files'] = [];
    for (const f of this.list()) {
      if (f.kind === 'text') files.push({ path: f.path, kind: 'text', text: (await this.openText(f.id)).toString() });
      else if (f.kind === 'binary') files.push({ path: f.path, kind: 'binary', ...(f.hash ? { hash: f.hash } : {}), size: f.size ?? 0 });
      else files.push({ path: f.path, kind: 'dir' });
    }
    const snap: HistorySnapshot = { id: newId(), at: Date.now(), files };
    await this.store.putSnapshot(snap);
    return snap;
  }

  /**
   * Restores a snapshot as ordinary edits (so it syncs to everyone and can itself be undone by
   * restoring the pre-restore snapshot, which is captured first).
   */
  async restore(snapshotId: string): Promise<{ undoId: string }> {
    const snaps = await this.store.listSnapshots();
    const target = snaps.find((s) => s.id === snapshotId);
    if (!target) throw new Error('snapshot not found');
    const undo = await this.captureSnapshot();
    const want = new Map(target.files.map((f) => [f.path, f]));
    const have = new Map(this.list().map((f) => [f.path, f]));
    for (const [path, f] of have) if (!want.has(path)) this.delete(f.id);
    for (const [path, w] of want) {
      const cur = have.get(path);
      if (w.kind === 'text') {
        if (cur && cur.kind === 'text') applyTextDiff(await this.openText(cur.id), w.text ?? '');
        else {
          if (cur) this.delete(cur.id);
          await this.createTextNow(path, w.text ?? '');
        }
      } else if (w.kind === 'binary') {
        if (cur?.kind === 'binary') this.setBinary(cur.id, w.hash ?? '', w.size ?? 0);
        else {
          if (cur) this.delete(cur.id);
          this.createBinary(path, w.hash ?? '', w.size ?? 0);
        }
      } else if (!cur) this.createDir(path);
    }
    return { undoId: undo.id };
  }
}

function withSuffix(path: string, n: number) {
  const i = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return i > slash + 1 ? `${path.slice(0, i)} (${n})${path.slice(i)}` : `${path} (${n})`;
}
