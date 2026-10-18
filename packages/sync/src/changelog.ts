import { ROOT_DOC_ID } from '@hivetex/protocol';
import DiffMatchPatch from 'diff-match-patch';
import { PeerConnection } from './connection.js';
import { AuthoredOrigin, readAuthoredOperation } from './authorship.js';
import { projectAuthoredOperation } from './history-projection.js';
import { MIRROR_ORIGIN } from './origins.js';
import { type FileEntry, type ProjectModel, applyTextDiff, docFrontier } from './model.js';
import { type ChangeSet, type ChangeSetFile, DocPersister, type Persistence, listOperations, operationStates } from './persistence.js';

/** Origin of the edits an undo applies (they are recorded as their own change set). */
export const UNDO_ORIGIN = 'changelog-undo';

type Source = ChangeSet['source'];

/** One file an undo already inverted, with what is needed to reverse exactly that step (History "Cancel"). */
export type UndoStep = { i: number; path: string; fileId: string } & (
  | { kind: 'text'; before: string; after: string }
  | { kind: 'removed' }
  | { kind: 'restored'; frontier?: number[]; hash?: string }
  | { kind: 'renamed'; from: string; to: string }
  | { kind: 'binary'; from: string; fromSize: number; to: string });

/** Durable checkpoint `undo:request:<change set id>`: `prepared` until the undo completes or is cancelled. */
export interface UndoRequest {
  v: 1;
  stage: 'prepared' | 'completed';
  changeSetId: string;
  /** Recovery snapshot captured before the first inversion. */
  undoId: string;
  at?: number;
  label?: string;
  done: UndoStep[];
  partial?: string[];
  resultId?: string;
}

interface PendingFile {
  fileId: string;
  path: string;
  op: ChangeSetFile['op'];
  from?: string;
  before?: string | undefined;
  after?: string | undefined;
  frontierAfter?: number[];
  kind?: FileEntry['kind'];
  hashBefore?: string | undefined;
  hashAfter?: string | undefined;
  sizeBefore?: number | undefined;
}

