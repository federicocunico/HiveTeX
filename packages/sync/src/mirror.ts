import { MAX_BLOB_BYTES } from '@hivetex/protocol';
import DiffMatchPatch from 'diff-match-patch';
import diff from 'fast-diff';
import ignore from 'ignore';
import * as Y from 'yjs';
import type { BlobManager } from './blobs.js';
import type { Mesh } from './mesh.js';
import { type FileEntry, type ProjectModel, applyTextDiff, sha256Hex } from './model.js';

/** Minimal file-system surface the mirror needs. Paths are POSIX-style and relative to the bound folder. */
export interface FsAdapter {
  list(): Promise<Array<{ path: string; size: number }>>;
  read(path: string): Promise<Uint8Array | null>;
  /** Must be atomic (write temp + rename). */
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  watch(cb: (ev: { path: string }) => void): () => void;
}

/** Build artifacts and tool metadata that must never enter the shared project. */
export const DEFAULT_IGNORES = [
  '.git/',
  '.claude/',
  '.cursor/',
  '.agents/',
  '.vscode/',
  '.idea/',
  'node_modules/',
  '.DS_Store',
  'Thumbs.db',
  '*.aux',
  '*.log',
  '*.out',
  '*.toc',
  '*.lof',
  '*.lot',
  '*.fls',
  '*.fdb_latexmk',
  '*.synctex.gz',
  '*.synctex',
  '*.bbl',
  '*.blg',
  '*.bcf',
  '*.run.xml',
  '*.nav',
  '*.snm',
  '*.vrb',
  '*.xdv',
  '*.p2p-tmp',
  '.p2p-manifest.json',
  // Folder marker (project identity, see MARKER_FILE): metadata, never a project file. The second is its name
  // before the product was renamed.
  '.hivetex.json',
  '.p2platex.json',
  '_minted*/',
];

export const IGNORE_FILE = '.hivetexignore';
/** Names used before the product was renamed (p2platex): still read, never written. */
export const LEGACY_IGNORE_FILE = '.p2platexignore';
export const LEGACY_MARKER_FILE = '.p2platex.json';

/** Marker written into a bound folder (and into GitHub backups) so the folder or a clone knows its project. */
export const MARKER_FILE = '.hivetex.json';

export interface FolderMarker {
  version: number;
  project?: { id: string; slug: string };
  /** Paths committed by the GitHub backup (kept untouched by the mirror). */
  paths?: string[];
}

/** Origin of Yjs transactions that come from the bound folder (attribution in the change log). */
export const MIRROR_ORIGIN = 'mirror-import';

export function parseMarker(bytes: Uint8Array | null): FolderMarker | null {
  if (!bytes) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(bytes)) as FolderMarker;
    if (typeof j !== 'object' || j === null) return null;
    if (j.project && (typeof j.project.id !== 'string' || typeof j.project.slug !== 'string')) return null;
    return j;
  } catch {
    return null;
  }
}

/** Project meta key holding the last text both sides agreed on, per path (3-way merge base across sessions). */
const BASE_META = 'mirrorBase';

/** Extensions stored as collaborative text (everything else is a binary asset). */
export const TEXT_EXT =
  /(\.(tex|bib|sty|cls|bst|txt|md|cfg|def|bbx|cbx|lbx|ltx|dtx|ins|csv|dat|tsv|tikz|pgf|asy|json|yml|yaml|xml|latexmkrc|ist|clo|fd|bbl|rnw|lua|py|r|sh|gitignore|hivetexignore|p2platexignore)|(^|\/)(latexmkrc|\.latexmkrc|Makefile|README|LICENSE))$/i;

export function isTextPath(path: string, bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  return TEXT_EXT.test(path) || !/\.[A-Za-z0-9]+$/.test(path.split('/').pop() ?? path);
}

/** Builds a matcher using `.gitignore` semantics (same engine as the folder mirror). */
export function createIgnoreMatcher(patterns: readonly string[]): (path: string) => boolean {
  const ig = ignore().add([...patterns]);
  return (path) => ig.ignores(path);
}

