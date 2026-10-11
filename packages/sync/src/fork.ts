import { ROOT_DOC_ID } from '@hivetex/protocol';
import * as Y from 'yjs';
import { PeerConnection } from './connection.js';
import {
  type ConflictHunk,
  type FileConflict,
  type FileList,
  type HunkDecision,
  type MergeRegion,
  applyDecisions,
  conflictCount,
  mergeFileLists,
  mergeText,
} from './merge.js';
import type { Mesh } from './mesh.js';
import { type FileKind, type ProjectModel, applyTextDiff } from './model.js';
import type { StoreOp } from './persistence.js';

/**
 * Git-style merge of work done while no peer was linked (design D1 of offline-mode-git-merge).
 *
 * While nobody is linked, the first local change to a document keeps a copy of that document as it was just before
 * (its *base*: the last state shared with others). When a peer links, before anything is exchanged, each changed
 * document's current state (*mine*) is saved and the document is replaced by its base, so the peer never receives the
 * offline edits as such. After the documents sync (*theirs*), base / mine / theirs are merged per file (merge.ts):
 * one-sided and disjoint changes are applied as normal edits, overlapping ones become conflicts the member resolves.
 * Everything is persisted (project meta), so a restart or a dropped link resumes where it was.
 */

/** Origin of the edits the merge applies: shared normally, never the start of a new fork. */
export const MERGE_ORIGIN = Symbol('offline-merge');

/**
 * Recovery journal (version 2) of one offline merge. Stages only move forward:
 * - forked: offline edits exist; each document's base is saved; documents still hold the offline state.
 * - prepared: mine (the offline state) and the journal are saved and the documents were replaced by their bases, in one
 *   atomic storage transition. Nothing is shared yet that was not shared before.
 * - reconciling: the documents were exchanged with a peer and the merge is being applied.
 * - committed: merged results and conflicts are durable; only the removal of the recovery data is left.
 * A restart resumes from the stage on disk; the operation id names the merge across restarts.
 */
export type JournalStage = 'forked' | 'prepared' | 'reconciling' | 'committed';
export interface ForkJournal {
  v: 2;
  opId: string;
  stage: JournalStage;
  docs: string[];
}

/** The version-1 record (stage 'forked' | 'merging'), still written beside the journal and read when no journal exists. */
interface LegacyForkRecord {
  v: 1;
  stage: 'forked' | 'merging';
  docs: string[];
}

export interface TextConflict {
  id: string;
  kind: 'text';
  fileId: string;
  path: string;
  /** The others' text when the conflict was found: resolving re-merges against their latest text. */
  theirsAtMerge: string;
  regions: MergeRegion[];
}

export interface FileLevelConflict {
  id: string;
  kind: 'file';
  conflict: FileConflict;
  /** This device's file (to restore or add it): path, kind, binary hash, and text content for text files. */
  mine?: { path: string; kind: FileKind; hash?: string | null; size?: number; text?: string };
}

export type MergeConflict = TextConflict | FileLevelConflict;

export interface MergeReport {
  /** Files changed on both sides in different places: merged automatically (shown as a warning). */
  merged: string[];
  /** Files only this device changed: taken as they are. */
  taken: string[];
  conflicts: number;
  /** The member could no longer edit: offline changes were dropped. */
  discarded?: boolean;
}

export type FileChoice = 'mine' | 'theirs' | 'both' | 'keep' | 'delete';

export interface OfflineForkOptions {
  model: ProjectModel;
  /** True while at least one peer is linked. */
  isLinked: () => boolean;
  /** False when changes never need merging (a project that exists only on this device). Default: true. */
  enabled?: () => boolean;
  /** False for viewers (their offline changes are dropped, as read-only enforcement does). */
  canEdit: () => boolean;
  /** Resolves once the document was synced with a peer (or after a timeout: then the local state is taken as theirs). */
  waitSynced: (docId: string) => Promise<void>;
  onReport?: (r: MergeReport) => void;
  onChange?: () => void;
  /** This device's id, and how to tell a linked peer whether we hold unshared work (see beforeSync). */
  selfDevice?: () => string;
  announce?: (peerDevice: string, forked: boolean) => Promise<void>;
  /** How long to wait for a peer's status (older apps never send one: then it counts as "no unshared work"). */
  statusTimeoutMs?: number;
  /** A merge step failed (storage, preparation): the journal is kept and the merge is retried at the next link. */
  onError?: (e: unknown) => void;
}