interface Pending {
  operationIds: string[];
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

interface Patch {
  diffs: Array<[number, string]>;
  start1: number;
  start2: number;
  length1: number;
  length2: number;
}

interface TextEdit { start: number; end: number; insert: string }
function textEdits(before: string, after: string): TextEdit[] {
  const edits: TextEdit[] = [];
  let pos = 0;
  let edit: TextEdit | undefined;
  for (const [op, chunk] of dmp.diff_main(before, after)) {
    if (op === 0) {
      if (edit) edits.push(edit);
      edit = undefined;
      pos += chunk.length;
    } else {
      edit ??= { start: pos, end: pos, insert: '' };
      if (op === 1) edit.insert += chunk;
      else { pos += chunk.length; edit.end = pos; }
    }
  }
  if (edit) edits.push(edit);
  return edits;
}

/** Transform an exact inverse over disjoint later edits. Never fuzzy-match an inverse into another occurrence. */
function selectiveInverse(before: string, after: string, current: string): string | null {
  const inverse = textEdits(after, before);
  const later = textEdits(after, current);
  for (const a of inverse) for (const b of later) {
    const aPoint = a.start === a.end, bPoint = b.start === b.end;
    const overlap = aPoint && bPoint ? a.start === b.start
      : aPoint ? a.start >= b.start && a.start <= b.end
      : bPoint ? b.start > a.start && b.start < a.end
      : a.start < b.end && b.start < a.end;
    if (overlap) return null;
  }
  const offset = (at: number, right: boolean) => at + later.reduce((n, e) => {
    if (e.end < at || (e.end === at && e.start < e.end) || (e.start === at && e.end === at && right)) return n + e.insert.length - (e.end - e.start);
    return n;
  }, 0);
  let result = current;
  for (const edit of [...inverse].reverse()) result = result.slice(0, offset(edit.start, true)) + edit.insert + result.slice(offset(edit.end, false));
  return result;
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
  private unsubBefore: (() => void) | null = null;
  private closing = new Set<Promise<ChangeSet | null>>();
  private unsaved = new Map<string, ChangeSet>();
  private saving: Promise<void> = Promise.resolve();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private recovered: Promise<void> = Promise.resolve();
  private unsubOperation: (() => void) | null = null;
  private undoing = new Map<string, Promise<ChangeSet | null>>();
  /** Operation records observed live in this session: their own groups project them, never recoverJournal. */
  private live = new Set<string>();
  private rootBaseline = false;

  constructor(private o: ChangeLogOptions) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  start() {
    this.stopped = false;
    this.unsubOperation = this.o.model.onOperation((record) => {
      this.live.add(record.id);
      if (record.authoredOpId) return;
      this.touch(record.source).operationIds.push(record.id);
    });
    // Same queue as group persistence: a record of a live group is never projected a second time (D4).
    const recover = () => this.recoverJournal();
    this.recovered = this.saving.then(recover, recover);
    this.saving = this.recovered.catch(() => {});
    for (const f of this.o.model.list()) this.table.set(f.id, f);
    for (const id of this.o.model.loadedDocIds()) {
      const doc = this.o.model.getLoadedDoc(id);
      if (id.startsWith('f:') && doc) this.texts.set(id.slice(2), doc.getText('t').toString());
    }
    this.unsub = this.o.model.onDocUpdate((docId, _u, origin) => this.onUpdate(docId, origin));
    this.unsubBefore = this.o.model.onBeforeChange((docId, doc, origin) => {
      // Hydration precedes observation. Establish the persisted baseline before the first real lazy edit.
      if ((origin instanceof PeerConnection || origin instanceof AuthoredOrigin) && this.o.model.availability(docId) !== 'complete') {
        // The file table received before it is complete (joining, bootstrap) is the baseline, not a peer's creations.
        if (docId === ROOT_DOC_ID) this.rootBaseline = true;
        return;
      }
      if (docId.startsWith('f:') && !this.texts.has(docId.slice(2))) this.texts.set(docId.slice(2), doc.getText('t').toString());
    });
    void this.o.store.pruneChangeSets(this.now()).catch(() => 0);
  }

  stop() {
    this.stopped = true;
    this.unsubOperation?.();
    this.unsub?.();
    this.unsub = null;
    this.unsubBefore?.();
    this.unsubBefore = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
  }

  onChange(cb: () => void) {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  /** Change sets recorded on this device, newest first (closed sets only). */
  async list(): Promise<ChangeSet[]> {
    await this.recovered;
    return (await this.o.store.listChangeSets()).filter((c) => c.files.length || c.partial?.length);
  }

  private classify(origin: unknown): Source | null {
    if (origin instanceof DocPersister) return null;
    if (origin instanceof AuthoredOrigin) return null;
    if (origin instanceof PeerConnection) return { kind: 'peer', name: 'Unknown original author (legacy sync)', provenance: 'unknown' };
    return this.o.model.operationSource(origin);
  }

  private onUpdate(docId: string, origin: unknown) {
    const source = this.classify(origin);
    const remote = origin instanceof AuthoredOrigin || origin instanceof PeerConnection;
    if (docId === ROOT_DOC_ID) {
      const baseline = this.rootBaseline;
      this.rootBaseline = false;
      return this.onTable(baseline ? null : source, remote && !baseline);
    }
    if (!docId.startsWith('f:')) return;
    const fileId = docId.slice(2);
    // A co-author's edit ends any open local change set on this document before the baseline moves (D4).
    if (remote) this.closeTouching(new Set([fileId]), source);
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
    const cur = p.files.get(fileId);
    if (cur) { cur.after = after; cur.frontierAfter = docFrontier(doc); }
    else p.files.set(fileId, { fileId, path: entry.path, op: 'edit', before, after });
  }

  private onTable(source: Source | null, remote = false) {
    const next = new Map(this.o.model.list().map((f) => [f.id, f]));
    const prev = this.table;
    if (remote) {
      const changed = new Set<string>();
      for (const [id, f] of next) { const old = prev.get(id); if (!old || old.path !== f.path || old.hash !== f.hash) changed.add(id); }
      for (const id of prev.keys()) if (!next.has(id)) changed.add(id);
      this.closeTouching(changed, source);
    }
    this.table = next;
    if (!source) return;
    for (const [id, f] of next) {
      const old = prev.get(id);
      if (!old) {
        if (f.kind === 'dir') continue;
        const group = this.touch(source);
        const doc = this.o.model.getLoadedDoc(`f:${id}`);
        group.files.set(group.files.has(id) ? `${id}:create:${newId()}` : id, { fileId: id, path: f.path, kind: f.kind, op: 'create', before: '', after: this.texts.get(id), hashAfter: f.hash,
          ...(f.kind === 'text' ? { frontierAfter: doc ? docFrontier(doc) : [0, -1, 0, 0] } : {}) });
      } else if (old.path !== f.path) {
        const p = this.touch(source);
        const cur = p.files.get(id);
        {
          const key = `${id}:rename`;
          const rename = p.files.get(key);
          p.files.set(key, { fileId: id, path: f.path, op: 'rename', from: rename?.from ?? old.path });
          if (cur && cur.op !== 'create') cur.path = f.path;
        }
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
      const text = this.texts.get(id);
      p.files.set(`${id}:delete`, {
        fileId: id,
        path: old.path,
        op: 'delete',
        kind: old.kind,
        ...(old.kind === 'text' ? { before: text } : { hashBefore: old.hash, sizeBefore: old.size }),
      });
    }
  }

  /** Closes the pending groups of other sources that touched any of `ids`. */
  private closeTouching(ids: Set<string>, except: Source | null) {
    const keep = except ? this.key(except) : null;
    for (const [k, p] of [...this.pending]) {
      if (k !== keep && [...p.files.values()].some((f) => ids.has(f.fileId))) void this.close(k).catch(() => {});
    }
  }

  private key(s: Source) {
    return `${s.kind}:${s.uid ?? s.name}:${s.device ?? ''}`;
  }

  private touch(source: Source): Pending {
    const k = this.key(source);
    // A source switch ends consecutive work. Each file's after-state is captured at its own update.
    for (const other of [...this.pending.keys()]) if (other !== k) void this.close(other).catch(() => {});
    let p = this.pending.get(k);
    const t = this.now();
    if (!p) {
      p = { source, startedAt: t, lastAt: t, files: new Map(), timer: null, operationIds: [] };
      this.pending.set(k, p);
    }
    p.lastAt = t;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => void this.close(k).catch(() => {}), this.o.idleMs ?? 3000);
    return p;
  }

  /** Closes a pending change set and stores it. */
  private close(k: string): Promise<ChangeSet | null> {
    const p = this.pending.get(k);
    if (!p) return Promise.resolve(null);
    this.pending.delete(k);
    if (p.timer) clearTimeout(p.timer);
    // The group ends now: freeze after-states before a later update (or build's own awaits) moves the baseline.
    for (const f of p.files.values()) if ((f.op === 'edit' || f.op === 'create') && f.after === undefined) f.after = this.texts.get(f.fileId);
    const run = this.build(p);
    this.closing.add(run);
    void run.then(() => this.closing.delete(run), () => this.closing.delete(run));
    return run;
  }

  private async build(p: Pending): Promise<ChangeSet | null> {
    const files: ChangeSetFile[] = [];
    for (const f of p.files.values()) {
      if (f.op === 'delete' && f.kind === 'text' && f.before === undefined) {
        try { f.before = (await this.o.model.openText(f.fileId)).toString(); }
        catch (e) {
          // Keep the unresolved group for retry instead of committing an empty preimage.
          const key = this.key(p.source);
          if (!this.pending.has(key)) this.pending.set(key, p);
          throw e;
        }
      }
      const out: ChangeSetFile = { fileId: f.fileId, path: f.path, op: f.op };
      if (f.from) out.from = f.from;
      if (f.hashBefore) out.hashBefore = f.hashBefore;
      if (f.sizeBefore !== undefined) out.sizeBefore = f.sizeBefore;
      if (f.hashAfter) out.hashAfter = f.hashAfter;
      if (f.frontierAfter) out.frontierAfter = f.frontierAfter;
      if (f.op === 'delete' && f.before !== undefined) out.before = f.before;
      if (f.op === 'edit' || f.op === 'create' || (f.op === 'delete' && f.before !== undefined)) {
        const before = f.op === 'create' ? '' : (f.before ?? '');
        const after = f.op === 'delete' ? '' : (f.after ?? this.texts.get(f.fileId) ?? '');
        if (f.op === 'edit' && before === after) continue;
        out.before = before;
        out.after = after;
        out.patch = dmp.patch_toText(dmp.patch_make(before, after));
        Object.assign(out, lineStats(before, after));
      }
      files.push(out);
    }
    // Baselines (load, bootstrap, first receipt) form no change set, but their records are still marked projected:
    // otherwise a restart replays them as whole-file edits by an unknown author.
    if (files.length === 0 && !p.operationIds.length) return null;
    const set: ChangeSet = { id: newId(), source: p.source, startedAt: p.startedAt, endedAt: p.lastAt, files, operationIds: p.operationIds };
    this.unsaved.set(set.id, set);
    await this.persistQueued();
    return files.length ? set : null;
  }

  private persistQueued(): Promise<void> {
    const run = async () => {
      for (const [id, set] of this.unsaved) {
        const shown = set.files.length > 0 || !!set.partial?.length;
        if (shown) await this.o.store.putChangeSet(set);
        if (set.operationIds?.length) await this.o.store.transact(set.operationIds.map((opId) => ({ op: 'meta', key: `operation:projected:${opId}`, value: shown ? set.id : 'baseline' })));
        this.unsaved.delete(id);
        if (shown) for (const cb of this.cbs) cb();
      }
      this.o.model.durabilityError('change-history', null);
    };
    const next = this.saving.then(run, run);
    this.saving = next.catch((error) => {
      this.o.model.durabilityError('change-history', error);
      if (!this.stopped && !this.retry) this.retry = setTimeout(() => {
        this.retry = null;
        void this.persistQueued().catch(() => {});
      }, 500);
    });
    return next;
  }

  /** Closes every pending change set now (on leaving the project, and in tests). */
  async flush() {
    for (const k of [...this.pending.keys()]) await this.close(k);
    await Promise.all([...this.closing]);
    await this.persistQueued();
  }

  /**
   * Reverses a change set as a normal collaborative edit. Later, non-overlapping edits are preserved; files whose
   * change cannot be reversed cleanly (later edits overlap) are reported in `partial`. An interrupted undo of the same
   * change set is completed from its checkpoint: files already inverted are not inverted twice.
   */
  undo(set: ChangeSet, canApply: () => boolean = () => true): Promise<ChangeSet | null> {
    return this.serial(set.id, () => this.runUndo(set, canApply));
  }

  /** Reverses the files an interrupted undo already inverted and closes its checkpoint (History "Cancel"). */
  abandonUndo(changeSetId: string, canApply: () => boolean = () => true): Promise<ChangeSet | null> {
    return this.serial(changeSetId, () => this.runAbandon(changeSetId, canApply));
  }

  /** Checkpoints of interrupted undos, newest first (keys under `undo:request:` only). */
  async interruptedUndos(): Promise<UndoRequest[]> {
    const keys = (await this.o.store.listMetaKeys?.('undo:request:') ?? []).filter((k) => k.startsWith('undo:request:'));
    const all = await Promise.all(keys.map((k) => this.o.store.getMeta(k) as Promise<UndoRequest | undefined>));
    return all.filter((r): r is UndoRequest => r?.stage === 'prepared').sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }

  private serial(id: string, run: () => Promise<ChangeSet | null>) {
    const inflight = this.undoing.get(id);
    if (inflight) return inflight;
    const work = run();
    this.undoing.set(id, work);
    void work.then(() => this.undoing.delete(id), () => this.undoing.delete(id));
    return work;
  }

  private async runUndo(set: ChangeSet, canApply: () => boolean): Promise<ChangeSet | null> {
    const { model } = this.o;
    if (!canApply()) throw new Error('denied');
    await this.flush();
    const existing = (await this.list()).find((c) => c.undoOf === set.id);
    if (existing) return existing;
    const requestKey = `undo:request:${set.id}`;
    const prior = await this.o.store.getMeta(requestKey) as UndoRequest | undefined;
    if (prior?.stage === 'completed') return null;
    const resume = prior?.stage === 'prepared' ? prior : undefined;
    // Preconditions (complete content for the recovery snapshot) precede the checkpoint. It is written right before
    // the first mutation and removed again when nothing was mutated (D4).
    const request: UndoRequest = resume ? { ...resume, done: [...(resume.done ?? [])] }
      : { v: 1, stage: 'prepared', changeSetId: set.id, undoId: (await model.captureSnapshot()).id, at: this.now(), label: set.source.name, done: [] };
    const skip = new Set(request.done.map((s) => s.i));
    const partial: string[] = [...(resume?.partial ?? [])];
    let written = !!resume;
    const mutate = async (plan: () => UndoStep | null | Promise<UndoStep | null>, path: string) => {
      if (!written) { await this.o.store.setMeta(requestKey, request); written = true; }
      if (!canApply()) throw new Error('denied');
      const step = await plan();
      if (!step) { partial.push(path); return; }
      // The inversion is durable before it is recorded: a resumed undo never skips an edit that was lost.
      await model.flush();
      request.done.push(step);
      await this.o.store.setMeta(requestKey, { ...request, partial });
    };
    try {
      for (const [i, f] of [...set.files].reverse().entries()) {
        if (skip.has(i)) continue;
        if (!canApply()) throw new Error('denied');
        const cur = model.byId(f.fileId);
        if (f.op === 'edit' && f.patch) {
          if (!cur || cur.kind !== 'text') {
            partial.push(f.path);
            continue;
          }
          const ytext = await model.openText(f.fileId);
          await mutate(() => {
            const before = ytext.toString();
            const result = f.before !== undefined && f.after !== undefined ? selectiveInverse(f.before, f.after, before) : null;
            if (result === null) return null;
            applyTextDiff(ytext, result, UNDO_ORIGIN);
            return { i, path: f.path, kind: 'text', fileId: f.fileId, before, after: ytext.toString() };
          }, f.path);
        } else if (f.op === 'create') {
          if (cur) {
            const text = cur.kind === 'text' ? await model.openText(cur.id) : undefined;
            await mutate(() => {
              const actual = model.byId(f.fileId);
              const vector = text?.doc ? docFrontier(text.doc) : undefined;
              const sameFrontier = f.frontierAfter && vector && f.frontierAfter.length === vector.length && f.frontierAfter.every((v, n) => v === vector[n]);
              const unchanged = actual?.path === f.path && (actual.kind === 'text'
                ? f.after !== undefined && text?.toString() === f.after && sameFrontier
                : actual.kind === 'binary' && !!f.hashAfter && actual.hash === f.hashAfter && model.binaryVersions(actual.id).length <= 1);
              if (!unchanged) return null;
              model.delete(f.fileId, UNDO_ORIGIN);
              return { i, path: f.path, kind: 'removed', fileId: f.fileId };
            }, f.path);
          }
        } else if (f.op === 'delete') {
          if (model.find(f.path)) {
            partial.push(f.path);
            continue;
          }
          const restored = (fileId: string): UndoStep => {
            const doc = model.getLoadedDoc(`f:${fileId}`), hash = model.byId(fileId)?.hash;
            return { i, path: f.path, kind: 'restored', fileId, ...(doc ? { frontier: docFrontier(doc) } : {}), ...(hash ? { hash } : {}) };
          };
          const deleted = model.deletedFiles().find((d) => d.id === f.fileId);
          const before = f.before, hashBefore = f.hashBefore;
          if (deleted) await mutate(() => { model.restoreDeleted(deleted.id, deleted.deletion.id, f.path, canApply); return restored(deleted.id); }, f.path);
          else if (before !== undefined) await mutate(async () => restored(await model.createTextNow(f.path, before, UNDO_ORIGIN, canApply)), f.path);
          else if (hashBefore) await mutate(() => restored(model.createBinary(f.path, hashBefore, f.sizeBefore ?? 0, UNDO_ORIGIN)), f.path);
        } else if (f.op === 'rename' && f.from) {
          const from = f.from;
          await mutate(() => {
            const now = model.byId(f.fileId);
            if (!now || now.path !== f.path || model.find(from)) return null;
            model.rename(f.fileId, from, UNDO_ORIGIN);
            return { i, path: f.path, kind: 'renamed', fileId: f.fileId, from: f.path, to: from };
          }, f.path);
        } else if (f.op === 'binary' && f.hashBefore) {
          const hashBefore = f.hashBefore;
          if (cur && cur.hash === f.hashAfter && await this.o.store.getBlob(hashBefore)) {
            await mutate(() => {
              const now = model.byId(f.fileId);
              if (!now || now.hash !== f.hashAfter) return null;
              model.setBinary(f.fileId, hashBefore, f.sizeBefore ?? 0, UNDO_ORIGIN);
              return { i, path: f.path, kind: 'binary', fileId: f.fileId, from: now.hash ?? '', fromSize: now.size ?? 0, to: hashBefore };
            }, f.path);
          } else partial.push(f.path);
        }
      }
    } catch (e) {
      // Nothing mutated: no checkpoint may remain. Otherwise History offers to complete or cancel it.
      if (written && !resume && request.done.length === 0) await this.o.store.transact([{ op: 'meta', key: requestKey, value: undefined }]).catch(() => {});
      else if (written) await this.o.store.setMeta(requestKey, { ...request, partial }).catch(() => {});
      throw e;
    }
    const changed = await this.close(this.key(model.operationSource(UNDO_ORIGIN)));
    if (!changed && partial.length === 0 && request.done.length === 0) {
      if (written) await this.o.store.setMeta(requestKey, { ...request, stage: 'completed' });
      return null;
    }
    const done = changed ?? { id: newId(), source: { kind: 'undo' as const, name: 'Undo' }, startedAt: this.now(), endedAt: this.now(), files: [] };
    done.source = { ...model.operationSource(UNDO_ORIGIN), name: `Undo of ${set.source.name}` };
    done.undoOf = set.id;
    if (partial.length) done.partial = [...new Set(partial)];
    await model.flush();
    await this.o.store.putChangeSet(done);
    await this.o.store.setMeta(requestKey, { ...request, stage: 'completed', resultId: done.id, ...(done.partial ? { partial: done.partial } : {}) });
    for (const cb of this.cbs) cb();
    return done;
  }

  private async runAbandon(changeSetId: string, canApply: () => boolean): Promise<ChangeSet | null> {
    const { model } = this.o;
    const requestKey = `undo:request:${changeSetId}`;
    const request = await this.o.store.getMeta(requestKey) as UndoRequest | undefined;
    if (request?.stage !== 'prepared') throw new Error('No interrupted undo to cancel; refresh History');
    if (!canApply()) throw new Error('denied');
    await this.flush();
    const partial: string[] = [];
    const same = (a?: number[], b?: number[]) => !!a && !!b && a.length === b.length && a.every((v, n) => v === b[n]);
    for (const step of [...(request.done ?? [])].reverse()) {
      if (!canApply()) throw new Error('denied');
      const cur = model.byId(step.fileId);
      if (step.kind === 'text') {
        if (!cur || cur.kind !== 'text') { partial.push(step.path); continue; }
        const ytext = await model.openText(step.fileId);
        if (!canApply()) throw new Error('denied');
        const result = selectiveInverse(step.before, step.after, ytext.toString());
        if (result === null) partial.push(step.path);
        else applyTextDiff(ytext, result, UNDO_ORIGIN);
      } else if (step.kind === 'removed') {
        const deleted = model.deletedFiles().find((d) => d.id === step.fileId);
        if (!deleted || model.find(step.path)) partial.push(step.path);
        else model.restoreDeleted(deleted.id, deleted.deletion.id, step.path, canApply);
      } else if (step.kind === 'restored') {
        if (!cur) continue;
        const text = cur.kind === 'text' ? await model.openText(cur.id) : undefined;
        if (!canApply()) throw new Error('denied');
        // Never remove a later contribution (audit F04): only an untouched restored file is deleted again.
        const unchanged = cur.kind === 'text' ? same(step.frontier, text?.doc ? docFrontier(text.doc) : undefined) : cur.kind === 'binary' && cur.hash === step.hash;
        if (unchanged) model.delete(step.fileId, UNDO_ORIGIN);
        else partial.push(step.path);
      } else if (step.kind === 'renamed') {
        if (cur && cur.path === step.to && !model.find(step.from)) model.rename(step.fileId, step.from, UNDO_ORIGIN);
        else partial.push(step.path);
      } else if (step.kind === 'binary') {
        if (cur && cur.hash === step.to && await this.o.store.getBlob(step.from)) {
          if (!canApply()) throw new Error('denied');
          model.setBinary(step.fileId, step.from, step.fromSize, UNDO_ORIGIN);
        } else partial.push(step.path);
      }
    }
    const changed = await this.close(this.key(model.operationSource(UNDO_ORIGIN)));
    const done = changed ?? { id: newId(), source: { kind: 'undo' as const, name: 'Undo' }, startedAt: this.now(), endedAt: this.now(), files: [] };
    done.source = { ...model.operationSource(UNDO_ORIGIN), name: `Cancelled undo of ${request.label ?? 'a change'}` };
    if (partial.length) done.partial = [...new Set(partial)];
    await model.flush();
    const shown = done.files.length > 0 || !!done.partial?.length;
    if (shown) await this.o.store.putChangeSet(done);
    // A cancelled checkpoint is closed: a later undo of the same change set starts afresh.
    await this.o.store.transact([{ op: 'meta', key: requestKey, value: undefined }]);
    for (const cb of this.cbs) cb();
    return shown ? done : null;
  }

  /** Recover acknowledged operations even if the process stopped before the idle display group was saved. */
  private async recoverJournal() {
    // Keys only: records already projected (or live in this session) are never read (D6).
    const projected = new Set((await this.o.store.listMetaKeys?.('operation:projected:') ?? []).filter((k) => k.startsWith('operation:projected:')).map((k) => k.slice(20)));
    const records = await listOperations(this.o.store, (id) => !projected.has(id) && !this.live.has(id));
    if (!records.length) return;
    const covered = new Set((await this.o.store.listChangeSets()).flatMap((c) => c.operationIds ?? []));
    for (const record of records) {
      if (this.live.has(record.id)) continue;
      if ((record.authoredOpId && covered.has(record.authoredOpId)) || covered.has(record.id)) {
        await this.o.store.setMeta(`operation:projected:${record.id}`, 'covered');
        continue;
      }
      if (record.authoredOpId) {
        const operation = await readAuthoredOperation(this.o.store, record.authoredOpId);
        if (operation) {
          // This envelope was verified at ingress. Reconstruct the author's preimage, not a mixed replica state.
          const group = projectAuthoredOperation(operation, { uname: record.source.name, uid: operation.uid, dev: operation.device });
          for (const file of group.files) file.path = this.o.model.byId(file.fileId)?.path ?? this.o.model.deletedFiles().find((f) => f.id === file.fileId)?.path ?? file.path;
          await this.o.store.putChangeSet(group);
          await this.o.store.setMeta(`operation:projected:${record.id}`, group.id);
          covered.add(operation.id);
          continue;
        }
      }
      const { before, after } = await operationStates(this.o.store, record);
      const files: ChangeSetFile[] = [];
      if (record.docId.startsWith('f:')) {
        const fileId = record.docId.slice(2);
        const entry = this.o.model.byId(fileId) ?? this.o.model.deletedFiles().find((f) => f.id === fileId);
        const a = before.getText('t').toString(), b = after.getText('t').toString();
        if (a !== b) files.push({ fileId, path: entry?.path ?? `Recovered/${fileId}.tex`, op: 'edit', before: a, after: b,
          patch: dmp.patch_toText(dmp.patch_make(a, b)), ...lineStats(a, b) });
      } else if (record.docId === ROOT_DOC_ID) {
        const entries = (doc: import('yjs').Doc) => new Map([...doc.getMap<import('yjs').Map<unknown>>('files')].filter(([, m]) => !m.get('deleted')));
        const a = entries(before), b = entries(after);
        for (const [id, m] of b) {
          const prev = a.get(id), path = String(m.get('path'));
          if (!prev) files.push({ fileId: id, path, op: 'create', before: '', after: '', ...(m.get('hash') ? { hashAfter: String(m.get('hash')) } : {}) });
          else {
            if (prev.get('path') !== path) files.push({ fileId: id, path, from: String(prev.get('path')), op: 'rename' });
            if (m.get('kind') === 'binary' && m.get('hash') !== prev.get('hash')) files.push({ fileId: id, path, op: 'binary', hashBefore: String(prev.get('hash')), hashAfter: String(m.get('hash')), sizeBefore: Number(prev.get('size') ?? 0) });
          }
        }
        for (const [id, m] of a) if (!b.has(id)) files.push({ fileId: id, path: String(m.get('path')), op: 'delete', ...(m.get('hash') ? { hashBefore: String(m.get('hash')), sizeBefore: Number(m.get('size') ?? 0) } : {}) });
      }
      before.destroy(); after.destroy();
      // Empty operations (settings or hydration) are also checkpointed, so reopening does not repeat them.
      await this.o.store.putChangeSet({ id: `operation:${record.id}`, source: record.source, startedAt: record.at, endedAt: record.at, files, operationIds: [record.id] });
      await this.o.store.setMeta(`operation:projected:${record.id}`, `operation:${record.id}`);
    }
  }
}

/** A stored patch as display hunks: runs of unchanged (0), removed (-1) and added (1) text, hunk by hunk. */
export function patchHunks(patch: string): Array<Array<{ op: -1 | 0 | 1; text: string }>> {
  const patches = dmp.patch_fromText(patch) as unknown as Patch[];
  return patches.map((p) => p.diffs.map(([op, text]) => ({ op: op as -1 | 0 | 1, text })));
}
