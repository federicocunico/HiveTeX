import { ROOT_DOC_ID } from '@hivetex/protocol';
import DiffMatchPatch from 'diff-match-patch';
import { PeerConnection } from './connection.js';
import { MIRROR_ORIGIN } from './mirror.js';
import { type FileEntry, type ProjectModel, applyTextDiff } from './model.js';
import { type ChangeSet, type ChangeSetFile, DocPersister, type Persistence } from './persistence.js';

/** Origin of the edits an undo applies (they are recorded as their own change set). */
export const UNDO_ORIGIN = 'changelog-undo';

type Source = ChangeSet['source'];

interface PendingFile {
  fileId: string;
  path: string;
  op: ChangeSetFile['op'];
  from?: string;
  before?: string;
  hashBefore?: string | undefined;
  hashAfter?: string | undefined;
  sizeBefore?: number | undefined;
}

interface Pending {
  source: Source;
  startedAt: number;
  lastAt: number;
  files: Map<string, PendingFile>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ChangeLogOptions {
  model: ProjectModel;
  store: Persistence;
  /** Edits from one source closer together than this belong to the same change set. */
  idleMs?: number;
  now?: () => number;
}

const dmp = new DiffMatchPatch();

/** Number of added and removed lines between two texts. */
function lineStats(before: string, after: string) {
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(before, after);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  let added = 0;
  let removed = 0;
  for (const [op, text] of diffs) {
    const n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    if (op === DiffMatchPatch.DIFF_INSERT) added += n;
    else if (op === DiffMatchPatch.DIFF_DELETE) removed += n;
  }
  return { added, removed };
}

/** Inverts a diff-match-patch patch list (after -> before). */
interface Patch {
  diffs: Array<[number, string]>;
  start1: number;
  start2: number;
  length1: number;
  length2: number;
}

function invertPatches(text: string) {
  // (@types/diff-match-patch mistypes patch objects as constructors)
  const patches = dmp.patch_fromText(text) as unknown as Patch[];
  for (const p of patches) {
    p.diffs = p.diffs.map(([op, t]) => [-op, t] as [number, string]);
    [p.length1, p.length2] = [p.length2, p.length1];
    [p.start1, p.start2] = [p.start2, p.start1];
  }
  return patches as unknown as ReturnType<typeof dmp.patch_fromText>;
}

const newId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(9)), (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Records who changed what, as change sets: consecutive edits from one source (this device's folder, this device's
 * editor, a co-author, an undo) grouped until the source is idle. Stored on this device only; undo applies the
 * inverse as a normal collaborative edit. See openspec spec "change-history".
 */
export class ChangeLog {
  /** Last known text per file doc; a doc is only recorded once it has a baseline (first sight = baseline). */
  private texts = new Map<string, string>();
  private table = new Map<string, FileEntry>();
  private pending = new Map<string, Pending>();
  private cbs = new Set<() => void>();
  private unsub: (() => void) | null = null;

  constructor(private o: ChangeLogOptions) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  start() {
    for (const f of this.o.model.list()) this.table.set(f.id, f);
    for (const id of this.o.model.loadedDocIds()) {
      const doc = this.o.model.getLoadedDoc(id);
      if (id.startsWith('f:') && doc) this.texts.set(id.slice(2), doc.getText('t').toString());
    }
    this.unsub = this.o.model.onDocUpdate((docId, _u, origin) => this.onUpdate(docId, origin));
    void this.o.store.pruneChangeSets(this.now()).catch(() => 0);
  }

  stop() {
    this.unsub?.();
    this.unsub = null;
  }

  onChange(cb: () => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  /** Change sets recorded on this device, newest first (closed sets only). */
  list(): Promise<ChangeSet[]> {
    return this.o.store.listChangeSets();
  }

  private classify(origin: unknown): Source | null {
    if (origin instanceof DocPersister) return null;
    if (origin === MIRROR_ORIGIN) return { kind: 'folder', name: 'Folder on this device' };
    if (origin === UNDO_ORIGIN) return { kind: 'undo', name: 'Undo' };
    if (origin instanceof PeerConnection) return { kind: 'peer', name: origin.claims?.uname ?? 'Co-author' };
    return { kind: 'editor', name: 'This device' };
  }

  private onUpdate(docId: string, origin: unknown) {
    const source = this.classify(origin);
    if (docId === ROOT_DOC_ID) return this.onTable(source);
    if (!docId.startsWith('f:')) return;
    const fileId = docId.slice(2);
    const doc = this.o.model.getLoadedDoc(docId);
    if (!doc) return;
    const after = doc.getText('t').toString();
    const before = this.texts.get(fileId);
    this.texts.set(fileId, after);
    // First sight of a document (loaded or received in the initial sync) is its baseline, not a change.
    if (!source || before === undefined || before === after) return;
    const entry = this.table.get(fileId) ?? this.o.model.byId(fileId);
    if (!entry) return;
    const p = this.touch(source);
    if (!p.files.has(fileId)) p.files.set(fileId, { fileId, path: entry.path, op: 'edit', before });
  }

  private onTable(source: Source | null) {
    const next = new Map(this.o.model.list().map((f) => [f.id, f]));
    const prev = this.table;
    this.table = next;
    if (!source) return;
    for (const [id, f] of next) {
      const old = prev.get(id);
      if (!old) {
        if (f.kind === 'dir') continue;
        this.touch(source).files.set(id, { fileId: id, path: f.path, op: 'create', before: '', hashAfter: f.hash });
      } else if (old.path !== f.path) {
        const p = this.touch(source);
        const cur = p.files.get(id);
        if (cur?.op === 'create') cur.path = f.path;
        else p.files.set(id, { fileId: id, path: f.path, op: 'rename', from: cur?.from ?? old.path });
      } else if (f.kind === 'binary' && old.hash !== f.hash) {
        const p = this.touch(source);
        const cur = p.files.get(id);
        if (cur) cur.hashAfter = f.hash;
        else p.files.set(id, { fileId: id, path: f.path, op: 'binary', hashBefore: old.hash, hashAfter: f.hash, sizeBefore: old.size });
      }
    }
    for (const [id, old] of prev) {
      if (next.has(id) || old.kind === 'dir') continue;
      const p = this.touch(source);
      if (p.files.get(id)?.op === 'create') {
        p.files.delete(id); // created and deleted within one set: nothing happened
        continue;
      }
      const text = this.texts.get(id);
      p.files.set(id, {
        fileId: id,
        path: old.path,
        op: 'delete',
        ...(old.kind === 'text' ? { before: text ?? '' } : { hashBefore: old.hash, sizeBefore: old.size }),
      });
    }
  }

  private key(s: Source) {
    return `${s.kind}:${s.name}`;
  }

  private touch(source: Source): Pending {
    const k = this.key(source);
    let p = this.pending.get(k);
    const t = this.now();
    if (!p) {
      p = { source, startedAt: t, lastAt: t, files: new Map(), timer: null };
      this.pending.set(k, p);
    }
    p.lastAt = t;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => void this.close(k), this.o.idleMs ?? 3000);
    return p;
  }

  /** Closes a pending change set and stores it. */
  private async close(k: string): Promise<ChangeSet | null> {
    const p = this.pending.get(k);
    if (!p) return null;
    this.pending.delete(k);
    if (p.timer) clearTimeout(p.timer);
    const files: ChangeSetFile[] = [];
    for (const f of p.files.values()) {
      const out: ChangeSetFile = { fileId: f.fileId, path: f.path, op: f.op };
      if (f.from) out.from = f.from;
      if (f.hashBefore) out.hashBefore = f.hashBefore;
      if (f.sizeBefore !== undefined) out.sizeBefore = f.sizeBefore;
      if (f.hashAfter) out.hashAfter = f.hashAfter;
      if (f.op === 'delete' && f.before !== undefined) out.before = f.before;
      if (f.op === 'edit' || f.op === 'create' || (f.op === 'delete' && f.before !== undefined)) {
        const before = f.op === 'create' ? '' : (f.before ?? '');
        const after = f.op === 'delete' ? '' : (this.texts.get(f.fileId) ?? '');
        if (f.op === 'edit' && before === after) continue;
        out.patch = dmp.patch_toText(dmp.patch_make(before, after));
        Object.assign(out, lineStats(before, after));
      }
      files.push(out);
    }
    if (files.length === 0) return null;
    const set: ChangeSet = { id: newId(), source: p.source, startedAt: p.startedAt, endedAt: p.lastAt, files };
    await this.o.store.putChangeSet(set);
    for (const cb of this.cbs) cb();
    return set;
  }

  /** Closes every pending change set now (on leaving the project, and in tests). */
  async flush() {
    for (const k of [...this.pending.keys()]) await this.close(k);
  }

  /**
   * Reverses a change set as a normal collaborative edit. Later, non-overlapping edits are preserved; files whose
   * change cannot be reversed cleanly (later edits overlap) are reported in `partial`.
   */
  async undo(set: ChangeSet): Promise<ChangeSet | null> {
    const { model } = this.o;
    const partial: string[] = [];
    for (const f of [...set.files].reverse()) {
      const cur = model.byId(f.fileId);
      if (f.op === 'edit' && f.patch) {
        if (!cur || cur.kind !== 'text') {
          partial.push(f.path);
          continue;
        }
        const ytext = await model.openText(f.fileId);
        const [result, applied] = dmp.patch_apply(invertPatches(f.patch), ytext.toString());
        if (applied.some((ok) => !ok)) partial.push(f.path);
        applyTextDiff(ytext, result, UNDO_ORIGIN);
      } else if (f.op === 'create') {
        if (cur) model.delete(f.fileId, UNDO_ORIGIN);
      } else if (f.op === 'delete') {
        if (model.find(f.path)) {
          partial.push(f.path);
        } else if (f.before !== undefined) {
          await model.createTextNow(f.path, f.before, UNDO_ORIGIN);
        } else if (f.hashBefore) {
          model.createBinary(f.path, f.hashBefore, f.sizeBefore ?? 0, UNDO_ORIGIN);
        }
      } else if (f.op === 'rename' && f.from) {
        if (cur && !model.find(f.from)) model.rename(f.fileId, f.from, UNDO_ORIGIN);
        else partial.push(f.path);
      } else if (f.op === 'binary' && f.hashBefore) {
        if (cur) model.setBinary(f.fileId, f.hashBefore, f.sizeBefore ?? 0, UNDO_ORIGIN);
        else partial.push(f.path);
      }
    }
    const done = await this.close(this.key({ kind: 'undo', name: 'Undo' }));
    if (!done) return null;
    done.source = { kind: 'undo', name: `Undo of ${set.source.name}` };
    done.undoOf = set.id;
    if (partial.length) done.partial = partial;
    await this.o.store.putChangeSet(done);
    for (const cb of this.cbs) cb();
    return done;
  }
}

/** A stored patch as display hunks: runs of unchanged (0), removed (-1) and added (1) text, hunk by hunk. */
export function patchHunks(patch: string): Array<Array<{ op: -1 | 0 | 1; text: string }>> {
  const patches = dmp.patch_fromText(patch) as unknown as Patch[];
  return patches.map((p) => p.diffs.map(([op, text]) => ({ op: op as -1 | 0 | 1, text })));
}