/** Version-1 record key: kept in step with the journal, so an interrupted merge also survives a downgrade to a build that reads it. */
export const FORK_RECORD_KEY = 'fork';
export const FORK_JOURNAL_KEY = 'fork:journal';
const REC = FORK_RECORD_KEY;
const JOURNAL = FORK_JOURNAL_KEY;
const CONFLICTS = 'fork:conflicts';
const baseKey = (d: string) => `fork:base:${d}`;
const mineKey = (d: string) => `fork:mine:${d}`;

function docFromState(state: Uint8Array | undefined) {
  const d = new Y.Doc();
  if (state) Y.applyUpdate(d, state);
  return d;
}

function filesOf(root: Y.Doc): FileList {
  const out: FileList = {};
  (root.getMap('files') as Y.Map<Y.Map<unknown>>).forEach((m, id) => {
    const kind = m.get('kind') as FileKind;
    out[id] = { path: String(m.get('path')), kind, hash: kind === 'binary' ? String(m.get('hash') ?? '') : null };
  });
  return out;
}

/** The journal and its version-1 mirror, to be written in one transition with the data they describe. */
function journalOps(j: ForkJournal): StoreOp[] {
  const legacy: LegacyForkRecord = { v: 1, stage: j.stage === 'forked' ? 'forked' : 'merging', docs: [...j.docs] };
  return [
    { op: 'meta', key: JOURNAL, value: { ...j, docs: [...j.docs] } },
    { op: 'meta', key: REC, value: legacy },
  ];
}

const isRemote = (origin: unknown) => origin instanceof PeerConnection;
const uid = () => Math.random().toString(36).slice(2, 10);

export class OfflineFork {
  private rec: ForkJournal | null = null;
  private bases = new Set<string>();
  private baseStates = new Map<string, Uint8Array>();
  private mineStates = new Map<string, Uint8Array>();
  /** False while the swapped documents' recovery data is not known to be stored (a failed preparation write). */
  private durable = true;
  /** Recovery records this build cannot interpret (a newer version): never modified or deleted. */
  private foreign = false;
  /** Serializes recovery-journal writes; never rejects. */
  private io: Promise<void> = Promise.resolve();
  private conflictList: MergeConflict[] = [];
  private theirsChanged = new Set<string>();
  private running: Promise<void> | null = null;
  private unsubs: Array<() => void> = [];
  private peerStatus = new Map<string, boolean>();
  private statusWaiters = new Map<string, (forked: boolean) => void>();

  constructor(private o: OfflineForkOptions) {}

  /** Restores a fork or pending conflicts from storage, then starts watching local changes. */
  async start() {
    const store = this.o.model.store;
    await this.restore();
    this.conflictList = ((await store.getMeta(CONFLICTS)) as MergeConflict[] | undefined) ?? [];
    this.unsubs.push(this.o.model.onBeforeChange((docId, doc, origin) => this.beforeChange(docId, doc, origin)));
    this.unsubs.push(
      this.o.model.onDocUpdate((docId, _u, origin) => {
        if (isRemote(origin)) this.theirsChanged.add(docId);
      }),
    );
  }

