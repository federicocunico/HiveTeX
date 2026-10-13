import { MAX_BLOB_BYTES } from '@hivetex/protocol';
import diff from 'fast-diff';
import ignore from 'ignore';
import * as Y from 'yjs';
import type { BlobManager } from './blobs.js';
import { mergeText } from './merge.js';
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
  // Folder marker (project identity, see MARKER_FILE): metadata, never a project file.
  '.hivetex.json',
  '_minted*/',
];

export const IGNORE_FILE = '.hivetexignore';

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
  /(\.(tex|bib|sty|cls|bst|txt|md|cfg|def|bbx|cbx|lbx|ltx|dtx|ins|csv|dat|tsv|tikz|pgf|asy|json|yml|yaml|xml|latexmkrc|ist|clo|fd|bbl|rnw|lua|py|r|sh|gitignore|hivetexignore)|(^|\/)(latexmkrc|\.latexmkrc|Makefile|README|LICENSE))$/i;

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
  /**
   * Both the folder's copy and the project changed the same lines since they last agreed (while the app was closed):
   * keep both versions for the member to resolve (OfflineFork.recordTextConflict). Without it the folder file is left
   * as it is and the project is not changed.
   */
  onConflict?: (c: { fileId: string; path: string; base: string; disk: string; project: string }) => Promise<unknown>;
  debounceMs?: number;
  /** First delay before a failed disk write is repeated; it doubles up to 8 s (default 500 ms). */
  retryMs?: number;
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
  /** Text files on disk whose project text is not complete yet: reconciled when it is, never overwritten before. */
  private deferred = new Set<string>();
  /** Folder files left untouched because their overlapping changes could not be recorded as a conflict. */
  private held = new Set<string>();
  /** Consecutive failed writes per path (the retry delay grows with it). */
  private failures = new Map<string, number>();
  private fetching = false;
  private fetchAgain = false;

  constructor(private o: MirrorOptions) {}

  private isIgnored(path: string) {
    return this.ig.ignores(path);
  }

  private async loadIgnoreFile() {
    const bytes = await this.o.fs.read(IGNORE_FILE);
    this.ig = ignore().add(DEFAULT_IGNORES);
    if (bytes) this.ig.add(new TextDecoder().decode(bytes));
    const f = this.o.model.find(IGNORE_FILE);
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
    // Text the project did not have at bind time is reconciled (and written) once it is complete.
    this.stopFns.push(
      this.o.model.onAvailability((docId) => {
        if (!docId.startsWith('f:')) return;
        const f = this.o.model.byId(docId.slice(2));
        if (f) void this.onContentReady(f);
      }) as unknown as () => void,
    );
    this.stopFns.push(this.o.mesh.onPeerJoin(() => this.fetchContent()));
    this.fetchContent(); // asks for what is missing; the reconciliation below only uses text that is complete
    const saved = (await this.o.model.store.getMeta(BASE_META).catch(() => null)) as Record<string, string> | null;
    this.savedBase = new Map(Object.entries(saved ?? {}));
    await this.initialReconcile();
    await this.writeMarker();
  }

  /** Writes (or updates) the folder marker, keeping fields we do not own such as the backup's `paths`. */
  /** Updates sharing metadata without rebinding the folder or touching project contents. */
  async updateProjectSlug(slug: string) {
    if (!this.o.marker) return;
    this.o.marker.slug = slug;
    await this.writeMarker(true);
  }

  private async writeMarker(reportFailure = false) {
    if (!this.o.marker || this.o.getRole() === 'viewer') return;
    const current = parseMarker(await this.o.fs.read(MARKER_FILE).catch(() => null));
    const cur = current ?? { version: 2 };
    if (current && cur.project?.id === this.o.marker.id && cur.project.slug === this.o.marker.slug && cur.version >= 2) return;
    const next: FolderMarker = { ...cur, version: 2, project: { id: this.o.marker.id, slug: this.o.marker.slug } };
    await this.o.fs.write(MARKER_FILE, new TextEncoder().encode(`${JSON.stringify(next, null, 2)}
`)).catch((e) => { if (reportFailure) throw e; });
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
    for (const f of disk) {
      const entry = have.get(f.path);
      const bytes = await this.o.fs.read(f.path);
      if (!bytes) continue;
      // A viewer's folder never changes the project: differences are resolved from the project's side only.
      if (this.o.getRole() === 'viewer') {
        await this.viewerInitial(f.path, bytes, entry);
        continue;
      }
      this.lastWritten.set(f.path, await sha256Hex(bytes));
      this.onDisk.add(f.path);
      // Disk -> project: new files, and differing text files reconciled by what both sides last agreed on.
      if (!entry) await this.importFile(f.path, bytes, entry);
      else if (entry.kind === 'text' && isTextPath(f.path, bytes)) await this.reconcileText(entry, bytes);
    }
    // Project -> disk: everything not on disk yet.
    await this.writeAll();
  }

  /**
   * One text file present in the folder and in the project's file list, at bind time or when its text became complete.
   * Content the project does not have yet is never mistaken for an empty file: the folder's copy waits untouched.
   */
  private async reconcileText(entry: FileEntry, bytes: Uint8Array) {
    const path = entry.path;
    if (this.o.model.availability(`f:${entry.id}`) !== 'complete') {
      this.deferred.add(path);
      return;
    }
    this.deferred.delete(path);
    const ytext = await this.o.model.openText(entry.id);
    const text = new TextDecoder().decode(bytes);
    const project = ytext.toString();
    if (project === text) {
      this.setBase(path, ytext); // verified equal: the baseline later merges start from
      return;
    }
    const base = this.savedBase.get(path);
    if (base === undefined) {
      // Never bound before: the user chose this folder, take its version.
      applyTextDiff(ytext, text, MIRROR_ORIGIN);
      this.setBase(path, ytext);
    } else if (text === base) {
      // Unchanged on disk while closed: the project's newer version is written back below.
    } else if (project === base) {
      applyTextDiff(ytext, text, MIRROR_ORIGIN);
      this.setBase(path, ytext);
    } else {
      // Both changed while the app was closed (folder edits + co-authors): 3-way merge from the saved base.
      const r = mergeText(base, text, project);
      if (r.kind === 'conflict') {
        // The same lines changed on both sides: nothing is overwritten. The project keeps its text (written to the
        // folder below) and the folder's version is kept as a conflict for the member to resolve.
        if (this.o.onConflict) {
          await this.o.onConflict({ fileId: entry.id, path, base, disk: text, project });
          this.o.onNotice?.(`"${path}" was changed in the folder and in the project in the same place: both versions are kept, resolve it in the project.`);
        } else {
          this.held.add(path);
          this.o.onNotice?.(`"${path}" was changed in the folder and in the project in the same place: the folder's file was left as it is.`);
        }
      } else if (r.kind !== 'theirs') {
        applyTextDiff(ytext, r.text, MIRROR_ORIGIN);
      }
    }
  }

  /** A viewer's folder file at bind time: the project's version is restored; nothing reaches the project. */
  private async viewerInitial(path: string, bytes: Uint8Array, entry: FileEntry | undefined) {
    if (!entry || entry.kind === 'dir') {
      this.o.onNotice?.(`"${path}" is not part of the project; it was left as it is and is not shared (read-only for you).`);
      return;
    }
    const hash = await sha256Hex(bytes);
    if (entry.kind === 'binary') {
      if (entry.hash === hash) {
        this.lastWritten.set(path, hash);
        this.onDisk.add(path);
      } else this.o.onNotice?.(`"${path}" differs from the project and is restored from it (read-only for you).`);
      return;
    }
    if (this.o.model.availability(`f:${entry.id}`) !== 'complete') {
      this.deferred.add(path); // compared and restored once the project's text is complete
      return;
    }
    const project = (await this.o.model.openText(entry.id)).toString();
    if (hash === (await sha256Hex(new TextEncoder().encode(project)))) {
      this.lastWritten.set(path, hash);
      this.onDisk.add(path);
    } else this.o.onNotice?.(`"${path}" differs from the project and is restored from it (read-only for you).`);
  }

  /** A text file's content became complete: reconcile a folder copy that waited for it, then write it. */
  private async onContentReady(f: FileEntry) {
    if (!this.running || f.kind !== 'text') return;
    try {
      if (this.deferred.has(f.path)) {
        const bytes = await this.readStable(f.path);
        if (bytes && this.o.getRole() === 'viewer') {
          this.deferred.delete(f.path);
          await this.viewerInitial(f.path, bytes, f);
        } else if (bytes) {
          this.lastWritten.set(f.path, await sha256Hex(bytes));
          this.onDisk.add(f.path);
          await this.reconcileText(f, bytes);
        } else this.deferred.delete(f.path);
      }
      const again = this.o.model.byId(f.id);
      if (again && this.running) await this.writeEntry(again);
    } catch {
      /* a later event or the next bind reconciles it */
    }
  }

  /**
   * Asks the peers for every file's complete text, without waiting: files become writable as they are confirmed
   * (see onContentReady). A request that arrives while one is running is repeated afterwards.
   */
  private fetchContent() {
    if (!this.running) return;
    if (this.fetching) {
      this.fetchAgain = true;
      return;
    }
    this.fetching = true;
    void this.o.mesh
      .awaitComplete()
      .catch(() => {})
      .finally(() => {
        this.fetching = false;
        if (this.fetchAgain) {
          this.fetchAgain = false;
          this.fetchContent();
        }
      });
  }

  /** The disk and the project hold this text right now: the base later three-way merges start from. */
  private setBase(path: string, ytext: Y.Text) {
    const doc = ytext.doc as Y.Doc;
    const text = ytext.toString();
    this.base.set(path, { text, state: Y.encodeStateAsUpdate(doc) });
    this.rememberBase(path, text);
  }

  private async writeAll() {
    for (const f of this.o.model.list()) await this.writeEntry(f);
  }

  // ---- project -> disk ----

  private scheduleWrite(path: string, delayMs = this.o.debounceMs ?? 100) {
    const prev = this.pendingModel.get(path);
    if (prev) clearTimeout(prev);
    this.pendingModel.set(
      path,
      setTimeout(async () => {
        this.pendingModel.delete(path);
        const f = this.o.model.find(path);
        if (f) await this.writeEntry(f);
      }, delayMs),
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
    if (f.kind === 'dir' || this.isIgnored(f.path) || this.held.has(f.path)) return;
    // Text the project does not hold completely is unknown, not empty: writing it would erase the folder's copy.
    if (f.kind === 'text' && this.o.model.availability(`f:${f.id}`) !== 'complete') {
      this.fetchContent();
      return;
    }
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
      if (this.lastWritten.get(f.path) === hash && this.onDisk.has(f.path)) {
        // Disk and project agree: that is a baseline even though nothing needs writing.
        if (baseSnap && this.base.get(f.path)?.text !== baseSnap.text) {
          this.base.set(f.path, baseSnap);
          this.rememberBase(f.path, baseSnap.text);
        }
        return;
      }
      // The awaits above take time: if the file was renamed, moved or deleted meanwhile, writing would resurrect it
      // under its old name next to the new one.
      if (this.o.model.byId(f.id)?.path !== f.path || !this.running) return;
      const previous = this.lastWritten.get(f.path);
      const wasOnDisk = this.onDisk.has(f.path);
      this.lastWritten.set(f.path, hash); // set before writing so the watcher event is recognised as ours
      this.noteWrite(f.path, hash);
      this.onDisk.add(f.path);
      try {
        await this.o.fs.write(f.path, bytes);
      } catch (e) {
        // Not on disk: forget that we thought so (a retry must not see an "already written" hash), keep the old
        // baseline, and try again with a growing delay.
        if (previous === undefined) this.lastWritten.delete(f.path);
        else this.lastWritten.set(f.path, previous);
        if (!wasOnDisk) this.onDisk.delete(f.path);
        const n = (this.failures.get(f.path) ?? 0) + 1;
        this.failures.set(f.path, n);
        this.o.onNotice?.(`Could not write "${f.path}" to the folder (${e instanceof Error ? e.message : e}); trying again.`);
        if (this.running) this.scheduleWrite(f.path, Math.min((this.o.retryMs ?? 500) * 2 ** (n - 1), 8000));
        return;
      }
      this.failures.delete(f.path);
      // Renamed or deleted while the write was under way: it just put the old name back on disk.
      if (this.o.model.byId(f.id)?.path !== f.path) {
        if (this.o.model.find(f.path)) this.dirty.add(f.path); // another file took the name: write that one
        else {
          this.onDisk.delete(f.path);
          this.lastWritten.delete(f.path);
          this.base.delete(f.path);
          await this.o.fs.remove(f.path).catch(() => {});
        }
        return;
      }
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
    if (path === IGNORE_FILE) void this.loadIgnoreFile();
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
    this.held.delete(path);
    if (entry?.kind === 'text' && this.o.model.availability(`f:${entry.id}`) !== 'complete') {
      this.deferred.add(path); // an edit on top of text the project does not hold yet: reconciled when it does
      return;
    }
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
      this.setBase(path, ytext);
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
        const id = await this.o.model.createTextNow(path, text, MIRROR_ORIGIN);
        this.setBase(path, await this.o.model.openText(id));
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
