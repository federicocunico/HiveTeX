import { TransferDeferred } from './transfer-budget.js';
import { ROOT_DOC_ID, fileDocId } from '@hivetex/protocol';
import type { BlobManager } from './blobs.js';
import type { Mesh } from './mesh.js';
import type { ProjectModel } from './model.js';
import type { Persistence } from './persistence.js';

/**
 * offline: the user works offline · alone: nobody else is online · connecting: co-authors are online but not linked
 * yet · receiving: linked, content still missing on this device · reconciling: everything is here, but the current
 * peers have not yet answered for all of it (cached content from an earlier connection is usable, not yet checked) ·
 * synced: everything is here and the current peers answered for it.
 */
export type SyncStage = 'offline' | 'alone' | 'connecting' | 'receiving' | 'reconciling' | 'synced';

export interface FileSync {
  id: string;
  path: string;
  kind: 'text' | 'binary';
  /** The complete content is on this device (a listed file or an allocated empty document is not enough). */
  have: boolean;
  /** A connected peer answered a current request for it (binary files are content-addressed: held means current). */
  reconciled: boolean;
  /** received: content here · receiving: a peer is online and the file is being fetched · waiting: no peer to ask. */
  state: 'received' | 'receiving' | 'waiting';
  size?: number;
  /** A binary whose download is deferred by the device's limits (storage budget, disk reserve). */
  deferred?: import('./transfer-budget.js').DeferReason;
}

export interface SyncSnapshot {
  stage: SyncStage;
  /** Connected co-author devices. */
  peers: number;
  /** Online co-author devices not connected yet. */
  connecting: number;
  /** The complete file list is on this device (confirmed by a peer, or authored here). */
  rootSynced: boolean;
  /** A current peer answered for the file list. */
  rootReconciled: boolean;
  /** Files (not folders) known to the project. */
  total: number;
  /** Files whose complete content is on this device. */
  received: number;
  /** Files a connected peer has answered for on the current connections. */
  reconciled: number;
  /** 0-100, or null when no honest figure exists (nobody to sync with, file list not received yet). */
  percent: number | null;
  files: FileSync[];
  /** Epoch ms of the last time the device was completely up to date with its peers, or null if never in this session. */
  lastSyncAt: number | null;
  /** Online co-authors, content missing or unchecked, and no progress on some transfer for the stall time. */
  stalled: boolean;
}

export type SyncEvent = 'complete' | 'stalled';

/**
 * How a "Sync now" ended. `complete`: everything is here and every current peer answered for it. `pending`: some
 * answers did not arrive in time (queued requests are not success). `failed`: peers answered but cannot supply
 * something, or a file nobody holds. `no-peer`: nobody is connected. Local edits are kept in every case.
 */
export interface SyncOutcome {
  status: 'complete' | 'pending' | 'failed' | 'no-peer';
  /** Documents asked for in this round. */
  requested: number;
  /** Of those, how many are complete here and answered by a current peer. */
  reconciled: number;
  /** Text files not complete on this device afterwards. */
  missingText: number;
  /** Binary files not on this device afterwards. */
  missingBinaries: number;
  /** Requests without an answer before the deadline. */
  pending: number;
  /** Requests answered without supplying the content, and blobs nobody could supply. */
  failed: number;
}

export interface SyncTrackerOptions {
  mesh: Mesh;
  model: ProjectModel;
  store: Persistence;
  blobs: BlobManager;
  /** Number of online co-author devices not connected yet. */
  connecting: () => number;
  /** The user works offline or has no network. */
  offline: () => boolean;
  now?: () => number;
  stallMs?: number;
  /** Fetch everything automatically when peers are connected (default true). */
  autoFetch?: boolean;
  throttleMs?: number;
  /** How long one attempt to fetch a document or blob waits for an answer (default 15 s). */
  fetchTimeoutMs?: number;
  /** First retry delay after a failed attempt with unchanged sources; doubles up to `retryMaxMs` (default 2 s / 60 s). */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Device-wide background transfer budgets (desktop seeds share one scheduler, D8). */
  transfers?: { scheduler: import('./transfer-budget.js').TransferScheduler; project: string; foreground: () => boolean };
}

