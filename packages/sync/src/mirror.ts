import { MIRROR_ORIGIN } from './origins.js';
import { MAX_BLOB_BYTES } from '@hivetex/protocol';
import diff from 'fast-diff';
import ignore from 'ignore';
import * as Y from 'yjs';
import type { BlobManager } from './blobs.js';
import { mergeText } from './merge.js';
import type { Mesh } from './mesh.js';
import { type FileEntry, type ProjectModel, applyTextDiff, sha256Hex } from './model.js';
import { listRecovery, preserveRecovery, readRecovery } from './recovery.js';
import { hostKey, pathCollisions } from './path-collisions.js';

/** Minimal file-system surface the mirror needs. Paths are POSIX-style and relative to the bound folder. */
export interface FsAdapter {
  list(): Promise<Array<{ path: string; size: number }>>;
  /** Private OS-level recovery copies; excluded from the shared project. */
  retained?(): Promise<Array<{ path: string; size: number }>>;
  /** null means confirmed NotFound only. Permission, I/O and incomplete-read failures MUST reject. */
  read(path: string): Promise<Uint8Array | null>;
  /**
   * Must be atomic (write temp + exclusive publication): the path holds the previous or the new content, also after a
   * failure. Resolves with the transient retained copy of the replaced file, if the adapter keeps one.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: adapters without retained copies return nothing
  write(path: string, bytes: Uint8Array): Promise<string | null | void>;
  /** Resolves with the transient retained copy of the removed file, if the adapter keeps one. */
  // biome-ignore lint/suspicious/noConfusingVoidType: adapters without retained copies return nothing
  remove(path: string): Promise<string | null | void>;
  /** Deletes a transient retained copy (`.hivetex-recovery/*.retained`) once it was compared or captured. */
  dropRetained?(path: string): Promise<void>;
  /** Must not report directories (reading one is not a file read failure). */
  watch(cb: (ev: { path: string; error?: unknown }) => void): () => void;
}

export type FsReadResult = { kind: 'present'; bytes: Uint8Array } | { kind: 'missing' } | { kind: 'error'; error: unknown };
export async function readFs(fs: FsAdapter, path: string): Promise<FsReadResult> {
  try { const bytes = await fs.read(path); return bytes === null ? { kind: 'missing' } : { kind: 'present', bytes }; }
  catch (error) { return { kind: 'error', error }; }
}
export async function scanFs(fs: FsAdapter): Promise<{ complete: true; files: Array<{ path: string; size: number }> } | { complete: false; error: unknown }> {
  try { return { complete: true, files: await fs.list() }; }
  catch (error) { return { complete: false, error }; }
}