  /** Reads the journal (or migrates a version-1 record to one). Records of an unknown version are left untouched. */
  private async restore() {
    const store = this.o.model.store;
    const journal = (await store.getMeta(JOURNAL)) as { v?: unknown } | undefined;
    const legacy = (await store.getMeta(REC)) as Partial<LegacyForkRecord> | undefined;
    let rec: ForkJournal | null = null;
    if (journal) {
      const j = journal as Partial<ForkJournal>;
      const stages: unknown[] = ['forked', 'prepared', 'reconciling', 'committed'];
      if (j.v === 2 && stages.includes(j.stage) && Array.isArray(j.docs) && typeof j.opId === 'string') rec = j as ForkJournal;
      else this.foreign = true;
    } else if (legacy) {
      if (legacy.v === 1 && (legacy.stage === 'forked' || legacy.stage === 'merging') && Array.isArray(legacy.docs)) {
        // A version-1 merging record already has its mine/base copies saved: it resumes as 'prepared'.
        rec = { v: 2, opId: `m${Date.now().toString(36)}${uid()}`, stage: legacy.stage === 'merging' ? 'prepared' : 'forked', docs: [...legacy.docs] };
        // Additive: the old record and the base/mine copies stay as they are; a failed write loses nothing and is repeated at the next transition.
        await store.transact(journalOps(rec)).catch((e) => this.o.onError?.(e));
      } else this.foreign = true;
    }
    this.rec = rec;
    this.bases = new Set(rec?.docs ?? []);
    for (const d of rec?.docs ?? []) {
      const b = (await store.getMeta(baseKey(d))) as Uint8Array | undefined;
      if (b) this.baseStates.set(d, b);
    }
    if (rec?.stage === 'committed') await this.clear(rec.docs).catch((e) => this.o.onError?.(e)); // results are durable: only the cleanup was interrupted
  }

  /** True when a recovery record of a newer version was found: it is kept untouched and no new offline merge starts. */
  get recoveryBlocked() {
    return this.foreign;
  }

  /** The current recovery journal (stage and operation id), if an offline merge is pending. */
  get journal(): Readonly<ForkJournal> | null {
    return this.rec;
  }

  stop() {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  /** Whether this device holds offline changes not shared yet. */
  get active() {
    return !!this.rec;
  }

  get conflicts(): readonly MergeConflict[] {
    return this.conflictList;
  }

  private beforeChange(docId: string, doc: Y.Doc, origin: unknown) {
    // Runs inside Yjs beforeTransaction: it must never throw (that would abort a transaction half-way).
    if (isRemote(origin) || origin === MERGE_ORIGIN || this.o.enabled?.() === false) return;
    let linked = true;
    try {
      linked = this.o.isLinked();
    } catch {
      linked = true;
    }
    if (linked) return;
    if (this.foreign) return; // a recovery record this build cannot read must not be overwritten
    if (this.rec && this.rec.stage !== 'forked') return; // swapped already: the merge decides
    if (this.bases.has(docId)) return;
    if (!this.rec) this.rec = { v: 2, opId: `m${Date.now().toString(36)}${uid()}`, stage: 'forked', docs: [] };
    // The file table as last shared is the base of the file-level merge: keep it as soon as anything diverges.
    if (docId !== ROOT_DOC_ID && !this.bases.has(ROOT_DOC_ID)) {
      this.bases.add(ROOT_DOC_ID);
      this.rec.docs.push(ROOT_DOC_ID);
      this.baseStates.set(ROOT_DOC_ID, Y.encodeStateAsUpdate(this.o.model.root));
    }
    this.bases.add(docId);
    this.rec.docs.push(docId);
    this.baseStates.set(docId, Y.encodeStateAsUpdate(doc));
    void this.persistForked().catch((e) => this.o.onError?.(e));
    this.o.onChange?.();
  }

  /** Writes every base and the journal as one transition (repeated in full, so a failed earlier write is made up for). */
  private persistForked(): Promise<void> {
    const rec = this.rec;
    if (!rec) return Promise.resolve();
    const ops: StoreOp[] = [...this.baseOps(rec.docs), ...journalOps(rec)];
    const run = this.io.then(() => this.o.model.store.transact(ops));
    this.io = run.catch(() => {});
    return run;
  }

  private preparedOps(j: ForkJournal): StoreOp[] {
    const ops: StoreOp[] = [];
    for (const [docId, value] of this.mineStates) ops.push({ op: 'meta', key: mineKey(docId), value });
    return [...ops, ...this.baseOps(j.docs), ...journalOps(j)];
  }

  private baseOps(docs: string[]): StoreOp[] {
    const ops: StoreOp[] = [];
    for (const d of docs) {
      const value = this.baseStates.get(d);
      if (value) ops.push({ op: 'meta', key: baseKey(d), value });
    }
    return ops;
  }

  private async setStage(stage: JournalStage, extra: StoreOp[] = []) {
    if (!this.rec) return;
    const next: ForkJournal = { ...this.rec, stage, docs: [...this.rec.docs] };
    const ops = [...extra, ...journalOps(next)];
    const run = this.io.then(() => this.o.model.store.transact(ops));
    this.io = run.catch(() => {});
    await run;
    this.rec = next;
  }

  /** A linked peer said whether it holds unshared work (wire this to the mesh's 'fork' app messages). */
  receiveStatus(peerDevice: string, forked: boolean) {
    this.peerStatus.set(peerDevice, forked);
    this.statusWaiters.get(peerDevice)?.(forked);
  }

  /** A peer left: its next link announces its status again. */
  forgetPeer(peerDevice: string) {
    this.peerStatus.delete(peerDevice);
  }

  private peerForked(peerDevice: string): Promise<boolean> {
    const known = this.peerStatus.get(peerDevice);
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => {
      const t = setTimeout(() => done(false), this.o.statusTimeoutMs ?? 3000);
      const done = (v: boolean) => {
        clearTimeout(t);
        this.statusWaiters.delete(peerDevice);
        resolve(v);
      };
      this.statusWaiters.set(peerDevice, done);
    });
  }