/** One document or blob this device still needs, with its own retry and stall clocks. */
interface Item {
  key: string;
  kind: 'doc' | 'blob';
  /** The document id or blob hash: retries follow this identity, so a replaced asset is a new item. */
  ref: string;
  /** When it was first needed with the current sources. */
  since: number;
  /** The last time this very transfer made progress. */
  progressAt: number;
  /** The sources the last attempt used; a different set (new peer, new connection, new announcement) makes a retry due at once. */
  sig: string;
  attempts: number;
  nextAt: number;
  running: boolean;
  lastChunk: number;
}

/** Runs at most `n` tasks at a time. */
class Pool {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private n: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Tells the user how far a join / sync is, derived locally from what is complete on this device and what the current
 * connections answered, never from the control plane. A text file counts as received once its complete content is here
 * (created here, or confirmed by a peer, or restored as such: a listed file or an update alone is not enough), a binary
 * file once its verified blob is stored. Content cached from earlier connections is usable but only counts as up to date
 * once the current peers answered for it. Each missing document or blob has its own retry and stall clock.
 */
export class SyncTracker {
  private current: SyncSnapshot = {
    stage: 'alone',
    peers: 0,
    connecting: 0,
    rootSynced: false,
    rootReconciled: false,
    total: 0,
    received: 0,
    reconciled: 0,
    percent: null,
    files: [],
    lastSyncAt: null,
    stalled: false,
  };
  private cbs = new Set<(s: SyncSnapshot) => void>();
  private evCbs = new Set<(e: SyncEvent) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /** For the connecting stage, which has no per-transfer clocks: the last time anything about the links changed. */
  private lastProgressAt: number;
  private items = new Map<string, Item>();
  private hadMissing = false;
  private stallAnnounced = false;
  private prevStage: SyncStage = 'alone';
  private activity = false;
  private lastSyncAt: number | null = null;
  private computing = false;
  private dirty = false;
  private disposed = false;
  private offs: Array<() => void> = [];
  private docPool = new Pool(32);
  private blobPool = new Pool(2);
  /** Binaries deferred by the transfer budget, with the reason shown to the member. */
  private deferred = new Map<string, import('./transfer-budget.js').DeferReason>();
  private abort = new AbortController();

  constructor(private o: SyncTrackerOptions) {
    this.lastProgressAt = this.now();
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  get snapshot(): SyncSnapshot {
    return this.current;
  }

  onChange(cb: (s: SyncSnapshot) => void) {
    this.cbs.add(cb);
  }
  onEvent(cb: (e: SyncEvent) => void) {
    this.evCbs.add(cb);
  }

  start() {
    const { mesh, model, blobs } = this.o;
    // Live updates are progress of that one document only; they never complete anyone else's transfer.
    this.offs.push(
      mesh.onDocSynced((docId) => {
        const item = this.items.get(`doc:${docId}`);
        if (item) {
          item.progressAt = this.now();
          this.stallAnnounced = false;
        }
        if (this.prevStage === 'synced' && mesh.reconciled(docId) && model.availability(docId) === 'complete') this.activity = true;
        this.touch();
      }),
    );
    this.offs.push(
      mesh.onDocReconciled(() => {
        this.activity = true;
        this.stallAnnounced = false;
        this.touch();
      }),
    );
    this.offs.push(mesh.onPeerJoin(() => this.linkChanged()));
    this.offs.push(mesh.onPeerLeave(() => this.linkChanged()));
    blobs.onStored(() => {
      this.activity = true;
      this.touch();
    });
    // A peer announcing a blob we lack makes an earlier failed fetch worth trying again.
    blobs.onAnnounced(() => this.touch());
    this.offs.push(model.onFilesChanged(() => this.touch()));
    this.offs.push(model.onDocUpdate(() => this.touch()));
    this.offs.push(model.onAvailability(() => this.touch()));
    this.stallTimer = setInterval(() => this.touch(), 5000);
    (this.stallTimer as unknown as { unref?: () => void }).unref?.();
    this.touch();
  }

  stop() {
    this.disposed = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    for (const off of this.offs) off();
  }

  private linkChanged() {
    this.lastProgressAt = this.now();
    this.stallAnnounced = false;
    this.touch();
  }

  /** Recomputes soon (coalesces bursts: a join delivers thousands of updates). */
  touch() {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, this.o.throttleMs ?? 250);
  }

