import { ROOT_DOC_ID, fileDocId } from '@p2platex/protocol';
import diff from 'fast-diff';
import * as Y from 'yjs';
import { DocPersister, type HistorySnapshot, type PersistOptions, type Persistence } from './persistence.js';

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
 * The project's CRDT state: a root document (file table + settings) and one lazily-loaded document per
 * text file. Files are keyed by a stable random id so rename/move is a single field update (never
 * delete+create), which makes concurrent rename+edit converge without duplicates.
 */
export class ProjectModel {
  readonly root = new Y.Doc();
  private docs = new Map<string, Y.Doc>();
  private persisters = new Map<string, DocPersister>();
  private loading = new Map<string, Promise<Y.Doc>>();
  private listeners = new Set<DocUpdateListener>();
  private fileListeners = new Set<() => void>();

  constructor(
    readonly store: Persistence,
    private persistOpts: PersistOptions = {},
  ) {
    this.docs.set(ROOT_DOC_ID, this.root);
    this.root.on('update', (u: Uint8Array, origin: unknown) => this.emit(ROOT_DOC_ID, u, origin));
    this.files.observeDeep(() => {
      for (const l of this.fileListeners) l();
    });
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
    const p = new DocPersister(this.store, ROOT_DOC_ID, this.root, this.persistOpts);
    this.persisters.set(ROOT_DOC_ID, p);
    await p.hydrate();
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
      const persister = new DocPersister(this.store, docId, doc, this.persistOpts);
      await persister.hydrate();
      doc.on('update', (u: Uint8Array, origin: unknown) => this.emit(docId, u, origin));
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
    await p?.destroy();
    this.persisters.delete(docId);
    this.docs.get(docId)?.destroy();
    this.docs.delete(docId);
  }

  async flush() {
    await Promise.all([...this.persisters.values()].map((p) => p.flush()));
  }

  async destroy() {
    await this.flush();
    for (const p of this.persisters.values()) await p.destroy();
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

  createText(path: string, content = '', origin: unknown = LOCAL_ORIGIN): string {
    assertSafe(path);
    const id = newId();
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
   */
  async dedupeIdentical(): Promise<number> {
    const byPath = new Map<string, Array<{ id: string; kind: FileKind; hash?: string }>>();
    this.files.forEach((m, id) => {
      const path = String(m.get('path'));
      const arr = byPath.get(path) ?? [];
      arr.push({ id, kind: m.get('kind') as FileKind, ...(m.get('hash') ? { hash: String(m.get('hash')) } : {}) });
      byPath.set(path, arr);
    });
    let removed = 0;
    for (const entries of byPath.values()) {
      if (entries.length < 2) continue;
      entries.sort((a, b) => (a.id < b.id ? -1 : 1));
      const keep = entries[0] as (typeof entries)[number];
      let keepText: string | null = null;
      for (const e of entries.slice(1)) {
        if (e.kind !== keep.kind) continue;
        let same = false;
        if (e.kind === 'dir') same = true;
        else if (e.kind === 'binary') same = !!e.hash && e.hash === keep.hash;
        else {
          keepText ??= (await this.openText(keep.id)).toString();
          same = (await this.openText(e.id)).toString() === keepText;
        }
        if (same) {
          this.files.delete(e.id);
          removed++;
        }
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