export interface MirrorOptions {
  model: ProjectModel;
  mesh: Mesh;
  blobs: BlobManager;
  fs: FsAdapter;
  /** Current role of this device. Viewers never push disk changes; changed files are restored from the project. */
  getRole: () => 'owner' | 'editor' | 'viewer';
  onNotice?: (msg: string) => void;
  debounceMs?: number;
  /** Project identity written into the folder's marker file. */
  marker?: { id: string; slug: string };
}

/**
 * Keeps a plain folder in sync with the project so any external program (Claude Code, Codex, Cursor, a
 * shell...) can read and edit the files. Disk edits become minimal collaborative edits; remote edits are
 * written to disk atomically. Content hashes suppress echo loops.
 */
export class MirrorSync {
  private lastWritten = new Map<string, string>(); // path -> hash we last put on / saw on disk
  /** Hashes we wrote recently: watcher events for an older write may be processed after a newer one began. */
  private recent = new Map<string, Array<{ hash: string; t: number }>>();
  private pendingDisk = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingModel = new Map<string, ReturnType<typeof setTimeout>>();
  private ig = ignore().add(DEFAULT_IGNORES);
  private stopFns: Array<() => void> = [];
  private busy = new Set<string>();
  private dirty = new Set<string>();
  /** Text and CRDT state as of the last time disk and project were identical (the 3-way merge base). */
  private base = new Map<string, { text: string; state: Uint8Array }>();
  private running = false;
  /** Paths mirrored to disk in this session, so deletions of project files can remove them. */
  private onDisk = new Set<string>();
  /** Persisted merge base (text) per path, so edits made while the app was closed merge 3-way on the next bind. */
  private savedBase = new Map<string, string>();
  private baseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private o: MirrorOptions) {}

  private isIgnored(path: string) {
    return this.ig.ignores(path);
  }

  private async loadIgnoreFile() {
    const bytes = (await this.o.fs.read(IGNORE_FILE)) ?? (await this.o.fs.read(LEGACY_IGNORE_FILE).catch(() => null));
    this.ig = ignore().add(DEFAULT_IGNORES);
    if (bytes) this.ig.add(new TextDecoder().decode(bytes));
    const f = this.o.model.find(IGNORE_FILE) ?? this.o.model.find(LEGACY_IGNORE_FILE);
    if (f?.kind === 'text') this.ig.add((await this.o.model.openText(f.id)).toString());
  }

  async start() {
    this.running = true;
    await this.loadIgnoreFile();
    // Subscribe first so no update that arrives while we reconcile can be missed.
    this.stopFns.push(this.o.fs.watch((ev) => this.onDiskEvent(ev.path)));
    this.stopFns.push(this.o.model.onFilesChanged(() => void this.syncTableToDisk()) as unknown as () => void);
    this.stopFns.push(
      this.o.model.onDocUpdate((docId) => {
        if (!docId.startsWith('f:')) return;
        const f = this.o.model.list().find((x) => `f:${x.id}` === docId);
        if (f) this.scheduleWrite(f.path);
      }) as unknown as () => void,
    );
    await this.o.mesh.prefetchAll();
    const saved = (await this.o.model.store.getMeta(BASE_META).catch(() => null)) as Record<string, string> | null;
    this.savedBase = new Map(Object.entries(saved ?? {}));
    await this.initialReconcile();
    await this.writeMarker();
  }

  /** Writes (or updates) the folder marker, keeping fields we do not own such as the backup's `paths`. */
  private async writeMarker() {
    if (!this.o.marker || this.o.getRole() === 'viewer') return;
    const current = parseMarker(await this.o.fs.read(MARKER_FILE).catch(() => null));
    // A folder from before the rename carries the old marker: adopt its fields, then replace it.
    const legacy = current ? null : parseMarker(await this.o.fs.read(LEGACY_MARKER_FILE).catch(() => null));
    const cur = current ?? legacy ?? { version: 2 };
    if (current && cur.project?.id === this.o.marker.id && cur.project.slug === this.o.marker.slug && cur.version >= 2) return;
    const next: FolderMarker = { ...cur, version: 2, project: { id: this.o.marker.id, slug: this.o.marker.slug } };
    await this.o.fs.write(MARKER_FILE, new TextEncoder().encode(`${JSON.stringify(next, null, 2)}
`)).catch(() => {});
    if (legacy) await this.o.fs.remove(LEGACY_MARKER_FILE).catch(() => {});
  }

  private rememberBase(path: string, text: string) {
    this.savedBase.set(path, text);
    if (this.baseTimer) return;
    this.baseTimer = setTimeout(() => {
      this.baseTimer = null;
      void this.o.model.store.setMeta(BASE_META, Object.fromEntries(this.savedBase)).catch(() => {});
    }, 300);
  }

  stop() {
    this.running = false;
    if (this.baseTimer) {
      clearTimeout(this.baseTimer);
      this.baseTimer = null;
      void this.o.model.store.setMeta(BASE_META, Object.fromEntries(this.savedBase)).catch(() => {});
    }
    for (const s of this.stopFns.splice(0)) s();
    for (const t of [...this.pendingDisk.values(), ...this.pendingModel.values()]) clearTimeout(t);
  }

  // ---- initial binding ----

  private async initialReconcile() {
    const disk = (await this.o.fs.list()).filter((f) => !this.isIgnored(f.path));
    const have = new Map(this.o.model.list().map((f) => [f.path, f]));
    const projectEmpty = have.size === 0;
    // Disk -> project: new files (and, on first bind, differing text files: the user chose this folder).
    for (const f of disk) {
      const entry = have.get(f.path);
      const bytes = await this.o.fs.read(f.path);
      if (!bytes) continue;
      this.lastWritten.set(f.path, await sha256Hex(bytes));
      this.onDisk.add(f.path);
      if (!entry || projectEmpty) await this.importFile(f.path, bytes, entry);
      else if (entry.kind === 'text' && isTextPath(f.path, bytes)) {
        const ytext = await this.o.model.openText(entry.id);
        const text = new TextDecoder().decode(bytes);
        const project = ytext.toString();
        if (project === text) continue;
        const base = this.savedBase.get(f.path);
        if (base === undefined) {
          // Never bound before: the user chose this folder, take its version.
          applyTextDiff(ytext, text, MIRROR_ORIGIN);
        } else if (text === base) {
          // Unchanged on disk while closed: the project's newer version is written back below.
        } else if (project === base) {
          applyTextDiff(ytext, text, MIRROR_ORIGIN);
        } else {
          // Both changed while the app was closed (folder edits + co-authors): 3-way merge from the saved base.
          const dmp = new DiffMatchPatch();
          const [merged] = dmp.patch_apply(dmp.patch_make(base, text), project);
          applyTextDiff(ytext, merged, MIRROR_ORIGIN);
        }
      }
    }
    // Project -> disk: everything not on disk yet.
    await this.writeAll();
  }

  private async writeAll() {
    for (const f of this.o.model.list()) await this.writeEntry(f);
  }

  // ---- project -> disk ----

  private scheduleWrite(path: string) {
    const prev = this.pendingModel.get(path);
    if (prev) clearTimeout(prev);
    this.pendingModel.set(
      path,
      setTimeout(async () => {
        this.pendingModel.delete(path);
        const f = this.o.model.find(path);
        if (f) await this.writeEntry(f);
      }, this.o.debounceMs ?? 100),
    );
  }

  private async syncTableToDisk() {
    if (!this.running) return;
    const current = new Map(this.o.model.list().map((f) => [f.path, f]));
    // Removed or renamed away: delete from disk.
    for (const p of [...this.onDisk]) {
      if (!current.has(p) && !this.isIgnored(p)) {
        this.onDisk.delete(p);
        this.lastWritten.delete(p);
        await this.o.fs.remove(p).catch(() => {});
      }
    }
    for (const f of current.values()) await this.writeEntry(f);
  }

  private async writeEntry(f: FileEntry) {
    if (f.kind === 'dir' || this.isIgnored(f.path)) return;
    if (this.busy.has(f.path)) {
      this.dirty.add(f.path); // a write is in flight: redo it afterwards so the latest content wins
      return;
    }
    this.busy.add(f.path);
    try {
      // If the file changed on disk since our last write (an external tool is mid-edit), merge that change
      // into the project first so writing the remote state does not clobber it.
      if (this.o.getRole() !== 'viewer' && this.onDisk.has(f.path)) {
        const cur = await this.readStable(f.path);
        if (cur) {
          const curHash = await sha256Hex(cur);
          if (curHash !== this.lastWritten.get(f.path) && !this.isRecentWrite(f.path, curHash)) {
            this.lastWritten.set(f.path, curHash);
            await this.importFile(f.path, cur, this.o.model.find(f.path));
          }
        }
      }
      let bytes: Uint8Array;
      let baseSnap: { text: string; state: Uint8Array } | null = null;
      if (f.kind === 'text') {
        await this.o.mesh.openDoc(`f:${f.id}`);
        const ydoc = await this.o.model.getDoc(`f:${f.id}`);
        const text = ydoc.getText('t').toString();
        baseSnap = { text, state: Y.encodeStateAsUpdate(ydoc) };
        bytes = new TextEncoder().encode(text);
      } else {
        if (!f.hash) return;
        try {
          bytes = await this.o.blobs.fetch(f.hash, 20_000);
        } catch {
          return; // not available yet
        }
      }
      const hash = await sha256Hex(bytes);
      if (this.lastWritten.get(f.path) === hash && this.onDisk.has(f.path)) return;
      // The awaits above take time: if the file was renamed, moved or deleted meanwhile, writing would resurrect it
      // under its old name next to the new one.
      if (this.o.model.byId(f.id)?.path !== f.path || !this.running) return;
      this.lastWritten.set(f.path, hash); // set before writing so the watcher event is recognised as ours
      this.noteWrite(f.path, hash);
      this.onDisk.add(f.path);
      await this.o.fs.write(f.path, bytes);
      if (baseSnap) {
        this.base.set(f.path, baseSnap);
        this.rememberBase(f.path, baseSnap.text);
      }
    } finally {
      this.busy.delete(f.path);
      if (this.dirty.delete(f.path)) {
        const again = this.o.model.find(f.path);
        if (again) void this.writeEntry(again);
      }
    }
  }

  // ---- disk -> project ----

  private onDiskEvent(path: string) {
    if (!this.running) return;
    if (path === IGNORE_FILE || path === LEGACY_IGNORE_FILE) void this.loadIgnoreFile();
    if (this.isIgnored(path)) return;
    const prev = this.pendingDisk.get(path);
    if (prev) clearTimeout(prev);
    this.pendingDisk.set(
      path,
      setTimeout(() => {
        this.pendingDisk.delete(path);
        void this.handleDiskChange(path);
      }, this.o.debounceMs ?? 100),
    );
  }

  private async handleDiskChange(path: string) {
    const bytes = await this.readStable(path);
    const entry = this.o.model.find(path);

    if (this.o.getRole() === 'viewer') {
      // Read-only members cannot change the project: restore the project's version on disk.
      if (entry && entry.kind !== 'dir') {
        this.lastWritten.delete(path);
        await this.writeEntry(entry);
      } else if (bytes) await this.o.fs.remove(path).catch(() => {});
      this.o.onNotice?.(`"${path}" is read-only for you; your local change was reverted.`);
      return;
    }

    if (!bytes) {
      // Deleted on disk.
      this.onDisk.delete(path);
      this.lastWritten.delete(path);
      if (entry && entry.kind !== 'dir') this.o.model.delete(entry.id, MIRROR_ORIGIN);
      return;
    }
    const hash = await sha256Hex(bytes);
    if (this.lastWritten.get(path) === hash || this.isRecentWrite(path, hash)) return; // echo of our own write
    this.lastWritten.set(path, hash);
    this.onDisk.add(path);
    await this.importFile(path, bytes, entry);
  }

  /**
   * Three-way merge of an external edit: the disk change is computed against the version we last wrote
   * (the base), replayed on a fork of that CRDT state, and the resulting delta is applied to the live
   * document. Concurrent remote edits therefore survive instead of being "undone" by a whole-file diff.
   */
  private async mergeDiskText(entry: FileEntry, path: string, next: string) {
    const ytext = await this.o.model.openText(entry.id);
    const base = this.base.get(path);
    if (!base) {
      applyTextDiff(ytext, next, MIRROR_ORIGIN);
      this.rememberBase(path, next);
      return;
    }
    const fork = new Y.Doc();
    Y.applyUpdate(fork, base.state);
    const before = Y.encodeStateVector(fork);
    const ft = fork.getText('t');
    let pos = 0;
    fork.transact(() => {
      for (const [op, chunk] of diff(base.text, next)) {
        if (op === diff.EQUAL) pos += chunk.length;
        else if (op === diff.INSERT) {
          ft.insert(pos, chunk);
          pos += chunk.length;
        } else ft.delete(pos, chunk.length);
      }
    });
    const delta = Y.encodeStateAsUpdate(fork, before);
    Y.applyUpdate(ytext.doc as Y.Doc, delta, MIRROR_ORIGIN);
    this.base.set(path, { text: next, state: Y.encodeStateAsUpdate(fork) });
    this.rememberBase(path, next);
    fork.destroy();
  }

  /**
   * Reads a file until two consecutive reads agree. Editors and tools often rewrite a file in place (truncate, then
   * write): importing the truncated state would look like "all content deleted" and, merged with a co-author's
   * concurrent edit, reorder or lose text. A file that suddenly reads empty gets a longer grace period.
   */
  private async readStable(path: string): Promise<Uint8Array | null> {
    const pause = Math.max(20, Math.min(this.o.debounceMs ?? 100, 200));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const same = (a: Uint8Array | null, b: Uint8Array | null) =>
      a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
    let prev = await this.o.fs.read(path);
    for (let i = 0; i < 25; i++) {
      await sleep(prev && prev.length === 0 && this.onDisk.has(path) ? pause * 3 : pause);
      const cur = await this.o.fs.read(path);
      if (same(prev, cur)) return cur;
      prev = cur;
    }
    return prev;
  }

  private noteWrite(path: string, hash: string) {
    const now = Date.now();
    const arr = (this.recent.get(path) ?? []).filter((e) => now - e.t < 3000);
    arr.push({ hash, t: now });
    this.recent.set(path, arr.slice(-8));
  }

  private isRecentWrite(path: string, hash: string) {
    const now = Date.now();
    return (this.recent.get(path) ?? []).some((e) => e.hash === hash && now - e.t < 3000);
  }

  private async importFile(path: string, bytes: Uint8Array, entry: FileEntry | undefined) {
    if (bytes.length > MAX_BLOB_BYTES) {
      this.o.onNotice?.(`"${path}" is larger than ${Math.round(MAX_BLOB_BYTES / 1048576)} MB and was not added to the project.`);
      return;
    }
    if (isTextPath(path, bytes)) {
      const text = new TextDecoder().decode(bytes);
      if (entry?.kind === 'text') await this.mergeDiskText(entry, path, text);
      else {
        if (entry) this.o.model.delete(entry.id, MIRROR_ORIGIN);
        await this.o.model.createTextNow(path, text, MIRROR_ORIGIN);
        this.rememberBase(path, text);
      }
    } else {
      const hash = await this.o.blobs.add(bytes);
      if (entry?.kind === 'binary') this.o.model.setBinary(entry.id, hash, bytes.length, MIRROR_ORIGIN);
      else {
        if (entry) this.o.model.delete(entry.id, MIRROR_ORIGIN);
        this.o.model.createBinary(path, hash, bytes.length, MIRROR_ORIGIN);
      }
    }
  }
}
