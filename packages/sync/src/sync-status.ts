import { ROOT_DOC_ID, fileDocId } from '@hivetex/protocol';
import type { BlobManager } from './blobs.js';
import type { Mesh } from './mesh.js';
import type { ProjectModel } from './model.js';
import type { Persistence } from './persistence.js';

/**
 * offline: the user works offline · alone: nobody else is online · connecting: co-authors are online but not linked
 * yet · receiving: linked, files still missing · synced: everything known is on this device.
 */
export type SyncStage = 'offline' | 'alone' | 'connecting' | 'receiving' | 'synced';

export interface FileSync {
  id: string;
  path: string;
  kind: 'text' | 'binary';
  /** The content is on this device. */
  have: boolean;
  /** received: content here · receiving: a peer is online and the file is being fetched · waiting: no peer to ask. */
  state: 'received' | 'receiving' | 'waiting';
  size?: number;
}

export interface SyncSnapshot {
  stage: SyncStage;
  /** Connected co-author devices. */
  peers: number;
  /** Online co-author devices not connected yet. */
  connecting: number;
  /** The file list itself has been received from a peer (or we are the only holder). */
  rootSynced: boolean;
  /** Files (not folders) known to the project. */
  total: number;
  received: number;
  /** 0-100, or null when no honest figure exists (nobody to sync with, file list not received yet). */
  percent: number | null;
  files: FileSync[];
  /** Epoch ms of the last time the device was completely up to date, or null if never in this session. */
  lastSyncAt: number | null;
  /** Online co-authors, files missing, and no progress for the stall time. */
  stalled: boolean;
}

export type SyncEvent = 'complete' | 'stalled';

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
}

/**
 * Tells the user how far a join / sync is: derived locally from what the mesh has exchanged and what is stored on this
 * device, never from the control plane. A text file counts as received once its document is stored or a peer sent its
 * state; a binary file once its verified blob is stored.
 */
