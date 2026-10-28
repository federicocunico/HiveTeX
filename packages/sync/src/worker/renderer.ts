import * as Y from "yjs";
import { ROOT_DOC_ID, fileDocId, MAX_BLOB_BYTES, type Role } from "@hivetex/protocol";
import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import {
  BRIDGE_ORIGIN,
  ActorConflicts,
  type Delta,
  type Snapshot,
  type ActorCommand,
} from "../editor-bridge.js";
import {
  MemoryPersistence,
  type ChangeSet,
  type HistorySnapshot,
  type Persistence,
} from "../persistence.js";
import { ProjectModel, sha256Hex } from "../model.js";
import type { ProjectRuntime, RuntimeEvents } from "../runtime.js";
import type { Mesh, PeerInfo, ProjectReconcile } from "../mesh.js";
import type { BlobManager } from "../blobs.js";
import type { ChangeLog } from "../changelog.js";
import type { OfflineFork } from "../fork.js";
import type { ProjectOpen, WorkerProjects } from "./projects.js";
import { MIRROR_ORIGIN } from "../origins.js";
import { notifyRecoveryChange } from "../recovery.js";
import type { IngressEntry } from '../ingress.js';

export interface WorkerLink {
  request<T>(method: string, params: unknown): Promise<T>;
  on(event: string, cb: (data: { attachment: string; data: any }) => void): () => void;
}
type Status = ReturnType<WorkerProjects["status"]> & {
  awarenessId?: number;
  awareness?: Uint8Array;
  peerInfo?: PeerInfo[];
};