  /** Recomputes now and returns the snapshot. */
  async refresh(): Promise<SyncSnapshot> {
    if (this.computing) {
      this.dirty = true;
      return this.current;
    }
    this.computing = true;
    try {
      do {
        this.dirty = false;
        this.current = await this.compute();
        if (this.disposed) return this.current;
        for (const cb of this.cbs) cb(this.current);
        this.afterCompute(this.current);
      } while (this.dirty);
    } finally {
      this.computing = false;
    }
    return this.current;
  }

  /** Which documents and blobs are still needed, given what is complete here and what current peers answered. */
  private wanted(held: Set<string>, peers: number): Array<{ key: string; kind: Item['kind']; ref: string }> {
    const { model, mesh } = this.o;
    const out: Array<{ key: string; kind: Item['kind']; ref: string }> = [];
    const doc = (id: string) => {
      if (model.availability(id) !== 'complete' || (peers > 0 && !mesh.reconciled(id))) out.push({ key: `doc:${id}`, kind: 'doc', ref: id });
    };
    doc(ROOT_DOC_ID);
    for (const f of model.list()) {
      if (f.kind === 'text') doc(fileDocId(f.id));
      else if (f.kind === 'binary' && f.hash && !held.has(f.hash)) out.push({ key: `blob:${f.hash}`, kind: 'blob', ref: f.hash });
    }
    return out;
  }

  private async compute(): Promise<SyncSnapshot> {
    const { mesh, model, blobs } = this.o;
    const peers = mesh.peers.length;
    const connecting = this.o.connecting();
    const held = await blobs.held();
    const entries = model.list().filter((f) => f.kind !== 'dir');
    const files: FileSync[] = entries.map((f) => {
      const kind = f.kind === 'binary' ? 'binary' : 'text';
      const docId = fileDocId(f.id);
      const have = kind === 'binary' ? !f.hash || held.has(f.hash) : model.availability(docId) === 'complete';
      const reconciled = have && (kind === 'binary' || (peers > 0 && mesh.reconciled(docId)));
      const state = have ? 'received' : peers > 0 ? 'receiving' : 'waiting';
      const deferred = !have && f.hash ? this.deferred.get(f.hash) : undefined;
      return { id: f.id, path: f.path, kind, have, reconciled, state, ...(f.size !== undefined ? { size: f.size } : {}), ...(deferred ? { deferred } : {}) };
    });
    const received = files.filter((f) => f.have).length;
    const reconciledCount = files.filter((f) => f.reconciled).length;
    const total = files.length;
    const missing = total - received;
    const offline = this.o.offline();
    // With no peer ever connected the file list is only what this device has: no claim about being synced.
    const rootKnown = model.availability(ROOT_DOC_ID) === 'complete';
    const rootReconciled = peers > 0 && mesh.reconciled(ROOT_DOC_ID);
    let stage: SyncStage;
    if (offline) stage = 'offline';
    else if (peers === 0) stage = connecting > 0 ? 'connecting' : 'alone';
    else if (!rootKnown || missing > 0) stage = 'receiving';
    else if (!rootReconciled || reconciledCount < total) stage = 'reconciling';
    else stage = 'synced';
    const percent = peers > 0 && rootKnown ? (total === 0 ? 100 : Math.floor(((stage === 'reconciling' ? reconciledCount : received) / total) * 100)) : null;
    const now = this.now();
    this.trackItems(this.wanted(held, peers), now);
    if (stage !== this.prevStage) {
      this.lastProgressAt = now;
      this.stallAnnounced = false;
    }
    if (stage === 'synced' && (this.prevStage !== 'synced' || this.activity)) this.lastSyncAt = now;
    this.activity = false;
    this.prevStage = stage;
    const stallMs = this.o.stallMs ?? 60_000;
    let stalled = false;
    if (stage === 'connecting') stalled = now - this.lastProgressAt > stallMs;
    else if (stage === 'receiving' || stage === 'reconciling') {
      // Each transfer has its own clock: another file's activity cannot hide a transfer that stopped.
      for (const it of this.items.values()) if (now - Math.max(it.since, it.progressAt) > stallMs) stalled = true;
    }
    return {
      stage,
      peers,
      connecting,
      rootSynced: rootKnown,
      rootReconciled,
      total,
      received,
      reconciled: reconciledCount,
      percent,
      files,
      lastSyncAt: this.lastSyncAt,
      stalled,
    };
  }

