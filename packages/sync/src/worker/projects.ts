import { ROOT_DOC_ID, fileDocId, MAX_BLOB_BYTES } from "@hivetex/protocol";
import { ActorDocs, ActorCommands, ActorConflicts, type ActorCommand } from "../editor-bridge.js";
import { EditIngress, type IngressJournal } from "../ingress.js";
import { encodeValue, decodeValue, type StagedBlobStore, type NativePersistence } from "../native-persistence.js";
import type { Persistence } from "../persistence.js";
import { RuntimeRegistry, runtimeKeyString, type RuntimeKey, type Lease } from "../registry.js";
import type { ProjectRuntime } from "../runtime.js";
import type { RpcEndpoint } from "../worker-ipc.js";
import { onRecoveryChange } from "../recovery.js";
import { encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from 'yjs';

export interface ProjectOpen extends RuntimeKey {
  scope: string;
  role: "owner" | "editor" | "viewer";
  isLocal: boolean;
  createdHere: boolean;
}
export interface WorkerProject {
  runtime: ProjectRuntime;
  store: Persistence;
  journal: IngressJournal;
  close(): Promise<void>;
  registerAttachment?(attachment: string): Promise<void>;
  unregisterAttachment?(attachment: string): Promise<void>;
}
interface Actor extends WorkerProject {
  docs: ActorDocs;
  commands: ActorCommands;
  conflicts: ActorConflicts;
  ingress: EditIngress;
  disposeObservers(): void;
}
interface BlobUpload {
  attachment: string;
  actor: Actor;
  store: StagedBlobStore;
  hash: string;
  size: number;
  received: number;
  part: number;
  busy: boolean;
  work?: Promise<void>;
}
/** One authority in the actual worker, shared by foreground attachments and background demand. */
export class WorkerProjects {
  readonly registry: RuntimeRegistry<Actor>;
  private opening = new Map<string, ProjectOpen>();
  private attachments = new Map<string, { key: RuntimeKey; lease: Lease<Actor> }>();
  private account: string | null = null;
  private generation = 0;
  private blocked = false;
  private uploads = new Map<string, BlobUpload>();
  private uploadCleanup: Promise<unknown> = Promise.resolve();
  private exportDocs = new Map<string, { attachment: string; bytes: Uint8Array; at: number }>();
  private exportStores = new Map<string, { attachment: string; iterator: AsyncIterator<Uint8Array>; busy: boolean; at: number }>();
  constructor(
    private o: {
      create(p: ProjectOpen): Promise<WorkerProject>;
      emit(event: string, data: unknown): void;
      opened?(p: ProjectOpen, runtime: ProjectRuntime): Promise<void>;
      detached?(p: ProjectOpen, runtime: ProjectRuntime): Promise<void>;
      ticket?(p: ProjectOpen, runtime: ProjectRuntime, answer: import('../runtime.js').TicketAnswer): void;
      stopping?(): Promise<void>;
      pause?(p: ProjectOpen, paused: boolean): Promise<void>;
      authorize?(p: ProjectOpen): Promise<void>;
      freezing?(): void;
    },
  ) {
    this.registry = new RuntimeRegistry({
      create: async (key) => {
        const p = this.opening.get(runtimeKeyString(key));
        if (!p) throw new Error("project not configured");
        const project = await this.o.create(p);
        const r = project.runtime;
        let stopped = false;
        const canApply = () => !stopped && !r.revoked && r.role !== "viewer";
        const ingress = new EditIngress({
          model: r.model,
          journal: project.journal,
          canApply,
          originFor: (e) => ({ attachment: e.attachment, kind: e.source ?? "editor" }),
        });
        await ingress.recover(false);
        const docs = new ActorDocs({ model: r.model, ingress });
        const commands = new ActorCommands({ model: r.model, changelog: r.changelog, canApply });
        const conflicts = new ActorConflicts({ fork: r.fork, canApply });
        const notify = () => this.emitFor(key, "status", this.status(r));
        const off = r.listen({
          change: notify,
          ticket: (answer) => {
            this.o.ticket?.(p, r, answer);
            this.emitFor(key, "ticket", answer);
          },
          mergeReport: (report) => this.emitFor(key, "merge", report),
        });
        const replaced = r.model.onDocReplaced((docId) => this.emitFor(key, "replace", { docId }));
        const peer = (p: import("../mesh.js").PeerInfo) => ({
          deviceId: p.deviceId,
          claims: p.claims,
          gen: p.gen,
        });
        const unsubs: Array<() => void> = [
          off,
          replaced,
          r.model.onAvailability((docId) => this.emitFor(key, 'availability', { docId })),
          onRecoveryChange(project.store, () => this.emitFor(key, "recovery", {})),
          r.mesh.onPeerJoin((p) => this.emitFor(key, "peer.join", peer(p))),
          r.mesh.onPeerLeave((p) => this.emitFor(key, "peer.leave", peer(p))),
          r.mesh.onDocReconciled((docId, from) =>
            this.emitFor(key, "reconciled", { docId, from: peer(from) }),
          ),
          ...["gh-cap"].map((topic) =>
            r.mesh.onApp(topic, (from, body) =>
              this.emitFor(key, "app", { topic, from: peer(from), body }),
            ),
          ),
        ];
        const awareness = () =>
          this.emitFor(
            key,
            "awareness",
            encodeAwarenessUpdate(r.mesh.awareness, [...r.mesh.awareness.getStates().keys()]),
          );
        r.mesh.awareness.on("update", awareness);
        unsubs.push(() => r.mesh.awareness.off("update", awareness));
        const disposeObservers = () => {
          for (const un of unsubs) un();
          docs.close();
        };
        return {
          ...project,
          docs,
          commands,
          conflicts,
          ingress,
          disposeObservers,
          setPaused: (paused: boolean) => r.setPaused(paused),
          close: async () => {
            stopped = true;
            disposeObservers();
            await project.close();
          },
        };
      },
    });
  }
  private emitFor(key: RuntimeKey, event: string, data: unknown) {
    for (const [attachment, a] of this.attachments)
      if (runtimeKeyString(a.key) === runtimeKeyString(key))
        this.o.emit(event, { attachment, data });
  }
  status(r: ProjectRuntime) {
    return {
      role: r.role,
      deviceId: r.deviceId,
      offline: r.offline,
      revoked: r.revoked,
      authRequired: r.authRequired,
      paused: r.paused,
      saveFailing: r.saveFailing,
      unsharedWork: r.unsharedWork,
      mergeError: r.mergeError ? String(r.mergeError) : null,
      conflicts: r.conflicts.map((c) => ({ ...c, rev: ActorConflicts.revision(c) })),
      syncStatus: r.syncStatus,
      historyStatus: r.mesh.historyStatus,
      peers: r.peers,
      connecting: r.connecting,
      doorbellState: r.doorbellState,
      diagnostics: r.managerDiagnostics,
    };
  }
  async open(p: ProjectOpen, attachment: string, signal?: AbortSignal) {
    const generation = this.generation;
    if (this.blocked) throw new Error('account stopped');
    if (!attachment || attachment.length > 128 || this.attachments.has(attachment))
      throw new Error("invalid attachment");
    await this.o.authorize?.(p);
    if (generation !== this.generation || this.blocked) throw new Error('account stopped');
    const identity = JSON.stringify([p.server, p.account]);
    if (this.account && this.account !== identity) throw new Error("account stop barrier required");
    this.account = identity;
    this.opening.set(runtimeKeyString(p), p);
    const lease = this.registry.attach(p, "editor");
    this.attachments.set(attachment, { key: p, lease });
    const cancel = () => {
      void this.detach(attachment);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const a = await lease.runtime;
      if (signal?.aborted || generation !== this.generation || !this.attachments.has(attachment))
        throw new Error("attachment cancelled");
      await a.registerAttachment?.(attachment);
      if (signal?.aborted || generation !== this.generation || !this.attachments.has(attachment))
        throw new Error("attachment cancelled");
      await this.o.opened?.(p, a.runtime);
      a.runtime.startNetworking();
      return {
        ...this.status(a.runtime),
        awarenessId: a.runtime.mesh.awareness.clientID,
        awareness: encodeAwarenessUpdate(a.runtime.mesh.awareness, [
          ...a.runtime.mesh.awareness.getStates().keys(),
        ]),
        peerInfo: a.runtime.mesh.peers.map((p) => ({
          deviceId: p.deviceId,
          claims: p.claims,
          gen: p.gen,
        })),
      };
    } catch (e) {
      await this.detach(attachment);
      throw e;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  async actor(attachment: string) {
    const a = this.attachments.get(attachment);
    if (!a) throw new Error("attachment closed");
    const r = await a.lease.runtime;
    if (this.attachments.get(attachment) !== a) throw new Error("attachment closed");
    return r;
  }
  /** Background leases use exactly the editor's registry and writer, without an editor attachment. */
  seed(p: ProjectOpen) {
    if (this.blocked) throw new Error('account stopped');
    const identity = JSON.stringify([p.server, p.account]);
    if (this.account && this.account !== identity) throw new Error('account stop barrier required');
    this.account = identity;
    this.opening.set(runtimeKeyString(p), p);
    return this.registry.attach(p, 'background');
  }
  async detach(attachment: string) {
    const a = this.attachments.get(attachment);
    if (!a) return;
    this.attachments.delete(attachment);
    for (const [id, value] of this.exportDocs) if (value.attachment === attachment) this.exportDocs.delete(id);
    for (const [id, value] of this.exportStores) if (value.attachment === attachment) {
      this.exportStores.delete(id);
      await value.iterator.return?.().catch(() => {});
    }
    await this.abortUploads(attachment);
    const actor = this.registry.get(a.key);
    actor?.docs.detach(attachment);
    await actor?.unregisterAttachment?.(attachment);
    if (
      ![...this.attachments.values()].some(
        (other) => runtimeKeyString(other.key) === runtimeKeyString(a.key),
      )
    ) {
      if (actor) {
        actor.runtime.mesh.awareness.setLocalState({ seed: true, deviceId: actor.runtime.deviceId });
        const p = this.opening.get(runtimeKeyString(a.key));
        if (p) await this.o.detached?.(p, actor.runtime);
      }
    }
    await a.lease.release();
  }
  /** The renderer went away (window closed): its editor attachments end, background seeds continue. */
  async detachAll() {
    for (const attachment of [...this.attachments.keys()]) await this.detach(attachment).catch(() => {});
  }
  /** Durable flush of every running project before quit; returns the projects whose state could not be saved. */
  async flushAll(): Promise<string[]> {
    const failing: string[] = [];
    for (const key of this.registry.keys()) {
      const runtime = this.registry.get(key)?.runtime;
      if (!runtime) continue;
      try {
        await runtime.changelog.flush();
        await runtime.model.flush();
      } catch {
        failing.push(key.project);
        continue;
      }
      if (runtime.saveFailing) failing.push(key.project);
    }
    return failing;
  }
  async stop() {
    ++this.generation;
    this.attachments.clear();
    await this.abortUploads();
    await this.registry.stopWhere(() => true);
    this.opening.clear();
    this.account = null;
  }
  freeze() {
    this.blocked = true; ++this.generation;
    void this.abortUploads();
    this.o.freezing?.();
    for (const key of this.registry.keys()) this.registry.get(key)?.runtime.setPaused(true);
  }
  activate() { this.blocked = false; }
  private writableBlob(actor: Actor, attachment: string) {
    return !this.blocked && !actor.runtime.revoked && actor.runtime.role !== 'viewer'
      && this.attachments.has(attachment);
  }
  private abortUploads(attachment?: string) {
    const pending: Promise<unknown>[] = [];
    for (const [id, u] of this.uploads) if (!attachment || u.attachment === attachment) {
      this.uploads.delete(id);
      pending.push(Promise.resolve(u.work).catch(() => {}).then(() => u.store.abortBlobUpload(id)).catch(() => {}));
    }
    this.uploadCleanup = Promise.all([this.uploadCleanup, ...pending]);
    return this.uploadCleanup;
  }
  private async upload(attachment: string, id: string) {
    const actor = await this.actor(attachment);
    const u = this.uploads.get(id);
    if (!u || u.attachment !== attachment || u.actor !== actor) throw new Error('invalid upload');
    if (!this.writableBlob(actor, attachment)) throw new Error('denied');
    if (u.busy) throw new Error('upload busy');
    return u;
  }
  install(rpc: RpcEndpoint) {
    const handle = (method: string, f: (p: Record<string, any>, signal: AbortSignal) => unknown) =>
      rpc.handle(method, async (wire, signal) => {
        if (typeof wire !== "string") throw new Error("encoded parameters required");
        const p = decodeValue(wire) as Record<string, any>;
        if (!p || typeof p !== "object") throw new Error("invalid parameters");
        return encodeValue((await f(p, signal)) ?? null);
      });
    handle("project.open", (p, signal) => this.open(p.project, p.attachment, signal));
    handle("project.detach", (p) => this.detach(p.attachment));
    handle('account.freeze', () => this.freeze());
    handle("account.stop", async () => { this.freeze(); await this.o.stopping?.(); await this.stop(); });
    handle("project.status", async (p) => this.status((await this.actor(p.attachment)).runtime));
    handle("project.pause", async (p) => {
      const a = await this.actor(p.attachment);
      a.runtime.setPaused(p.paused === true);
      const key = this.attachments.get(p.attachment)?.key;
      const project = key && this.opening.get(runtimeKeyString(key));
      if (project) await this.o.pause?.(project, p.paused === true);
    });
    handle("project.sync", async (p) => (await this.actor(p.attachment)).runtime.syncNow());
    handle("project.probe", async (p) => (await this.actor(p.attachment)).runtime.probePeer(String(p.dev), { relayOnly: p.relayOnly === true }));
    handle("project.refresh", async (p) =>
      (await this.actor(p.attachment)).runtime.refreshTicketNow(),
    );
    handle("project.flush", async (p) => {
      const a = await this.actor(p.attachment);
      await a.runtime.changelog.flush();
      await a.runtime.model.flush();
    });
    handle('project.recovery', async (p) => {
      const journal = (await this.actor(p.attachment)).journal;
      const after = p.after ?? { attachment: '', seq: 0 };
      if (typeof after.attachment !== 'string' || after.attachment.length > 128 || !Number.isSafeInteger(after.seq) || after.seq < 0) throw new Error('invalid journal cursor');
      if (journal.page) return journal.page(after);
      const out = []; let bytes = 0;
      for (const entry of await journal.pending()) {
        if (entry.attachment < after.attachment || (entry.attachment === after.attachment && entry.seq <= after.seq)) continue;
        if (out.length && (out.length >= 64 || bytes + entry.update.length > 3 * 1024 * 1024)) break;
        bytes += entry.update.length; out.push(entry);
      }
      return out;
    });
    handle("doc.attach", async (p) => {
      const a = await this.actor(p.attachment);
      return a.docs.attach(p.attachment, p.docId, p.stateVector, (delta) =>
        this.o.emit("delta", { attachment: p.attachment, data: delta }),
      );
    });
    handle("doc.edit", async (p) => {
      if (!Number.isSafeInteger(p.seq) || p.seq < 1 || !(p.update instanceof Uint8Array))
        throw new Error("invalid edit");
      const a = await this.actor(p.attachment);
      if (p.source !== undefined && !["editor", "folder"].includes(p.source))
        throw new Error("invalid edit origin");
      return a.docs.submit(p.attachment, p.seq, p.docId, p.update, p.source);
    });
    handle("project.command", async (p) =>
      (await this.actor(p.attachment)).commands.run(p.command as ActorCommand),
    );
    handle("conflict.text", async (p) =>
      (await this.actor(p.attachment)).conflicts.resolveText(p.id, p.rev, p.decisions),
    );
    handle("conflict.file", async (p) =>
      (await this.actor(p.attachment)).conflicts.resolveFile(p.id, p.rev, p.choice),
    );
    handle("project.history", async (p) =>
      (await this.actor(p.attachment)).runtime.changelog.list(),
    );
    handle("project.undoInterrupted", async (p) => (await this.actor(p.attachment)).runtime.changelog.interruptedUndos());
    handle("project.undoAbandon", async (p) => {
      const a = await this.actor(p.attachment);
      if (typeof p.changeSetId !== "string" || p.changeSetId.length > 200) throw new Error("invalid change set");
      const canApply = () => !this.blocked && !a.runtime.revoked && a.runtime.role !== "viewer" && this.attachments.has(p.attachment);
      return (await a.runtime.changelog.abandonUndo(p.changeSetId, canApply))?.id ?? null;
    });
    handle("project.snapshots", async (p) =>
      (await this.actor(p.attachment)).store.listSnapshots(),
    );
    handle("project.snapshot", async (p) =>
      (await this.actor(p.attachment)).runtime.model.captureSnapshot(),
    );
    handle("project.previewRestore", async (p) =>
      (await this.actor(p.attachment)).runtime.model.previewRestore(p.snapshotId),
    );
    handle("project.recoveryFiles", async (p) =>
      (await this.actor(p.attachment)).runtime.model.recoveryFiles(),
    );
    handle('project.recoveryState', async (p) => (await this.actor(p.attachment)).runtime.model.recoveryState());
    handle("project.docs", async (p) => {
      const m = (await this.actor(p.attachment)).runtime.model;
      return [
        ROOT_DOC_ID,
        ...[...m.list(), ...m.deletedFiles()]
          .filter((f) => f.kind === "text")
          .map((f) => fileDocId(f.id)),
      ].map((docId) => ({ docId, complete: m.availability(docId) === "complete" }));
    });
    handle("project.meta", async (p) => (await this.actor(p.attachment)).store.getMeta(p.key));
    handle("project.metaKeys", async (p) => {
      if (p.prefix !== undefined && (typeof p.prefix !== "string" || p.prefix.length > 200)) throw new Error("invalid metadata prefix");
      return (await this.actor(p.attachment)).store.listMetaKeys?.(p.prefix) ?? [];
    });
    handle('project.storeDocs', async (p) => {
      const actor = await this.actor(p.attachment);
      return [...new Set([...(await actor.store.listDocs()), ...actor.runtime.model.loadedDocIds()])];
    });
    handle('project.storeExportOpen', async (p) => {
      const store = (await this.actor(p.attachment)).store;
      for (const [id, value] of this.exportStores) if (Date.now() - value.at > 120_000) {
        this.exportStores.delete(id); await value.iterator.return?.().catch(() => {});
      }
      if (!store.exportRawStore) throw new Error('Native store export unavailable');
      if (this.exportStores.size >= 2) throw new Error('Too many active store exports');
      const id = crypto.randomUUID();
      // With its size known up front, the renderer can refuse an archive over the ZIP limit before writing (D7).
      const raw = await store.openRawExport?.();
      const chunks = raw?.chunks[Symbol.asyncIterator]();
      // Closed even when refused before the first read (a generator's finally would not run then).
      const iterator: AsyncIterator<Uint8Array> = raw && chunks ? {
        next: async () => { const n = await chunks.next(); if (n.done) await raw.close(); return n; },
        return: async () => { await chunks.return?.(); await raw.close(); return { done: true, value: undefined }; },
      } : store.exportRawStore()[Symbol.asyncIterator]();
      this.exportStores.set(id, { attachment: p.attachment, iterator, busy: false, at: Date.now() });
      return raw ? { id, size: raw.size } : { id };
    });
    handle('project.storeExportRead', async (p) => {
      await this.actor(p.attachment);
      const value = this.exportStores.get(p.id);
      if (!value || value.attachment !== p.attachment || value.busy || Date.now() - value.at > 120_000) throw new Error('Invalid store export read');
      value.busy = true; value.at = Date.now();
      try {
        const next = await value.iterator.next();
        if (this.exportStores.get(p.id) !== value) throw new Error('Store export closed');
        if (next.done) { this.exportStores.delete(p.id); return { done: true }; }
        if (!(next.value instanceof Uint8Array) || !next.value.length || next.value.length > 1024 * 1024) throw new Error('Invalid store export chunk');
        return { done: false, bytes: next.value };
      } catch (error) {
        this.exportStores.delete(p.id); await value.iterator.return?.().catch(() => {}); throw error;
      } finally { value.busy = false; value.at = Date.now(); }
    });
    handle('project.storeExportClose', async (p) => {
      await this.actor(p.attachment);
      const value = this.exportStores.get(p.id);
      if (!value) return;
      if (value.attachment !== p.attachment) throw new Error('Wrong store export attachment');
      this.exportStores.delete(p.id); await value.iterator.return?.();
    });
    handle('project.exportDocOpen', async (p) => {
      const actor = await this.actor(p.attachment);
      for (const [id, value] of this.exportDocs) if (Date.now() - value.at > 60_000) this.exportDocs.delete(id);
      if (this.exportDocs.size >= 2) throw new Error('Too many active document exports');
      const loaded = actor.runtime.model.getLoadedDoc(p.docId);
      const bytes = loaded ? Y.encodeStateAsUpdate(loaded) : Y.mergeUpdates(await actor.store.load(p.docId));
      const id = crypto.randomUUID();
      this.exportDocs.set(id, { attachment: p.attachment, bytes, at: Date.now() });
      return { id, size: bytes.length };
    });
    handle('project.exportDocRead', async (p) => {
      await this.actor(p.attachment);
      const value = this.exportDocs.get(p.id);
      if (!value || value.attachment !== p.attachment || !Number.isSafeInteger(p.offset) || p.offset < 0) throw new Error('Invalid export read');
      const bytes = value.bytes.slice(p.offset, p.offset + 1024 * 1024);
      if (p.offset + bytes.length >= value.bytes.length) this.exportDocs.delete(p.id);
      return bytes;
    });
    handle("project.metaSet", async (p) => {
      if (!["mirrorBase"].includes(p.key) && !/^recovery:(record|content|index):[a-z0-9:-]+$/.test(p.key) && !/^restore:pending:[a-zA-Z0-9-]{1,100}$/.test(p.key)) throw new Error("metadata key not allowed");
      await (await this.actor(p.attachment)).store.setMeta(p.key, p.value);
    });
    handle("project.merge", async (p) =>
      (await this.actor(p.attachment)).runtime.fork.mergeIn(p.files),
    );
    handle("project.folderConflict", async (p) =>
      (await this.actor(p.attachment)).runtime.fork.recordTextConflict(p.conflict),
    );
    handle("project.presence", async (p) =>
      (await this.actor(p.attachment)).runtime.mesh.awareness.setLocalState(p.state),
    );
    handle("mesh.app", async (p) => {
      const r = (await this.actor(p.attachment)).runtime;
      if (!["gh-cap"].includes(p.topic))
        throw new Error("application topic not allowed");
      if (p.deviceId) await r.mesh.sendApp(p.deviceId, p.topic, p.body);
      else r.mesh.broadcastApp(p.topic, p.body);
    });
    handle("mesh.reconcile", async (p) =>
      (await this.actor(p.attachment)).runtime.mesh.awaitComplete(p.options ?? {}),
    );
    handle('mesh.reconcileDoc', async (p) => (await this.actor(p.attachment)).runtime.mesh.reconcile(p.docId, { timeoutMs: p.timeoutMs ?? 8000 }));
    handle("mesh.openDoc", async (p) =>
      (await this.actor(p.attachment)).runtime.mesh.openDoc(p.docId),
    );
    handle("blob.read", async (p) => {
      const a = await this.actor(p.attachment);
      const store = a.store as Persistence & Partial<NativePersistence>;
      const range = await store.readBlobRange?.(p.hash, p.offset ?? 0, 1024 * 1024);
      if (range) return range;
      const bytes = await a.runtime.blobs.fetch(p.hash, p.timeoutMs ?? 8000);
      return {
        total: bytes.length,
        bytes: bytes.slice(p.offset ?? 0, (p.offset ?? 0) + 1024 * 1024),
      };
    });
    handle('blob.has', async (p) => (await (await this.actor(p.attachment)).store.listBlobs()).includes(p.hash));
    handle('blob.held', async (p) => (await this.actor(p.attachment)).store.listBlobs());
    handle('blob.begin', async (p) => {
      const actor = await this.actor(p.attachment);
      if (!this.writableBlob(actor, p.attachment)) throw new Error('denied');
      if (typeof p.hash !== 'string' || !/^[0-9a-f]{64}$/.test(p.hash) || !Number.isSafeInteger(p.size)
        || p.size <= 0 || p.size > MAX_BLOB_BYTES) throw new Error('invalid blob');
      if (this.uploads.size >= 4) throw new Error('upload limit');
      const store = actor.store as Persistence & Partial<StagedBlobStore>;
      if (!store.stageBlobChunk || !store.commitBlobUpload || !store.abortBlobUpload) throw new Error('staging unavailable');
      const id = crypto.randomUUID();
      this.uploads.set(id, { attachment: p.attachment, actor, store: store as StagedBlobStore,
        hash: p.hash, size: p.size, received: 0, part: 0, busy: false });
      return id;
    });
    handle('blob.chunk', async (p) => {
      const u = await this.upload(p.attachment, p.upload);
      if (!(p.bytes instanceof Uint8Array) || !p.bytes.length || p.bytes.length > 1024 * 1024
        || p.part !== u.part || u.received + p.bytes.length > u.size) throw new Error('invalid blob chunk');
      u.busy = true;
      try {
        u.work = u.store.stageBlobChunk(p.upload, u.hash, u.size, u.part, p.bytes);
        await u.work;
        if (this.uploads.get(p.upload) !== u || !this.writableBlob(u.actor, p.attachment)) {
          await u.store.abortBlobUpload(p.upload);
          throw new Error('denied');
        }
        u.received += p.bytes.length; u.part++;
      } finally { u.busy = false; }
    });
    handle('blob.commit', async (p) => {
      const u = await this.upload(p.attachment, p.upload);
      if (u.received !== u.size) throw new Error('incomplete blob');
      u.busy = true;
      try {
        u.work = u.store.commitBlobUpload(p.upload);
        await u.work;
        await u.actor.runtime.blobs.announceStored(u.hash, () => this.uploads.get(p.upload) === u && this.writableBlob(u.actor, p.attachment));
        return u.hash;
      } finally {
        this.uploads.delete(p.upload);
        await u.store.abortBlobUpload(p.upload).catch(() => {});
      }
    });
    handle('blob.abort', async (p) => {
      const u = this.uploads.get(p.upload);
      if (!u) return;
      if (u.attachment !== p.attachment) throw new Error('invalid upload');
      this.uploads.delete(p.upload);
      await u.work?.catch(() => {});
      await u.store.abortBlobUpload(p.upload);
    });
    handle("blob.add", async (p) => {
      const a = await this.actor(p.attachment);
      if (a.runtime.role === "viewer" || a.runtime.revoked) throw new Error("denied");
      return a.runtime.blobs.add(p.bytes, () => a.runtime.role !== 'viewer' && !a.runtime.revoked
        && !this.blocked && this.attachments.has(p.attachment));
    });
  }
}