  /**
   * Before anything is exchanged with a newly linked peer: keep this device's version of every changed document and
   * put the last shared one in its place. Then the merge runs once the documents have synced.
   *
   * When both devices worked without each other, only one of them may merge (otherwise each would apply its own
   * work against the old state and the two results would be interleaved): the one with the lower device id shares its
   * work as it is, the other merges against it, so any conflict is decided on that one device.
   */
  async beforeSync(peer?: { deviceId: string }) {
    if (peer && this.o.announce) await this.o.announce(peer.deviceId, !!this.rec && this.rec.stage === 'forked').catch(() => {});
    if (!this.rec || this.foreign) return;
    const { model } = this.o;
    if (this.rec.stage === 'forked' && peer && this.o.selfDevice) {
      const theyForked = await this.peerForked(peer.deviceId);
      if (theyForked && this.o.selfDevice() < peer.deviceId) {
        await this.clear(this.rec.docs);
        return;
      }
    }
    if (this.rec.stage === 'forked') {
      // Load everything first, then capture this device's version and swap in one synchronous pass: an edit typed
      // meanwhile lands either in the captured version or in the swapped-in document, never in between.
      const docs = [...this.rec.docs];
      for (const docId of docs) await model.getDoc(docId);
      const empty = Y.encodeStateAsUpdate(new Y.Doc());
      const swap: Array<{ docId: string; state: Uint8Array }> = [];
      this.mineStates.clear();
      for (const docId of docs) {
        const doc = docId === ROOT_DOC_ID ? model.root : (model.getLoadedDoc(docId) as Y.Doc);
        swap.push({ docId, state: this.baseStates.get(docId) ?? empty });
        this.mineStates.set(docId, Y.encodeStateAsUpdate(doc));
      }
      const prepared: ForkJournal = { ...this.rec, stage: 'prepared', docs };
      // One atomic transition: mine, bases, the journal and the replacement documents are stored together, so a crash
      // leaves either the offline state untouched (stage 'forked') or everything needed to resume (stage 'prepared').
      // The in-memory swap is synchronous with the capture above: an edit typed meanwhile lands in one or the other.
      const committed = model.replaceDocs(swap, this.preparedOps(prepared));
      this.rec = prepared;
      this.durable = false;
      void committed.then(() => {
        this.durable = true;
      }, () => {});
      await committed;
    }
    // A previous attempt swapped the documents but could not store its recovery data yet: store it now or do not merge.
    if (this.rec.stage === 'prepared' && !this.durable) {
      const run = this.io.then(() => model.store.transact(this.preparedOps(this.rec as ForkJournal)));
      this.io = run.catch(() => {});
      await run;
      this.durable = true;
    }
    this.theirsChanged.clear();
    this.running ??= this.merge()
      .catch((e) => this.o.onError?.(e))
      .finally(() => {
        this.running = null;
      });
  }