  /** Keeps one record per needed document or blob; a transfer that completed or is no longer needed counts as progress. */
  private trackItems(want: Array<{ key: string; kind: Item['kind']; ref: string }>, now: number) {
    const keys = new Set(want.map((w) => w.key));
    for (const key of this.items.keys()) {
      if (keys.has(key)) continue;
      this.items.delete(key);
      this.stallAnnounced = false;
    }
    for (const w of want) {
      let it = this.items.get(w.key);
      if (!it) {
        it = { key: w.key, kind: w.kind, ref: w.ref, since: now, progressAt: now, sig: '', attempts: 0, nextAt: 0, running: false, lastChunk: 0 };
        this.items.set(w.key, it);
      }
      if (it.kind === 'blob') {
        const chunk = this.o.blobs.chunkProgress(it.ref);
        if (chunk !== it.lastChunk) {
          it.lastChunk = chunk;
          it.progressAt = now;
          this.stallAnnounced = false;
        }
      }
    }
  }

  private afterCompute(s: SyncSnapshot) {
    if (s.stage === 'receiving' || s.stage === 'connecting' || s.stage === 'reconciling') this.hadMissing = true;
    if (s.stage === 'synced' && this.hadMissing) {
      this.hadMissing = false;
      for (const cb of this.evCbs) cb('complete');
    }
    if (s.stalled && !this.stallAnnounced) {
      this.stallAnnounced = true;
      for (const cb of this.evCbs) cb('stalled');
    }
    if (this.o.autoFetch !== false && s.peers > 0 && !this.o.offline()) this.runDue();
  }

  /** What the transfer would use as its sources right now (a change means a retry is due even if the last one failed). */
  private sigOf(it: Item): string {
    const { mesh, blobs } = this.o;
    if (it.kind === 'doc') return mesh.sourceKey;
    const has = new Set(blobs.sourcesOf(it.ref));
    return mesh.peers
      .filter((p) => has.has(p.deviceId))
      .map((p) => `${p.deviceId}#${p.gen}`)
      .sort()
      .join(',');
  }

  /** Starts every transfer that is due: never tried, sources changed since the last try, or its backoff elapsed. */
  private runDue() {
    const now = this.now();
    for (const it of this.items.values()) {
      if (it.running) continue;
      if (it.kind === 'doc' && this.o.mesh.reconciling(it.ref)) continue; // a request is in flight; wait for its answer
      const sig = this.sigOf(it);
      // A blob nobody announced cannot be fetched: wait for an announcement instead of waiting out a timeout.
      if (it.kind === 'blob' && sig === '') continue;
      const changed = sig !== it.sig;
      if (!changed && now < it.nextAt) continue;
      if (changed) {
        it.attempts = 0;
        it.since = now;
        it.progressAt = now;
        this.stallAnnounced = false;
      }
      void this.attempt(it, sig);
    }
  }