export class SyncTracker {
  private received = new Set<string>();
  private current: SyncSnapshot = {
    stage: 'alone',
    peers: 0,
    connecting: 0,
    rootSynced: false,
    total: 0,
    received: 0,
    percent: null,
    files: [],
    lastSyncAt: null,
    stalled: false,
  };
  private cbs = new Set<(s: SyncSnapshot) => void>();
  private evCbs = new Set<(e: SyncEvent) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastProgressAt: number;
  private lastReceived = 0;
  private hadMissing = false;
  private stallAnnounced = false;
  private fetching = false;
  private prevStage: SyncStage = 'alone';
  private activity = false;
  private lastFetchKey = '';
  private again = false;
  private lastSyncAt: number | null = null;
  private computing = false;
  private dirty = false;
  private disposed = false;
  private offs: Array<() => void> = [];

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
    mesh.onDocSynced((docId) => {
      this.received.add(docId);
      this.activity = true;
      this.lastProgressAt = this.now();
      this.stallAnnounced = false;
      this.touch();
    });
    mesh.onPeerJoin(() => this.touch());
    mesh.onPeerLeave(() => this.touch());
    blobs.onStored(() => this.touch());
    this.offs.push(model.onFilesChanged(() => this.touch()));
    this.offs.push(model.onDocUpdate(() => this.touch()));
    this.stallTimer = setInterval(() => this.touch(), 5000);
    (this.stallTimer as unknown as { unref?: () => void }).unref?.();
    this.touch();
  }

  stop() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    for (const off of this.offs) off();
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

  private async compute(): Promise<SyncSnapshot> {
    const { mesh, model, store, blobs } = this.o;
    const peers = mesh.peers.length;
    const connecting = this.o.connecting();
    const [docs, held] = await Promise.all([store.listDocs(), blobs.held()]);
    const stored = new Set(docs);
    const entries = model.list().filter((f) => f.kind !== 'dir');
    const files: FileSync[] = entries.map((f) => {
      const kind = f.kind === 'binary' ? 'binary' : 'text';
      const docId = fileDocId(f.id);
      const have = kind === 'binary' ? !f.hash || held.has(f.hash) : stored.has(docId) || this.received.has(docId) || (model.getLoadedDoc(docId)?.store.clients.size ?? 0) > 0;
      const state = have ? 'received' : peers > 0 ? 'receiving' : 'waiting';
      return { id: f.id, path: f.path, kind, have, state, ...(f.size !== undefined ? { size: f.size } : {}) };
    });
    const received = files.filter((f) => f.have).length;
    const total = files.length;
    const missing = total - received;
    const offline = this.o.offline();
    // With no peer ever connected the file list is only what this device has: no claim about being synced.
    const rootKnown = this.received.has(ROOT_DOC_ID);
    let stage: SyncStage;
    if (offline) stage = 'offline';
    else if (peers === 0) stage = connecting > 0 ? 'connecting' : 'alone';
    else if (!rootKnown || missing > 0) stage = 'receiving';
    else stage = 'synced';
    const percent = peers > 0 && rootKnown ? (total === 0 ? 100 : Math.floor((received / total) * 100)) : null;
    const now = this.now();
    if (received > this.lastReceived) {
      this.lastProgressAt = now;
      this.stallAnnounced = false;
    }
    this.lastReceived = received;
    if (stage === 'synced' && (this.prevStage !== 'synced' || this.activity)) this.lastSyncAt = now;
    this.activity = false;
    this.prevStage = stage;
    const waiting = stage === 'connecting' || stage === 'receiving';
    const stalled = waiting && now - this.lastProgressAt > (this.o.stallMs ?? 60_000);
    return {
      stage,
      peers,
      connecting,
      rootSynced: rootKnown,
      total,
      received,
      percent,
      files,
      lastSyncAt: this.lastSyncAt,
      stalled,
    };
  }

  private afterCompute(s: SyncSnapshot) {
    if (s.stage === 'receiving' || s.stage === 'connecting') this.hadMissing = true;
    if (s.stage === 'synced' && this.hadMissing) {
      this.hadMissing = false;
      for (const cb of this.evCbs) cb('complete');
    }
    if (s.stalled && !this.stallAnnounced) {
      this.stallAnnounced = true;
      for (const cb of this.evCbs) cb('stalled');
    }
    // Fetch when something new is missing or a peer appeared; not on every refresh (fetchAll itself triggers one).
    const key = `${s.peers}|${s.total - s.received}|${s.total}`;
    if (this.o.autoFetch !== false && s.peers > 0 && s.total > s.received && key !== this.lastFetchKey && !this.o.offline()) {
      this.lastFetchKey = key;
      void this.fetchAll();
    }
  }

  /** Requests every missing document and blob (bounded concurrency for blobs). Safe to call repeatedly. */
  async fetchAll(): Promise<{ missingText: number; missingBinaries: number; failed: number }> {
    if (this.fetching) {
      this.again = true;
      return { missingText: 0, missingBinaries: 0, failed: 0 };
    }
    this.fetching = true;
    let failed = 0;
    let missingText = 0;
    let missingBinaries = 0;
    try {
      do {
        this.again = false;
        const snap = this.current;
        await this.o.mesh.prefetchAll();
        const lacking = snap.files.filter((f) => !f.have);
        missingText = lacking.filter((f) => f.kind === 'text').length;
        const hashes = this.o.model
          .list()
          .filter((f) => f.kind === 'binary' && f.hash && lacking.some((l) => l.id === f.id))
          .map((f) => f.hash as string);
        missingBinaries = hashes.length;
        if (hashes.length) failed += (await this.o.blobs.fetchMissing(hashes)).failed;
      } while (this.again && !this.disposed);
    } finally {
      this.fetching = false;
    }
    this.touch();
    return { missingText, missingBinaries, failed };
  }
}