  private async merge() {
    const rec = this.rec;
    if (!rec || (rec.stage !== 'prepared' && rec.stage !== 'reconciling')) return;
    const { model } = this.o;
    const store = model.store;
    await this.o.waitSynced(ROOT_DOC_ID);
    await this.setStage('reconciling');
    if (!this.o.canEdit()) {
      await this.clear(rec.docs);
      this.o.onReport?.({ merged: [], taken: [], conflicts: 0, discarded: true });
      return;
    }
    const state = async (key: string) => (await store.getMeta(key)) as Uint8Array | undefined;
    const baseRoot = docFromState(await state(baseKey(ROOT_DOC_ID)));
    const mineRootState = await state(mineKey(ROOT_DOC_ID));
    const mineRoot = mineRootState ? docFromState(mineRootState) : baseRoot;
    const baseFiles = filesOf(baseRoot);
    const mineFiles = filesOf(mineRoot);
    const theirsFiles = filesOf(model.root);
    // A text file deleted here but kept there: whether they edited it decides delete vs conflict, so wait for its content.
    for (const [fid, f] of Object.entries(baseFiles)) {
      if (f.kind === 'text' && !mineFiles[fid] && theirsFiles[fid]) await this.o.waitSynced(`f:${fid}`);
    }
    const forkedText = new Set(rec.docs.filter((d) => d.startsWith('f:')).map((d) => d.slice(2)));
    const theirsText = new Set([...this.theirsChanged].filter((d) => d.startsWith('f:')).map((d) => d.slice(2)));
    const fm = mergeFileLists(baseFiles, mineFiles, theirsFiles, forkedText, theirsText);
    const mineMeta = (id: string) => mineRoot.getMap('files').get(id) as Y.Map<unknown> | undefined;
    const report: MergeReport = { merged: [], taken: [], conflicts: 0 };
    const mineText = async (fileId: string) => docFromState(await state(mineKey(`f:${fileId}`))).getText('t').toString();
    const baseText = async (fileId: string) => docFromState(await state(baseKey(`f:${fileId}`))).getText('t').toString();

    // 1. the file table
    for (const { id, state: f } of fm.add) {
      const m = mineMeta(id);
      model.putEntry(id, { path: f.path, kind: f.kind, hash: f.hash, ...(m?.get('size') !== undefined ? { size: Number(m.get('size')) } : {}) }, MERGE_ORIGIN);
    }
    for (const id of fm.remove) model.delete(id, MERGE_ORIGIN);
    for (const { id, path } of fm.rename) model.rename(id, path, MERGE_ORIGIN);
    for (const { id, hash } of fm.setHash) model.setBinary(id, hash, Number(mineMeta(id)?.get('size') ?? 0), MERGE_ORIGIN);
    for (const c of fm.conflicts) {
      const fid = c.type === 'add-add' ? c.mineId : c.id;
      const m = mineMeta(fid);
      const kind = (m?.get('kind') as FileKind | undefined) ?? 'text';
      const mine = m
        ? {
            path: String(m.get('path')),
            kind,
            hash: (m.get('hash') as string | undefined) ?? null,
            ...(m.get('size') !== undefined ? { size: Number(m.get('size')) } : {}),
            ...(kind === 'text' ? { text: await mineText(fid) } : {}),
          }
        : undefined;
      this.conflictList.push({ id: uid(), kind: 'file', conflict: c, ...(mine ? { mine } : {}) });
    }

    // 2. text contents
    for (const fileId of fm.textToMerge) {
      if (!model.byId(fileId)) continue;
      const docId = `f:${fileId}`;
      const isNew = !baseFiles[fileId];
      if (!isNew) await this.o.waitSynced(docId);
      const base = isNew ? '' : await baseText(fileId);
      const mine = await mineText(fileId);
      const ytext = await model.openText(fileId);
      // No await from here until the result is applied: edits arriving meanwhile must not be overwritten.
      const theirs = ytext.toString();
      const path = model.byId(fileId)?.path ?? fileId;
      const r = mergeText(base, mine, theirs);
      if (r.kind === 'conflict') {
        this.conflictList.push({ id: uid(), kind: 'text', fileId, path, theirsAtMerge: theirs, regions: r.regions });
        continue;
      }
      if (r.kind === 'theirs') continue;
      applyTextDiff(ytext, r.text, MERGE_ORIGIN);
      (r.kind === 'clean' ? report.merged : report.taken).push(path);
    }

    report.conflicts = this.conflictList.length;
    // The merged documents must be durable before the recovery data may go; the conflicts and the 'committed' stage
    // are written together, so a restart either redoes the merge or knows it is complete.
    await model.flush();
    await this.setStage('committed', [{ op: 'meta', key: CONFLICTS, value: this.conflictList.length ? this.conflictList : undefined }]);
    await this.clear(rec.docs);
    this.o.onReport?.(report);
  }