  private async attempt(it: Item, sig: string, timeoutMs = this.o.fetchTimeoutMs ??
    (it.kind === 'blob' && this.o.mesh.peers.some((p) => p.conn.transportKind === 'relay') ? 120_000 : 15_000)): Promise<{ ok: boolean; failed: boolean; pending: boolean }> {
    it.running = true;
    it.sig = sig;
    let ok = false;
    let failed = false;
    let pending = false;
    try {
      if (it.kind === 'doc') {
        const r = await this.docPool.run(() => this.o.mesh.reconcile(it.ref, { timeoutMs, signal: this.abort.signal }));
        ok = this.o.model.availability(it.ref) === 'complete' && this.o.mesh.reconciled(it.ref);
        failed = !ok && r.outcome === 'unavailable';
        pending = !ok && !failed;
      } else {
        try {
          const t = this.o.transfers;
          const size = this.o.model.list().find((f) => f.kind === 'binary' && f.hash === it.ref)?.size ?? 0;
          const release = t ? await t.scheduler.acquire(t.project, size, t.foreground()) : null;
          try {
            await this.blobPool.run(() => this.o.blobs.fetch(it.ref, timeoutMs));
          } finally {
            release?.();
          }
          this.deferred.delete(it.ref);
          ok = true;
        } catch (e) {
          if (e instanceof TransferDeferred) {
            this.deferred.set(it.ref, e.reason);
            pending = true;
          } else failed = true;
        }
      }
    } finally {
      it.running = false;
      if (!ok) {
        it.attempts++;
        const base = this.o.retryBaseMs ?? 2000;
        it.nextAt = this.now() + Math.min(this.o.retryMaxMs ?? 60_000, base * 2 ** Math.min(it.attempts - 1, 16));
      }
      if (!this.disposed) this.touch();
    }
    return { ok, failed, pending };
  }

  /**
   * Requests every missing or unchecked document and blob now (bounded concurrency) and waits for the answers. Safe to
   * call repeatedly; a transfer already running is not duplicated.
   */
  async fetchAll(): Promise<{ missingText: number; missingBinaries: number; failed: number }> {
    await this.refresh();
    const items = [...this.items.values()].filter((it) => !it.running);
    let failed = 0;
    await Promise.all(
      items.map(async (it) => {
        const r = await this.attempt(it, this.sigOf(it));
        if (!r.ok) failed++;
      }),
    );
    await this.refresh();
    const docs = items.filter((i) => i.kind === 'doc' && i.ref !== ROOT_DOC_ID).length;
    return { missingText: docs, missingBinaries: items.filter((i) => i.kind === 'blob').length, failed };
  }

  /**
   * "Sync now": asks every connected peer again for the state of every document, fetches the files not yet here and
   * waits for the answers. Reports `complete` only once the current peers answered for everything and nothing is
   * missing; queued requests, silence and timeouts are `pending`, unsupplied content is `failed`.
   */
  async syncNow(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SyncOutcome> {
    const { mesh, model, blobs } = this.o;
    const timeoutMs = opts.timeoutMs ?? this.o.fetchTimeoutMs ?? 15_000;
    const empty = { requested: 0, reconciled: 0, missingText: 0, missingBinaries: 0, pending: 0, failed: 0 };
    if (mesh.peers.length === 0) return { status: 'no-peer', ...empty, missingText: model.missingText().length };
    const round = await mesh.reconcileProject({ scope: 'all', timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
    const held = await blobs.held();
    const hashes = [...new Set(model.list().filter((f) => f.kind === 'binary' && f.hash && !held.has(f.hash)).map((f) => f.hash as string))];
    const blobRes = hashes.length ? await blobs.fetchMissing(hashes, 2, timeoutMs) : { failed: 0 };
    const snap = await this.refresh();
    // Judged by this round's own answers: an answer from an earlier request on the same connection proves nothing now.
    // Answered by every reachable peer without confirming is fine when this device already holds the complete content.
    const unresolved = round.docs.filter((d) => !(d.outcome === 'confirmed' || (d.outcome === 'unavailable' && model.availability(d.docId) === 'complete')));
    const failed = unresolved.filter((d) => d.outcome === 'unavailable').length + blobRes.failed;
    const pending = unresolved.length - unresolved.filter((d) => d.outcome === 'unavailable').length;
    const missingBinaries = snap.files.filter((f) => f.kind === 'binary' && !f.have).length;
    const out = {
      requested: round.docs.length,
      reconciled: round.docs.length - unresolved.length,
      missingText: model.missingText().length,
      missingBinaries,
      pending,
      failed,
    };
    if (snap.stage === 'synced' && unresolved.length === 0 && blobRes.failed === 0) {
      this.lastSyncAt = this.now();
      this.current = { ...this.current, lastSyncAt: this.lastSyncAt };
      for (const cb of this.cbs) cb(this.current);
      return { status: 'complete', ...out };
    }
    return { status: failed > 0 ? 'failed' : 'pending', ...out };
  }
}