/** A transient editor replica. The worker is its only network and durability authority. */
export class WorkerRenderer {
  readonly attachment = crypto.randomUUID();
  readonly model: ProjectModel;
  readonly mesh: Mesh;
  readonly blobs: BlobManager;
  readonly store: Persistence;
  readonly changelog: ChangeLog;
  readonly fork: OfflineFork;
  readonly runtime: ProjectRuntime;
  private status!: Status;
  private observers = new Set<RuntimeEvents>();
  private subscriptions: Array<() => void> = [];
  private peers: PeerInfo[] = [];
  private joins = new Set<(p: PeerInfo) => void>();
  private leaves = new Set<(p: PeerInfo) => void>();
  private reconciledCbs = new Set<(doc: string, p: PeerInfo) => void>();
  private apps = new Map<string, Set<(p: PeerInfo, body: unknown) => void>>();
  private docs = new Map<
    string,
    { revision: number; ready: boolean; buffer: Delta[]; pending: Promise<void> | null }
  >();
  private complete = new Set<string>();
  private availabilityCbs = new Set<(docId: string) => void>();
  private refreshingDocs: Promise<void> | null = null;
  private docsRefreshRequested = false;
  private pending = new Map<
    number,
    { docId: string; update: Uint8Array; source: "editor" | "folder" }
  >();
  private seq = 0;
  private closed = false;
  private error: unknown = null;
  private chain: Promise<unknown> = Promise.resolve();
  private historyCbs = new Set<() => void>();
  private project: ProjectOpen | null = null;
  private reattaching: Promise<void> | null = null;
  private blobStoredCbs = new Set<() => void>();
  constructor(private link: WorkerLink) {
    const memory = new MemoryPersistence();
    this.model = new ProjectModel(memory);
    const getDoc = this.model.getDoc.bind(this.model);
    this.model.getDoc = async (docId) => {
      const doc = await getDoc(docId);
      await this.attachDoc(docId, doc);
      return doc;
    };
    this.model.onDocUpdate((docId, update, origin) => {
      if (origin === BRIDGE_ORIGIN || this.closed) return;
      const seq = ++this.seq;
      this.pending.set(seq, {
        docId,
        update: update.slice(),
        source: origin === MIRROR_ORIGIN ? "folder" : "editor",
      });
      this.chain = this.chain.catch(() => {}).then(() => this.send(seq));
      void this.chain.catch(() => {});
      this.emit();
    });
    const localFlush = this.model.flush.bind(this.model);
    this.model.flush = async () => {
      await this.chain;
      for (const seq of this.pending.keys()) await this.send(seq);
      await this.call('project.flush', {});
      await localFlush();
    };
    this.model.availability = (docId) =>
      this.complete.has(docId)
        ? "complete"
        : (this.model.getLoadedDoc(docId)?.store.clients.size ?? 0) > 0
          ? "partial"
          : "unknown";
    this.model.onAvailability = (cb) => {
      this.availabilityCbs.add(cb);
      return () => this.availabilityCbs.delete(cb);
    };
    this.model.initializeLocal = async (replacedSources = false) => {
      await this.command({ kind: 'initialize', replacedSources });
      await this.refreshDocs();
    };
    const awareness = new Awareness(this.model.root);
    awareness.on("update", (_changes: unknown, origin: unknown) => {
      if (origin === BRIDGE_ORIGIN || this.closed) return;
      void this.call("project.presence", { state: awareness.getLocalState() }).catch(() => {});
    });
    const port = this;
    this.mesh = {
      get historyStatus() { return port.status?.historyStatus ?? { complete: false, received: 0, pending: 0, legacyPeers: 0, quarantined: 0 }; },
      onHistory: (cb: () => void) => this.subscribe(this.historyCbs, cb),
      awareness,
      get peers() {
        return port.peers;
      },
      get sourceKey() {
        return port.peers
          .map((p) => p.deviceId + ":" + p.gen)
          .sort()
          .join("|");
      },
      onPeerJoin: (cb) => {
        this.joins.add(cb);
        return () => void this.joins.delete(cb);
      },
      onPeerLeave: (cb) => {
        this.leaves.add(cb);
        return () => void this.leaves.delete(cb);
      },
      onDocReconciled: (cb) => {
        this.reconciledCbs.add(cb);
        return () => this.reconciledCbs.delete(cb);
      },
      onApp: (topic, cb, options = {}) => {
        const handlers = this.apps.get(topic) ?? new Set();
        const wrapped = (p: PeerInfo, body: unknown) => {
          if (!options.editorOnly || p.claims.role !== "viewer") cb(p, body);
        };
        handlers.add(wrapped);
        this.apps.set(topic, handlers);
        return () => {
          handlers.delete(wrapped);
        };
      },
      broadcastApp: (topic, body) => {
        void this.call("mesh.app", { topic, body }).catch(() => {});
      },
      sendApp: (deviceId, topic, body) => this.call("mesh.app", { deviceId, topic, body }),
      openDoc: async (docId) => {
        await this.call("mesh.openDoc", { docId });
        await this.refreshDocs();
        await this.model.getDoc(docId);
      },
      awaitComplete: async (options) => {
        const r = await this.call<ProjectReconcile>("mesh.reconcile", {
          options: { timeoutMs: options?.timeoutMs },
        });
        await this.refreshDocs();
        await Promise.all([...this.complete].map((id) => this.model.getDoc(id)));
        return r;
      },
      reconcile: async (docId, options) => {
        const result = await this.call('mesh.reconcileDoc', { docId, timeoutMs: options?.timeoutMs });
        await this.refreshDocs(); await this.model.getDoc(docId);
        return result;
      },
      reconciling: () => false,
      reconciled: (docId) =>
        docId === ROOT_DOC_ID
          ? !!this.status.syncStatus?.rootReconciled
          : !!this.status.syncStatus?.files.find((f) => fileDocId(f.id) === docId)?.reconciled,
    } satisfies Pick<
      Mesh,
      | "historyStatus"
      | "reconcile"
      | "onHistory"
      | "awareness"
      | "peers"
      | "sourceKey"
      | "onPeerJoin"
      | "onPeerLeave"
      | "onDocReconciled"
      | "onApp"
      | "broadcastApp"
      | "sendApp"
      | "openDoc"
      | "awaitComplete"
      | "reconciling"
      | "reconciled"
    > as unknown as Mesh;
    this.blobs = {
      onStored: (cb: () => void) => this.subscribe(this.blobStoredCbs, cb),
      add: (bytes: Uint8Array) => this.addBlob(bytes),
      has: (hash: string) => this.call<boolean>("blob.has", { hash }),
      held: async () => new Set(await this.call<string[]>("blob.held", {})),
      fetch: (hash: string, timeoutMs?: number) => this.readBlob(hash, timeoutMs),
      get: (hash: string) => this.readBlob(hash).catch(() => undefined),
    } as BlobManager;
    this.store = Object.assign(Object.create(memory) as Persistence, {
      listDocs: () => this.call<string[]>('project.storeDocs', {}),
      exportRawStore: () => this.exportRawStore(),
      openRawExport: () => this.openRawExport(),
      listBlobs: () => this.call<string[]>('blob.held', {}),
      load: async (docId: string) => {
        const descriptor = await this.call<{ id: string; size: number }>('project.exportDocOpen', { docId });
        if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0 || descriptor.size > 64 * 1024 * 1024) throw new Error('Invalid document export size');
        const bytes = new Uint8Array(descriptor.size);
        for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) bytes.set(await this.call<Uint8Array>('project.exportDocRead', { id: descriptor.id, offset }), offset);
        return [bytes];
      },
      getMeta: (key: string) => this.call("project.meta", { key }),
      listMetaKeys: (prefix?: string) => this.call<string[]>("project.metaKeys", prefix === undefined ? {} : { prefix }),
      setMeta: (key: string, value: unknown) => this.call("project.metaSet", { key, value }),
      putBlob: async (_hash: string, bytes: Uint8Array) => {
        await this.blobs.add(bytes);
      },
      getBlob: (hash: string) => this.blobs.get(hash),
      listSnapshots: () => this.call<HistorySnapshot[]>("project.snapshots", {}),
      listChangeSets: () => this.call<ChangeSet[]>("project.history", {}),
      close: () => {},
    });
    // Folder merge bases are device metadata owned by the actor, never a second desktop store.
    memory.getMeta = (key) => this.store.getMeta(key);
    memory.setMeta = async (key, value) => {
      // Restore checkpoints live with the actor's store, so History can complete or cancel them after a restart.
      if (key === "mirrorBase" || key.startsWith("restore:pending:")) await this.store.setMeta(key, value);
    };
    const transact = memory.transact.bind(memory);
    memory.transact = async (ops) => {
      await transact(ops);
      for (const o of ops) if (o.op === "meta" && o.key.startsWith("restore:pending:") && o.value !== undefined) await this.store.setMeta(o.key, o.value);
    };
    this.changelog = {
      list: () => this.call("project.history", {}),
      flush: () => this.call("project.flush", {}),
      onChange: (cb: () => void) => this.subscribe(this.historyCbs, cb),
      interruptedUndos: () => this.call("project.undoInterrupted", {}),
      abandonUndo: async (changeSetId: string) => {
        const value = await this.call<string | null>("project.undoAbandon", { changeSetId });
        return value ? (await this.call<ChangeSet[]>("project.history", {})).find((c) => c.id === value) ?? null : null;
      },
      undo: async (set: ChangeSet) => {
        const value = await this.command({ kind: "undo", changeSetId: set.id });
        return (
          (await this.call<ChangeSet[]>("project.history", {})).find((c) => c.id === value) ?? null
        );
      },
    } as unknown as ChangeLog;
    this.fork = {
      get active() {
        return port.status.unsharedWork;
      },
      get conflicts() {
        return port.status.conflicts;
      },
      mergeIn: (files: unknown) => this.call("project.merge", { files }),
      recordTextConflict: (conflict: unknown) => this.call("project.folderConflict", { conflict }),
      resolveText: (id: string, decisions: unknown) =>
        this.resolve("conflict.text", id, { decisions }),
      resolveFile: (id: string, choice: unknown) => this.resolve("conflict.file", id, { choice }),
    } as unknown as OfflineFork;
    const view = {
      model: this.model,
      mesh: this.mesh,
      blobs: this.blobs,
      changelog: this.changelog,
      fork: this.fork,
      listen: (events: RuntimeEvents) => this.subscribe(this.observers, events),
      startNetworking: () => {},
      setPaused: (paused: boolean) => {
        void this.call("project.pause", { paused }).catch((e) => this.fail(e));
      },
      refreshTicketNow: () => this.call("project.refresh", {}),
      syncNow: () => this.call("project.sync", {}),
      probePeer: (dev: string, o: { relayOnly?: boolean } = {}) => this.call("project.probe", { dev, relayOnly: o.relayOnly === true }),
      networkRestored: () => {
        void this.call("project.refresh", {}).catch(() => {});
      },
      get role() {
        return port.status.role;
      },
      get deviceId() {
        return port.status.deviceId;
      },
      get revoked() {
        return port.status.revoked;
      },
      get authRequired() { return port.status.authRequired; },
      get offline() {
        return port.status.offline;
      },
      get paused() {
        return port.status.paused;
      },
      get saveFailing() {
        return !!port.error || port.status.saveFailing;
      },
      get unsharedWork() {
        return port.status.unsharedWork;
      },
      get mergeError() {
        return port.status.mergeError;
      },
      get conflicts() {
        return port.status.conflicts;
      },
      get syncStatus() {
        return port.status.syncStatus;
      },
      get peers() {
        return port.status.peers;
      },
      get connecting() {
        return port.status.connecting;
      },
      get doorbellState() {
        return port.status.doorbellState;
      },
      get managerDiagnostics() {
        return port.status.diagnostics;
      },
      trusted: [],
    };
    this.runtime = view as unknown as ProjectRuntime;
    this.model.captureSnapshot = async () => {
      await this.model.flush();
      return this.call("project.snapshot", {});
    };
    this.model.previewRestore = (snapshotId) => this.call('project.previewRestore', { snapshotId });
    this.model.recoveryFiles = () => this.call('project.recoveryFiles', {});
    this.model.recoveryState = () => this.call('project.recoveryState', {});
    this.model.restoreDeleted = (id, deletionId, path) => this.command({ kind: 'restore-deleted', id, deletionId, ...(path ? { path } : {}) }) as unknown as void;
    this.model.confirmDeletion = (id, deletionId, expectedRevision) => this.command({ kind: 'confirm-deletion', id, deletionId, expectedRevision }) as unknown as void;
    this.model.resolveBinary = (id, hash, _canApply, expectedRevision) => this.command({ kind: 'resolve-binary', id, hash, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }) as unknown as void;
    this.model.restore = async (snapshotId, _canApply, expectedRevision, requestId) =>
      (await this.command({ kind: "restore", snapshotId, ...(expectedRevision !== undefined ? { expectedRevision } : {}), ...(requestId ? { requestId } : {}) })) as { undoId: string };
    this.model.createTextNow = async (path, text = "", origin) => {
      const id = (await this.command({ kind: "create", path, text, ...(origin===MIRROR_ORIGIN?{source:'folder' as const}:{}) })) as string;
      await this.refreshDocs();
      return id;
    };
    this.model.applyBatch = async (ops) => {
      const created = new Map(Object.entries((await this.command({ kind: 'batch', ops })) as Record<string, string>));
      await this.refreshDocs();
      return { created };
    };
    this.model.rename = (id, path, origin) => {
      void this.command({ kind: "rename", id, path, ...(origin === MIRROR_ORIGIN ? { source: 'folder' as const } : {}) }).catch((e) => this.fail(e));
    };
    this.model.delete = (id, origin) => {
      void this.command({ kind: "delete", id, ...(origin === MIRROR_ORIGIN ? { source: 'folder' as const } : {}) }).catch((e) => this.fail(e));
    };
  }
  private subscribe<T>(set: Set<T>, cb: T) {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }
  private call<T = any>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.link.request(method, { attachment: this.attachment, ...params });
  }
  private emit() {
    for (const o of this.observers) o.change?.();
  }
  private fail(e: unknown) {
    this.error = e;
    this.emit();
  }
  private async send(seq: number) {
    const edit = this.pending.get(seq);
    if (!edit) return;
    try {
      const result = await this.call<{ status: string }>("doc.edit", { seq, ...edit });
      if (result.status !== "durable")
        throw new Error("Edits were denied; recovery data was retained");
      this.pending.delete(seq);
      if (!this.pending.size) this.error = null;
      this.emit();
    } catch (e) {
      this.fail(e);
      throw e;
    }
  }
  private async command(command: ActorCommand) {
    await this.model.flush();
    const r = await this.call<{ ok: boolean; value?: unknown; reason?: string }>(
      "project.command",
      { command },
    );
    if (!r.ok) throw new Error(r.reason ?? "Command failed");
    return r.value;
  }
  private async resolve(method: string, id: string, params: Record<string, unknown>) {
    const conflict = this.status.conflicts.find((c) => c.id === id);
    if (!conflict) throw new Error("Conflict no longer exists");
    const result = await this.call(method, {
      id,
      rev: (conflict as { rev?: string }).rev ?? ActorConflicts.revision(conflict),
      ...params,
    });
    if (result === "stale" || result === "denied")
      throw new Error("Conflict changed or edit access was withdrawn");
    return result;
  }
  async open(project: ProjectOpen) {
    for (const event of [
      "status",
      "delta",
      "replace",
      "peer.join",
      "peer.leave",
      "app",
      "awareness",
      "reconciled",
      "ticket",
      "merge",
      "recovery",
      "availability",
    ])
      this.subscriptions.push(
        this.link.on("project." + event, (p) => {
          if (p.attachment !== this.attachment || this.closed) return;
          if (event === "status") {
            const prev = this.status;
            this.status = { ...this.status, ...p.data };
            const heldBefore = new Set(prev?.syncStatus?.files.filter((f) => f.kind === 'binary' && f.have).map((f) => f.id));
            if (this.status.syncStatus?.files.some((f) => f.kind === 'binary' && f.have && !heldBefore.has(f.id))) {
              for (const cb of this.blobStoredCbs) cb();
            }
            for (const o of this.observers) {
              if (prev?.role !== this.status.role) o.role?.(this.status.role);
              if (prev?.deviceId !== this.status.deviceId) o.deviceId?.(this.status.deviceId);
            }
            this.emit();
            for (const cb of this.historyCbs) cb();
          } else if (event === 'availability') {
            void this.refreshDocs().catch((e) => this.fail(e));
          } else if (event === "delta") this.delta(p.data);
          else if (event === "replace") {
            this.docs.delete(p.data.docId);
            void this.model
              .replaceDoc(p.data.docId, new Uint8Array([0, 0]))
              .then(() => this.attachDoc(p.data.docId, this.model.getLoadedDoc(p.data.docId)!))
              .catch((e) => this.fail(e));
          } else if (event === "peer.join") {
            this.peers = this.peers.filter((x) => x.deviceId !== p.data.deviceId);
            const peer = {
              ...p.data,
              conn: {
                get role() {
                  return peer.claims.role;
                },
              },
            } as PeerInfo;
            this.peers.push(peer);
            for (const cb of this.joins) cb(peer);
          } else if (event === "peer.leave") {
            this.peers = this.peers.filter((x) => x.deviceId !== p.data.deviceId);
            for (const cb of this.leaves) cb(p.data);
          } else if (event === "app") {
            for (const cb of this.apps.get(p.data.topic) ?? [])
              cb({ ...p.data.from, conn: { role: p.data.from.claims.role } }, p.data.body);
          } else if (event === "awareness")
            applyAwarenessUpdate(this.mesh.awareness, p.data, BRIDGE_ORIGIN);
          else if (event === "reconciled") {
            for (const cb of this.reconciledCbs) cb(p.data.docId, p.data.from);
          } else if (event === "ticket") {
            for (const o of this.observers) o.ticket?.(p.data);
          } else if (event === "merge") {
            for (const o of this.observers) o.mergeReport?.(p.data);
          } else if (event === "recovery") notifyRecoveryChange(this.store);
        }),
      );
    try {
      this.status = await this.call<Status>("project.open", { project });
      this.project = project;
      this.peers = (this.status.peerInfo ?? []).map(
        (p) => ({ ...p, conn: { role: p.claims.role } }) as PeerInfo,
      );
      await this.model.init();
      await this.attachDoc(ROOT_DOC_ID, this.model.root);
      await this.refreshDocs();
      if (this.status.awarenessId) this.mesh.awareness.clientID = this.status.awarenessId;
      if (this.status.awareness)
        applyAwarenessUpdate(this.mesh.awareness, this.status.awareness, BRIDGE_ORIGIN);
    } catch (e) {
      await this.close().catch(() => {});
      throw e;
    }
  }
  /**
   * The sync worker restarted: the new generation knows no attachment. Opens the project again under the same
   * attachment (edits the old worker had journaled are replayed once by the new one, keyed on attachment and
   * sequence), brings every loaded document up to the worker's state and resends the edits not yet durable.
   */
  reattach(): Promise<void> {
    if (this.closed || !this.project) return Promise.resolve();
    this.reattaching ??= (async () => {
      const project = this.project!;
      const loaded = [...this.docs.keys()];
      this.docs.clear();
      const status = await this.call<Status>("project.open", { project });
      this.status = { ...this.status, ...status };
      this.peers = (status.peerInfo ?? []).map((p) => ({ ...p, conn: { role: p.claims.role } }) as PeerInfo);
      for (const docId of loaded) {
        const doc = docId === ROOT_DOC_ID ? this.model.root : this.model.getLoadedDoc(docId);
        if (doc) await this.attachDoc(docId, doc);
      }
      await this.refreshDocs();
      const awareness = this.mesh.awareness;
      if (status.awarenessId && status.awarenessId !== awareness.clientID) {
        // Presence now carries the new actor's id: move our state to it, so our own cursor is not shown as a peer's.
        const local = awareness.getLocalState(), previous = awareness.clientID;
        awareness.clientID = status.awarenessId;
        awareness.setLocalState(local);
        removeAwarenessStates(awareness, [previous], BRIDGE_ORIGIN);
      }
      if (status.awareness) applyAwarenessUpdate(awareness, status.awareness, BRIDGE_ORIGIN);
      this.chain = this.chain.catch(() => {}).then(async () => {
        for (const seq of [...this.pending.keys()]) await this.send(seq);
      });
      await this.chain;
      if (!this.pending.size) this.error = null;
      this.emit();
      for (const cb of this.historyCbs) cb();
    })().finally(() => {
      this.reattaching = null;
    });
    return this.reattaching;
  }
  private refreshDocs(): Promise<void> {
    // A batch can initialize thousands of documents. Coalesce its events, while retaining a refresh requested
    // during an RPC so callers never rely on a response captured before their command completed.
    this.docsRefreshRequested = true;
    this.refreshingDocs ??= Promise.resolve().then(async () => {
      try {
        while (this.docsRefreshRequested) {
          this.docsRefreshRequested = false;
          const docs = await this.call<Array<{ docId: string; complete: boolean }>>('project.docs', {});
          const previous = this.complete;
          this.complete = new Set(docs.filter(d => d.complete).map(d => d.docId));
          for (const docId of this.complete) if (!previous.has(docId)) {
            for (const cb of this.availabilityCbs) cb(docId);
          }
        }
      } finally {
        this.refreshingDocs = null;
      }
    });
    return this.refreshingDocs;
  }
  private attachDoc(docId: string, doc: Y.Doc): Promise<void> {
    const existing = this.docs.get(docId);
    if (existing) return existing.pending ?? Promise.resolve();
    const state = {
      revision: 0,
      ready: false,
      buffer: [] as Delta[],
      pending: null as Promise<void> | null,
    };
    this.docs.set(docId, state);
    state.pending = this.call<Snapshot>("doc.attach", {
      docId,
      stateVector: Y.encodeStateVector(doc),
    })
      .then((s) => {
        Y.applyUpdate(doc, s.update, BRIDGE_ORIGIN);
        state.revision = s.revision;
        state.ready = true;
        for (const delta of state.buffer.sort((a, b) => a.revision - b.revision)) this.delta(delta);
        state.buffer = [];
      })
      .catch((e) => {
        this.docs.delete(docId);
        throw e;
      })
      .finally(() => {
        state.pending = null;
      });
    return state.pending;
  }
  private delta(d: Delta) {
    const state = this.docs.get(d.docId);
    if (!state) return;
    if (!state.ready) {
      state.buffer.push(d);
      return;
    }
    if (d.revision <= state.revision) return;
    const doc = this.model.getLoadedDoc(d.docId);
    if (doc) {
      Y.applyUpdate(doc, d.update, BRIDGE_ORIGIN);
      state.revision = d.revision;
    }
  }
  private async addBlob(bytes: Uint8Array): Promise<string> {
    if (bytes.length > MAX_BLOB_BYTES) throw new Error('blob too large');
    if (bytes.length <= 1024 * 1024) return this.call('blob.add', { bytes });
    const hash = await sha256Hex(bytes);
    const upload = await this.call<string>('blob.begin', { hash, size: bytes.length });
    try {
      for (let offset = 0, part = 0; offset < bytes.length; offset += 1024 * 1024, part++)
        await this.call('blob.chunk', { upload, part, bytes: bytes.subarray(offset, offset + 1024 * 1024) });
      return await this.call<string>('blob.commit', { upload });
    } catch (e) {
      await this.call('blob.abort', { upload }).catch(() => {});
      throw e;
    }
  }
  /** A recovery export includes native custody/denied input even after the original renderer was destroyed. */
  async recoveryEntries() {
    const out: IngressEntry[] = [];
    let after = { attachment: '', seq: 0 };
    for (;;) {
      const page = await this.call<IngressEntry[]>('project.recovery', { after });
      if (!page.length) return out;
      out.push(...page);
      const last = page[page.length - 1]!;
      after = { attachment: last.attachment, seq: last.seq };
    }
  }
  private async *exportRawStore() {
    const raw = await this.openRawExport();
    try { yield* raw.chunks; } finally { await raw.close(); }
  }
  /** Size first (`-1` when the worker cannot tell), then 1 MiB chunks pulled one at a time (D7). */
  private async openRawExport() {
    const { id, size } = await this.call<{ id: string; size?: number }>('project.storeExportOpen', {});
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await this.call('project.storeExportClose', { id }); } };
    const call = this.call.bind(this);
    const chunks = (async function* () {
      for (;;) {
        const part = await call<{ done: boolean; bytes?: Uint8Array }>('project.storeExportRead', { id });
        if (part.done) { closed = true; return; }
        if (!part.bytes || !part.bytes.length || part.bytes.length > 1024 * 1024) throw new Error('Invalid store export chunk');
        yield part.bytes;
      }
    })();
    return { size: Number.isSafeInteger(size) ? size! : -1, chunks, close };
  }
  private async readBlob(hash: string, timeoutMs?: number) {
    let offset = 0,
      out: Uint8Array | undefined;
    do {
      const p = await this.call<{ total: number; bytes: Uint8Array }>("blob.read", {
        hash,
        offset,
        timeoutMs,
      });
      out ??= new Uint8Array(p.total);
      if (!p.bytes.length && offset < p.total) throw new Error("Incomplete blob");
      out.set(p.bytes, offset);
      offset += p.bytes.length;
    } while (offset < out.length);
    return out;
  }
  async close() {
    if (this.closed) return;
    await this.model.flush();
    this.closed = true;
    for (const off of this.subscriptions) off();
    this.mesh.awareness.destroy();
    await this.call("project.detach", {});
    await this.model.destroy();
  }
}