  /** Removes the recovery data (bases, mine copies, journal and its version-1 mirror) in one transition. */
  private async clear(docs: string[]) {
    const ops: StoreOp[] = [];
    for (const d of docs) ops.push({ op: 'meta', key: baseKey(d), value: undefined }, { op: 'meta', key: mineKey(d), value: undefined });
    ops.push({ op: 'meta', key: JOURNAL, value: undefined }, { op: 'meta', key: REC, value: undefined });
    const run = this.io.then(() => this.o.model.store.transact(ops));
    this.io = run.catch(() => {});
    await run;
    this.rec = null;
    this.bases.clear();
    this.baseStates.clear();
    this.mineStates.clear();
    this.durable = true;
    this.o.onChange?.();
  }

  /**
   * Merges another copy of the project's files into this project with no common history (a local project linked to
   * a shared one, local-mode spec): a file only in the other copy is added; a file at the same path with different
   * content is a conflict (two-way: the whole file), resolved like offline conflicts. Binary contents must already be
   * in this project's store.
   */
  async mergeIn(files: Array<{ path: string; kind: FileKind; text?: string; hash?: string; size?: number }>): Promise<MergeReport> {
    const { model } = this.o;
    const report: MergeReport = { merged: [], taken: [], conflicts: 0 };
    for (const f of files) {
      const existing = model.find(f.path);
      if (f.kind === 'dir') {
        if (!existing) model.createDir(f.path);
        continue;
      }
      if (!existing) {
        if (f.kind === 'text') await model.createTextNow(f.path, f.text ?? '', MERGE_ORIGIN);
        else if (f.hash) model.createBinary(f.path, f.hash, f.size ?? 0, MERGE_ORIGIN);
        report.taken.push(f.path);
        continue;
      }
      if (f.kind === 'text' && existing.kind === 'text') {
        const theirs = (await model.openText(existing.id)).toString();
        const mine = f.text ?? '';
        if (theirs === mine) continue;
        const r = mergeText('', mine, theirs);
        if (r.kind === 'conflict') this.conflictList.push({ id: uid(), kind: 'text', fileId: existing.id, path: existing.path, theirsAtMerge: theirs, regions: r.regions });
        continue;
      }
      if (f.kind === 'binary' && existing.kind === 'binary') {
        if (f.hash && f.hash !== existing.hash) {
          this.conflictList.push({
            id: uid(),
            kind: 'file',
            conflict: { type: 'binary', id: existing.id, path: existing.path, mine: f.hash, theirs: existing.hash ?? '' },
            mine: { path: f.path, kind: 'binary', hash: f.hash, ...(f.size !== undefined ? { size: f.size } : {}) },
          });
        }
        continue;
      }
      // a file and a folder (or text and binary) at the same path: keep both, this copy under another name
      const alt = withSuffix(f.path, ' (mine)');
      if (f.kind === 'text') await model.createTextNow(alt, f.text ?? '', MERGE_ORIGIN);
      else if (f.hash) model.createBinary(alt, f.hash, f.size ?? 0, MERGE_ORIGIN);
      report.taken.push(alt);
    }
    report.conflicts = this.conflictList.length;
    await this.persistConflicts();
    this.o.onChange?.();
    this.o.onReport?.(report);
    return report;
  }

  // ---- resolving ----