/** Build artifacts and tool metadata that must never enter the shared project. */
export const DEFAULT_IGNORES = [
  '.git/',
  '.claude/',
  '.cursor/',
  '.agents/',
  '.hivetex-recovery/',
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

/** The native walks also skip `target/` (mirror.rs `skip_component`, mirror-node.ts): never mirrored either way. */
export const MIRROR_IGNORES = [...DEFAULT_IGNORES, 'target/'];

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
export { MIRROR_ORIGIN };

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
/** Recovery-store meta key: retained copies captured but not removable from the folder (not read again on start). */
const CAPTURED_META = 'mirrorRetainedCaptured';
const RETAINED_REASON = 'Retained folder inode before replacement or removal';
const MAX_RETRY_MS = 8000;
const errorCode = (e: unknown) => (e as { code?: string } | null)?.code;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** The original project path of a retained copy (`dir/.hivetex-recovery/name.<nonce>.retained`). */
const retainedOrigin = (copy: string) => copy.split('/').filter((p) => p !== '.hivetex-recovery').join('/').replace(/\.[a-f0-9-]{32,36}\.retained$/, '');

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
  /** Private durable authority (the desktop renderer's transient model store is not the worker store). */
  recoveryStore?: import('./persistence.js').Persistence;
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
  /** First delay before a failed disk write, read, removal or scan is repeated; it doubles up to 8 s (default 500 ms). */
  retryMs?: number;
  /**
   * How long a transient retained copy stays in the folder before it is compared with what the mirror last wrote or
   * read (late writes through an external handle land in it meanwhile). Default 1 s.
   */
  retainedSettleMs?: number;
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
  private ig = ignore().add(MIRROR_IGNORES);
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
  private collisionHeld = new Set<string>();
  /** Consecutive failed writes per path (the retry delay grows with it). */
  private failures = new Map<string, number>();
  /** Consecutive failed reads / removals per path, and failed starts and table passes: each kind has its own backoff. */
  private readFailures = new Map<string, number>();
  private removeFailures = new Map<string, number>();
  private startFailures = 0;
  private tableFailures = 0;
  /** Paths whose publication is under way: their absence is not a deletion. */
  private publishing = new Set<string>();
  /** Folder files that could not be read at bind time: never overwritten before they were compared. */
  private unreadable = new Set<string>();
  /** Files missing from the folder while its marker was missing or foreign: not deleted, rechecked with the marker. */
  private unconfirmed = new Set<string>();
  /** Transient retained copies of this session awaiting their comparison. */
  private settling = new Map<string, ReturnType<typeof setTimeout>>();
  private fetching = false;
  private fetchAgain = false;
  private tableWork: Promise<void> = Promise.resolve();
  private tableRetry: ReturnType<typeof setTimeout> | null = null;
  private startRetry: ReturnType<typeof setTimeout> | null = null;
  private scanReady = false;

  constructor(private o: MirrorOptions) {}

  private get recoveryStore() { return this.o.recoveryStore ?? this.o.model.store; }

  async recoveries() { await this.captureRetained(); return listRecovery(this.recoveryStore); }
  recoveryBytes(id: string) { return readRecovery(this.recoveryStore, id); }

  private backoff(n: number) { return Math.min((this.o.retryMs ?? 500) * 2 ** Math.min(n - 1, 10), MAX_RETRY_MS); }

  /**
   * Captures retained copies left in the folder (earlier sessions, a crash, a copy that could not be compared) into the
   * device's Recovery and removes them from the folder. Incremental: a copy already captured but not removable is
   * remembered and not read again. Failures to read a copy are reported after the others were captured.
   */
  async captureRetained() {
    const copies = (await this.o.fs.retained?.() ?? []).filter((f) => !this.settling.has(f.path));
    if (!copies.length) return;
    const seen = new Set(((await this.recoveryStore.getMeta(CAPTURED_META)) as string[] | null) ?? []);
    const keep: string[] = [];
    let failed: unknown = null;
    for (const file of copies) {
      const id = `${file.path}:${file.size}`;
      if (seen.has(id)) { if (!(await this.dropCopy(file.path))) keep.push(id); continue; }
      try {
        const bytes = await this.o.fs.read(file.path);
        if (!bytes) continue;
        await preserveRecovery(this.recoveryStore, retainedOrigin(file.path), bytes, RETAINED_REASON);
      } catch (error) { failed = error; continue; }
      if (!(await this.dropCopy(file.path))) keep.push(id);
    }
    if (keep.length !== seen.size || keep.some((k) => !seen.has(k))) await this.recoveryStore.setMeta(CAPTURED_META, keep);
    if (failed) throw failed;
  }

  private async dropCopy(copy: string) {
    if (!this.o.fs.dropRetained) return false;
    try { await this.o.fs.dropRetained(copy); return true; } catch { return false; }
  }

  /**
   * A retained copy of `path` from this session: after the settle delay its bytes are compared with what the mirror
   * last wrote or read there (`expected`). Equal: removed. Different (external work): captured into Recovery, removed.
   */
  private settle(copy: unknown, path: string, expected: string | undefined) {
    if (typeof copy !== 'string' || !copy) return;
    const prev = this.settling.get(copy);
    if (prev) clearTimeout(prev);
    this.settling.set(copy, setTimeout(() => void this.settleCopy(copy, path, expected), this.o.retainedSettleMs ?? 1000));
  }

  private async settleCopy(copy: string, path: string, expected: string | undefined) {
    try {
      const bytes = await this.o.fs.read(copy);
      if (bytes && (expected === undefined || (await sha256Hex(bytes)) !== expected)) await preserveRecovery(this.recoveryStore, path, bytes, RETAINED_REASON);
      await this.o.fs.dropRetained?.(copy);
    } catch {
      /* left in the folder: captured on the next start */
    } finally {
      this.settling.delete(copy);
    }
  }

  private isIgnored(path: string) {
    return this.ig.ignores(path);
  }

  /** A watcher path that is a folder of the project or of the mirrored files is not a file event. */
  private isDirPath(path: string) {
    if (this.o.model.find(path)?.kind === 'dir') return true;
    const pre = `${path}/`;
    for (const p of this.onDisk) if (p.startsWith(pre)) return true;
    return this.o.model.list().some((f) => f.path.startsWith(pre));
  }

  /** A disk name that differs from a project path only by Unicode normalization (macOS HFS+ readdir and FSEvents: NFD). */
  private alias(path: string) {
    const nfc = path.normalize('NFC');
    return nfc !== path && !this.o.model.find(path) && this.o.model.find(nfc) ? nfc : path;
  }

  /** Listing aliases, unless the host lists both forms (a normalization-sensitive filesystem: two files). */
  private aliasListed(disk: Array<{ path: string; size: number }>) {
    const names = new Set(disk.map((f) => f.path));
    return disk.map((f) => { const a = this.alias(f.path); return a === f.path || names.has(a) ? f : { ...f, path: a }; });
  }

  /** The project path a case-insensitive host gives the same name (a case-only rename leaves both spellings around). */
  private caseTwin(path: string) {
    const k = hostKey(path);
    return this.o.model.list().find((f) => f.path !== path && f.kind !== 'dir' && hostKey(f.path) === k)?.path;
  }

  private relatedToCollision(path: string) {
    const k = hostKey(path);
    for (const h of this.collisionHeld) { const hk = hostKey(h); if (hk === k || hk.startsWith(`${k}/`) || k.startsWith(`${hk}/`)) return true; }
    return false;
  }

  private async loadIgnoreFile() {
    const bytes = await this.o.fs.read(IGNORE_FILE);
    this.ig = ignore().add(MIRROR_IGNORES);
    if (bytes) this.ig.add(new TextDecoder().decode(bytes));
    const f = this.o.model.find(IGNORE_FILE);
    if (f?.kind === 'text') this.ig.add((await this.o.model.openText(f.id)).toString());
  }

  async start() {
    this.running = true;
    this.scanReady = false;
    for (const off of this.stopFns.splice(0)) off();
    try { await this.initialize(); }
    catch (error) { this.retryStart(error); }
  }

  /** Its own timer: a pending table retry never swallows a restart (and the reverse). */
  private retryStart(error: unknown) {
    this.scanReady = false;
    const n = ++this.startFailures;
    this.o.onNotice?.(`Folder access failed: ${String(error)}. No missing files were deleted; access will be retried.`);
    if (this.running && !this.startRetry) this.startRetry = setTimeout(() => { this.startRetry = null; void this.start(); }, this.backoff(n));
  }

  private async initialize() {
    await this.loadIgnoreFile();
    if (!this.running) return;
    // Subscribe first so no update that arrives while we reconcile can be missed.
    this.stopFns.push(this.o.fs.watch((ev) => {
      if (ev.error) { this.retryStart(ev.error); return; }
      this.onDiskEvent(ev.path);
    }));
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
    const saved = (await this.o.model.store.getMeta(BASE_META)) as Record<string, string> | null;
    if (!this.running) return;
    // A restart keeps bases not flushed yet (newer than the stored ones).
    this.savedBase = new Map([...Object.entries(saved ?? {}), ...this.savedBase]);
    // An unreadable leftover copy never stops the mirror: it stays in the folder and is retried on the next start.
    await this.captureRetained().catch((e) => this.o.onNotice?.(`A recovery copy in the folder could not be read (${errorText(e)}); it was left there.`));
    await this.initialReconcile();
    if (!this.running || !this.scanReady) return;
    await this.writeMarker();
    this.startFailures = 0;
    if (!this.failures.size) this.o.onNotice?.('Folder access is ready. Copies of external changes the project replaced are in History → Recovery.');
  }

  /** Writes (or updates) the folder marker, keeping fields we do not own such as the backup's `paths`. */
  /** Updates sharing metadata without rebinding the folder or touching project contents. */
  async updateProjectSlug(slug: string) {
    if (!this.o.marker) return;
    this.o.marker.slug = slug;
    await this.writeMarker(true);
  }

  private async writeMarker(reportFailure = true) {
    if (!this.o.marker || this.o.getRole() === 'viewer') return;
    const bytes = await this.o.fs.read(MARKER_FILE);
    const current = parseMarker(bytes);
    const cur = current ?? { version: 2 };
    if (current && cur.project?.id === this.o.marker.id && cur.project.slug === this.o.marker.slug && cur.version >= 2) return;
    const next: FolderMarker = { ...cur, version: 2, project: { id: this.o.marker.id, slug: this.o.marker.slug } };
    const copy = await this.o.fs.write(MARKER_FILE, new TextEncoder().encode(`${JSON.stringify(next, null, 2)}
`)).catch((e) => { if (reportFailure) throw e; });
    this.settle(copy, MARKER_FILE, bytes ? await sha256Hex(bytes) : undefined);
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
    // Settling copies finish on their own; one cut short is captured on the next start.
    for (const t of [this.tableRetry, this.startRetry]) if (t) clearTimeout(t);
    this.tableRetry = this.startRetry = null;
    if (this.baseTimer) {
      clearTimeout(this.baseTimer);
      this.baseTimer = null;
      void this.o.model.store.setMeta(BASE_META, Object.fromEntries(this.savedBase)).catch(() => {});
    }
    for (const s of this.stopFns.splice(0)) s();
    for (const t of [...this.pendingDisk.values(), ...this.pendingModel.values()]) clearTimeout(t);
    this.pendingDisk.clear();
    this.pendingModel.clear();
  }

  // ---- initial binding ----

  private async initialReconcile() {
    const scan = await scanFs(this.o.fs);
    if (!scan.complete) throw scan.error;
    const disk = this.aliasListed(scan.files.filter((f) => !this.isIgnored(f.path)));
    this.collisionHeld = pathCollisions([...this.o.model.list().filter((f) => !this.isIgnored(f.path)), ...disk]);
    this.scanReady = true;
    if (!this.running) return;
    for (const f of disk) {
      if (this.collisionHeld.has(f.path)) { this.o.onNotice?.(`"${f.path}" has conflicting project paths; its disk bytes were kept until the paths are renamed.`); continue; }
      const read = await readFs(this.o.fs, f.path);
      if (!this.running) return;
      if (read.kind === 'error') {
        // One unreadable file (locked, denied) does not stop the bind: it is compared once a retry can read it.
        this.unreadable.add(f.path);
        this.o.onNotice?.(`Could not read "${f.path}" (${errorText(read.error)}); it was kept as it is and reading will be retried.`);
        this.onDiskEvent(f.path);
        continue;
      }
      if (read.kind === 'present') await this.reconcileDiskFile(f.path, read.bytes);
    }
    // Project -> disk: everything not on disk yet.
    await this.writeAll();
  }

  /** One folder file as at bind time: disk -> project for new files, 3-way for differing text; viewers never push. */
  private async reconcileDiskFile(path: string, bytes: Uint8Array) {
    const entry = this.o.model.find(path);
    // A viewer's folder never changes the project: differences are resolved from the project's side only.
    if (this.o.getRole() === 'viewer') {
      await this.viewerInitial(path, bytes, entry);
      return;
    }
    this.lastWritten.set(path, await sha256Hex(bytes));
    this.onDisk.add(path);
    if (!entry) await this.importFile(path, bytes, entry);
    else if (entry.kind === 'text' && isTextPath(path, bytes)) await this.reconcileText(entry, bytes);
  }

  /**
   * One text file present in the folder and in the project's file list, at bind time or when its text became complete.
   * Content the project does not have yet is never mistaken for an empty file: the folder's copy waits untouched.
   */
  private async reconcileText(entry: FileEntry, bytes: Uint8Array) {
    if (!this.running || this.o.getRole() === 'viewer') return;
    const path = entry.path;
    if (this.o.model.availability(`f:${entry.id}`) !== 'complete') {
      this.deferred.add(path);
      return;
    }
    this.deferred.delete(path);
    const ytext = await this.o.model.openText(entry.id);
    if (!this.running || this.o.getRole() === 'viewer') return;
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
    await preserveRecovery(this.recoveryStore, path, bytes, 'Read-only folder content before reconciliation');
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

  private syncTableToDisk(): Promise<void> {
    const run = this.tableWork.then(() => this.applyTableToDisk());
    this.tableWork = run.then(() => { this.tableFailures = 0; }, (e) => {
      const n = ++this.tableFailures;
      this.o.onNotice?.(`Could not reconcile the folder (${errorText(e)}); files were kept and the operation will be retried.`);
      this.scheduleTableRetry(this.backoff(n));
    });
    return this.tableWork;
  }

  /** Its own timer: a pending restart never swallows a table retry (and the reverse). */
  private scheduleTableRetry(ms: number) {
    if (this.running && !this.tableRetry) this.tableRetry = setTimeout(() => { this.tableRetry = null; void this.syncTableToDisk(); }, ms);
  }

  private async applyTableToDisk() {
    if (!this.running || !this.scanReady) return;
    const entries = this.o.model.list().filter((f) => !this.isIgnored(f.path));
    const current = new Map(entries.map((f) => [f.path, f]));
    // Removed or renamed away: delete from disk, each path on its own (a locked file never stops the others).
    let retryIn = 0;
    for (const p of [...this.onDisk]) {
      if (current.has(p) || this.isIgnored(p) || this.held.has(p) || this.o.model.find(p)) continue;
      try {
        await this.removeFromDisk(p);
        this.removeFailures.delete(p);
      } catch (e) {
        const n = (this.removeFailures.get(p) ?? 0) + 1;
        this.removeFailures.set(p, n);
        this.o.onNotice?.(`Could not remove "${p}" from the folder (${errorText(e)}); it was kept and the removal is pending (retrying).`);
        retryIn = Math.min(retryIn || Number.POSITIVE_INFINITY, this.backoff(n));
      }
      if (!this.running) return;
    }
    // Collisions are judged after the removals, so a case-only rename does not collide with its own old name.
    const disk = this.aliasListed((await this.o.fs.list()).filter((f) => !this.isIgnored(f.path)));
    if (!this.running) return;
    const collisions = pathCollisions([...entries, ...disk]);
    this.collisionHeld = collisions;
    for (const path of collisions) {
      this.o.onNotice?.(`"${path}" has a case, Unicode, reserved-name or file/folder collision. Its versions remain in the project; rename it before mirroring.`);
    }
    for (const f of current.values()) await this.writeEntry(f);
    if (retryIn) this.scheduleTableRetry(retryIn);
  }

  /** Captures and rechecks the disk content before removing a file the project no longer has. */
  private async removeFromDisk(p: string) {
    const bytes = await this.readStable(p);
    if (!this.running || this.o.model.find(p)) return;
    if (bytes) {
      const record = await preserveRecovery(this.recoveryStore, p, bytes, 'project file removed or renamed');
      if (!this.running || this.o.model.find(p)) return;
      if (record.hash !== this.lastWritten.get(p)) {
        this.held.add(p);
        this.o.onNotice?.(`"${p}" changed in the folder before it was removed from the project. Its local version was kept on disk and in Recovery.`);
        return;
      }
      // Capture precedes removal; if an external tool moved meanwhile, do not remove its newer bytes.
      const check = await this.readStable(p);
      if (!this.running || this.o.model.find(p)) return;
      if (check && await sha256Hex(check) !== record.hash) {
        await preserveRecovery(this.recoveryStore, p, check, 'project file removed or renamed');
        this.held.add(p);
        this.o.onNotice?.(`"${p}" changed during removal. Its local version was kept on disk and in Recovery.`);
        return;
      }
      this.settle(await this.o.fs.remove(p), p, record.hash);
    }
    this.onDisk.delete(p);
    this.lastWritten.delete(p);
  }

  /** A failed write is retried with backoff; a parent that is a file on disk is a collision, held until renamed. */
  private failWrite(path: string, e: unknown) {
    if (errorCode(e) === 'ENOTDIR' || /ENOTDIR/.test(errorText(e))) {
      this.collisionHeld.add(path);
      this.o.onNotice?.(`"${path}" cannot be written: a parent folder of it is a file in the folder. Both were kept; rename one of them.`);
      return;
    }
    const n = (this.failures.get(path) ?? 0) + 1;
    this.failures.set(path, n);
    this.o.onNotice?.(`Could not write "${path}" to the folder (${errorText(e)}); trying again.`);
    if (this.running) this.scheduleWrite(path, this.backoff(n));
  }

  private async writeEntry(f: FileEntry) {
    if (!this.running || !this.scanReady) return;
    if (f.kind === 'dir' || this.isIgnored(f.path) || this.held.has(f.path) || this.collisionHeld.has(f.path) || this.unreadable.has(f.path)) return;
    if (pathCollisions(this.o.model.list()).has(f.path)) {
      this.o.onNotice?.(`"${f.path}" cannot be mapped safely to this folder. Rename the conflicting project paths.`);
      return;
    }
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
      // What the mirror last wrote or read here: a retained copy with other bytes holds external work.
      let expected = this.onDisk.has(f.path) ? this.lastWritten.get(f.path) : undefined;
      // If the file changed on disk since our last write (an external tool is mid-edit), merge that change
      // into the project first so writing the remote state does not clobber it.
      if (this.onDisk.has(f.path)) {
        const cur = await this.readStable(f.path);
        if (cur) {
          const curHash = await sha256Hex(cur);
          if (curHash !== this.lastWritten.get(f.path) && !this.isRecentWrite(f.path, curHash)) {
            await preserveRecovery(this.recoveryStore, f.path, cur, 'External folder content before project write');
            if (this.o.getRole() !== 'viewer') {
              this.lastWritten.set(f.path, curHash);
              await this.importFile(f.path, cur, this.o.model.find(f.path));
            }
          }
          expected = curHash;
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
      this.publishing.add(f.path); // its absence while publishing (or after a failed publication) is not a deletion
      let copy: unknown;
      try {
        copy = await this.o.fs.write(f.path, bytes);
      } catch (e) {
        // Not on disk: forget that we thought so (a retry must not see an "already written" hash), keep the old
        // baseline, and try again with a growing delay.
        if (previous === undefined) this.lastWritten.delete(f.path);
        else this.lastWritten.set(f.path, previous);
        if (!wasOnDisk) this.onDisk.delete(f.path);
        this.failWrite(f.path, e);
        return;
      } finally {
        this.publishing.delete(f.path);
      }
      this.settle(copy, f.path, expected);
      const recoveredWrite = this.failures.delete(f.path);
      if (recoveredWrite && !this.failures.size) this.o.onNotice?.('Folder writes recovered. Copies of external changes the project replaced are in History → Recovery.');
      // Renamed or deleted while the write was under way: it just put the old name back on disk.
      if (this.o.model.byId(f.id)?.path !== f.path) {
        if (this.o.model.find(f.path)) this.dirty.add(f.path); // another file took the name: write that one
        else {
          this.base.delete(f.path);
          // The usual reconciliation captures and rechecks the disk content before removing it.
          void this.syncTableToDisk();
        }
        return;
      }
      if (baseSnap) {
        this.base.set(f.path, baseSnap);
        this.rememberBase(f.path, baseSnap.text);
      }
    } catch (error) {
      // A read, fetch or merge failure on this path is retried for this path only; the mirror keeps running.
      if (this.running) this.failWrite(f.path, error);
    } finally {
      this.busy.delete(f.path);
      if (this.dirty.delete(f.path)) {
        const again = this.o.model.find(f.path);
        if (again) void this.writeEntry(again);
      }
    }
  }

  // ---- disk -> project ----

  private onDiskEvent(raw: string) {
    if (!this.running) return;
    const path = this.alias(raw);
    if (path === IGNORE_FILE) void this.loadIgnoreFile();
    // The marker is back (or changed): files that went missing without it are judged again.
    if (path === MARKER_FILE && this.unconfirmed.size) {
      const again = [...this.unconfirmed];
      this.unconfirmed.clear();
      for (const p of again) this.onDiskEvent(p);
    }
    if (this.isIgnored(path) || this.isDirPath(path)) return;
    const prev = this.pendingDisk.get(path);
    if (prev) clearTimeout(prev);
    this.pendingDisk.set(
      path,
      setTimeout(() => {
        this.pendingDisk.delete(path);
        void this.handleDiskChange(path).then(() => {
          this.readFailures.delete(path);
          if (this.relatedToCollision(path)) void this.syncTableToDisk(); // a blocking name may be gone
        }, (e) => {
          if (errorCode(e) === 'EISDIR' || !this.running) return; // a folder, not a file read failure
          const n = (this.readFailures.get(path) ?? 0) + 1;
          this.readFailures.set(path, n);
          this.o.onNotice?.(`Could not read "${path}" (${errorText(e)}); the project file was kept and reading will be retried.`);
          if (!this.pendingDisk.has(path)) this.pendingDisk.set(path, setTimeout(() => {
            this.pendingDisk.delete(path);
            this.onDiskEvent(path);
          }, this.backoff(n)));
        });
      }, this.o.debounceMs ?? 100),
    );
  }

  private async handleDiskChange(path: string) {
    const bytes = await this.readStable(path);
    if (!this.running) return;
    // Unreadable when the folder was bound: compared as at bind time now, then the project's version is written.
    if (this.unreadable.delete(path)) {
      if (bytes) await this.reconcileDiskFile(path, bytes);
      const again = this.o.model.find(path);
      if (again) await this.writeEntry(again);
      return;
    }
    const entry = this.o.model.find(path);
    // A case-insensitive host reads the new spelling under the old one after a case-only rename: our own bytes.
    if (!entry && bytes) {
      const twin = this.caseTwin(path);
      if (twin) {
        const h = await sha256Hex(bytes);
        if (this.lastWritten.get(twin) === h || this.isRecentWrite(twin, h)) return;
      }
    }

    if (this.o.getRole() === 'viewer') {
      if (bytes) await preserveRecovery(this.recoveryStore, path, bytes, 'Read-only folder edit before restoring project version');
      // Read-only members cannot change the project: restore the project's version on disk.
      if (entry && entry.kind !== 'dir') {
        this.lastWritten.delete(path);
        await this.writeEntry(entry);
      } else if (bytes) this.settle(await this.o.fs.remove(path).catch(() => null), path, await sha256Hex(bytes));
      this.o.onNotice?.(`"${path}" is read-only for you; your local change was reverted.`);
      return;
    }

    if (!bytes) {
      // A publication in flight or one that failed: the path comes back with the next write, it was not deleted.
      if (this.publishing.has(path) || this.failures.has(path)) return;
      if (this.o.marker) {
        const marker = parseMarker(await this.o.fs.read(MARKER_FILE));
        if (marker?.project?.id !== this.o.marker.id) {
          // Without our marker the absence is unconfirmed (another folder, a checkout): no deletion and no retry loop.
          // It is judged again when the marker returns; a rebind writes the project's files back.
          if (!this.unconfirmed.size) this.o.onNotice?.(`The folder marker ${MARKER_FILE} is missing or names another project: files missing from the folder are not deleted from the project. Restore the marker or use the folder again.`);
          this.unconfirmed.add(path);
          return;
        }
      }
      // Deleted on disk.
      this.onDisk.delete(path);
      this.lastWritten.delete(path);
      if (entry && entry.kind !== 'dir') this.o.model.delete(entry.id, MIRROR_ORIGIN);
      return;
    }
    this.unconfirmed.delete(path);
    const hash = await sha256Hex(bytes);
    if (!this.running || this.o.getRole() === 'viewer') return;
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
    if (!this.running || this.o.getRole() === 'viewer') return;
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
    const read = async () => { const result = await readFs(this.o.fs, path); if (result.kind === 'error') throw result.error; return result.kind === 'missing' ? null : result.bytes; };
    const pause = Math.max(20, Math.min(this.o.debounceMs ?? 100, 200));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const same = (a: Uint8Array | null, b: Uint8Array | null) =>
      a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
    let prev = await read();
    for (let i = 0; i < 25; i++) {
      await sleep(prev && prev.length === 0 && this.onDisk.has(path) ? pause * 3 : pause);
      const cur = await read();
      if (same(prev, cur)) return cur;
      prev = cur;
    }
    throw new Error(`"${path}" is still changing; reading will be retried without importing an unstable version`);
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
    if (!this.running || this.o.getRole() === 'viewer') return;
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
      if (!this.running || this.o.getRole() === 'viewer') return;
      if (entry?.kind === 'binary') this.o.model.setBinary(entry.id, hash, bytes.length, MIRROR_ORIGIN);
      else {
        if (entry) this.o.model.delete(entry.id, MIRROR_ORIGIN);
        this.o.model.createBinary(path, hash, bytes.length, MIRROR_ORIGIN);
      }
    }
  }
}