  /**
   * Decides a text conflict. With every hunk decided, the result is merged once more against the others' latest text
   * (so what they wrote meanwhile is kept) and applied; if that collides again, the file stays in conflict.
   */
  async resolveText(conflictId: string, decisions: Array<HunkDecision | undefined>): Promise<'resolved' | 'conflict-again'> {
    const c = this.conflictList.find((x) => x.id === conflictId);
    if (!c || c.kind !== 'text') throw new Error('no such conflict');
    const resolved = applyDecisions(c.regions, decisions);
    const ytext = await this.o.model.openText(c.fileId);
    const now = ytext.toString();
    const again = mergeText(c.theirsAtMerge, resolved, now);
    if (again.kind === 'conflict') {
      c.theirsAtMerge = now;
      c.regions = again.regions;
      await this.persistConflicts();
      return 'conflict-again';
    }
    applyTextDiff(ytext, again.text, MERGE_ORIGIN);
    await this.drop(conflictId);
    return 'resolved';
  }

  /** Decides a file-level conflict (D3): keep or delete, a path, or a binary version. */
  async resolveFile(conflictId: string, choice: FileChoice) {
    const c = this.conflictList.find((x) => x.id === conflictId);
    if (!c || c.kind !== 'file') throw new Error('no such conflict');
    const { model } = this.o;
    const k = c.conflict;
    const restoreMine = async (id: string, path?: string) => {
      if (!c.mine) return;
      model.putEntry(id, { ...c.mine, path: path ?? c.mine.path }, MERGE_ORIGIN);
      if (c.mine.kind === 'text' && c.mine.text) applyTextDiff(await model.openText(id), c.mine.text, MERGE_ORIGIN);
    };
    if (k.type === 'delete-modify') {
      if (k.deletedBy === 'mine' && choice === 'delete') model.delete(k.id, MERGE_ORIGIN);
      if (k.deletedBy === 'theirs' && choice === 'keep') await restoreMine(k.id);
    } else if (k.type === 'rename-rename') {
      if (choice === 'mine') model.rename(k.id, k.mine, MERGE_ORIGIN);
    } else if (k.type === 'binary') {
      if (choice === 'mine') model.setBinary(k.id, k.mine, c.mine?.size ?? 0, MERGE_ORIGIN);
    } else if (k.type === 'add-add') {
      if (choice === 'both') await restoreMine(k.mineId, withSuffix(k.path, ' (mine)'));
      else if (choice === 'mine' && c.mine?.text !== undefined) applyTextDiff(await model.openText(k.theirsId), c.mine.text, MERGE_ORIGIN);
    }
    await this.drop(conflictId);
  }

  private async drop(conflictId: string) {
    this.conflictList = this.conflictList.filter((x) => x.id !== conflictId);
    await this.persistConflicts();
    this.o.onChange?.();
  }

  private async persistConflicts() {
    await this.o.model.store.setMeta(CONFLICTS, this.conflictList.length ? this.conflictList : undefined);
  }
}

/** Connects an OfflineFork to a mesh: the fork status handshake and waiting for synced documents. */
export function forkMeshOptions(mesh: () => Mesh, selfDevice: () => string, ms = 8000): Pick<OfflineForkOptions, 'isLinked' | 'waitSynced' | 'selfDevice' | 'announce'> {
  return {
    isLinked: () => (mesh()?.peers.length ?? 0) > 0,
    waitSynced: (docId) => meshWaitSynced(mesh(), ms)(docId),
    selfDevice,
    announce: (peerDevice, forked) => mesh().sendApp(peerDevice, 'fork', { forked }),
  };
}

/** Feeds a mesh's 'fork' app messages to the fork. */
export function listenForkStatus(mesh: Mesh, fork: OfflineFork) {
  mesh.onApp('fork', (from, body) => fork.receiveStatus(from.deviceId, !!(body as { forked?: unknown })?.forked));
  mesh.onPeerLeave((p) => fork.forgetPeer(p.deviceId));
}

/** OfflineForkOptions.waitSynced over a mesh: resolves when a peer's state for the document arrived, or after `ms`. */
export function meshWaitSynced(mesh: Mesh, ms = 8000) {
  return (docId: string) =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        resolve();
      };
      const off = mesh.onDocSynced((id) => {
        if (id === docId) finish();
      });
      const timer = setTimeout(finish, ms);
      void mesh.openDoc(docId).catch(finish);
    });
}

/** `chapter (mine).tex` from `chapter.tex`. */
function withSuffix(path: string, suffix: string) {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 0 && dot > 0 ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`;
}

export type { ConflictHunk, HunkDecision, MergeRegion };
export { conflictCount };
