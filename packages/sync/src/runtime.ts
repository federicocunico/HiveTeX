import type { StoredDeviceKeys } from '@hivetex/crypto';
import { type DoorbellInfo, ROOT_DOC_ID, type Role, type TicketClaims, type TrustedKey } from '@hivetex/protocol';
import { BlobManager } from './blobs.js';
import { ChangeLog } from './changelog.js';
import { type Candidate, ConnectionManager, type IceConfig, type ManagerOptions, type PeerRoute, type WebSocketLike } from './connect.js';
import { Doorbell, ntfyChannel, type PushChannel, type PushState } from './doorbell.js';
import { forkMeshOptions, listenForkStatus, type MergeConflict, type MergeReport, OfflineFork } from './fork.js';
import { Mesh, type MeshOptions } from './mesh.js';
import { ProjectModel } from './model.js';
import type { Persistence } from './persistence.js';
import type { RtcFactory } from './rtc.js';
import { type SyncEvent, type SyncOutcome, type SyncSnapshot, SyncTracker } from './sync-status.js';

/**
 * The synchronization actor of one project on this device (D2): model, offline fork, mesh, blobs, sync tracker, change
 * log, connection manager, identity/ticket recovery and the doorbell. Framework-neutral: no DOM, storage, toast, Svelte
 * or Tauri imports. Everything environment-specific comes in through `ProjectRuntimeOptions` (browser adapters today,
 * the desktop worker's adapters later). Foreground services (compiler, backup, folder mirror) attach to it from outside.
 */

export interface TicketAnswer {
  ticket: string;
  expiresAt: number;
  epoch?: number;
  githubRepo?: string | null;
  doorbell?: DoorbellInfo;
  /** Server rollout switches for desktop background seeding and router port mapping (absent: both on). */
  features?: { background?: boolean; upnp?: boolean };
}

export interface RuntimeAdapters {
  /** Registers this device's keys with the control plane; resolves its device id. */
  registerDevice(): Promise<string>;
  loadTrusted(): Promise<TrustedKey[]>;
  fetchTicket(deviceId: string): Promise<TicketAnswer>;
  ring(deviceId: string): Promise<{ url: string; topic: string; token: string }>;
  iceServers(): Promise<unknown[] | IceConfig>;
  signalUrl: string;
  wsFactory: (url: string) => WebSocketLike;
  /** Chosen when the manager starts (the desktop decides between browser and native RTC then). */
  rtcFactory: () => RtcFactory;
  /** Defaults to `new ConnectionManager(o)` (tests inject fakes). */
  createManager?: (o: ManagerOptions) => ConnectionManager;
  /** Defaults to ntfy over fetch. */
  pushChannel?: (url: string) => PushChannel;
  /** Persists trusted keys for the next offline start (an optimisation only). */
  saveTrusted?: (keys: TrustedKey[]) => void;
}

export interface RuntimeEvents {
  /** Any observable field changed (UI layers copy what they show). */
  change?: () => void;
  syncEvent?: (e: SyncEvent, snapshot: SyncSnapshot) => void;
  mergeReport?: (r: MergeReport) => void;
  role?: (role: Role) => void;
  deviceId?: (id: string) => void;
  /** Every accepted ticket answer (the session records the owner-authorized GitHub binding from it). */
  ticket?: (answer: TicketAnswer) => void;
}

export interface ProjectRuntimeOptions {
  projectId: string;
  /** A local-only project never talks to a server (local mode). */
  isLocal: boolean;
  role: Role;
  /** The project was made on this device: it authors its own file table. */
  createdHere: boolean;
  store: Persistence;
  keys: StoredDeviceKeys;
  /** The control plane's id for these keys, or null when not registered yet (an `offline-*` id is used meanwhile). */
  deviceId: string | null;
  /** Keys cached from an earlier start; verification works with them until fresh ones are loaded. */
  trusted?: TrustedKey[];
  canWrite: () => boolean;
  adapters: RuntimeAdapters;
  events?: RuntimeEvents;
  mesh?: Partial<Pick<MeshOptions, 'epochGraceMs' | 'now'>>;
  /** Ticket loop retry delay while the control plane is unreachable (default 15 s). */
  retryMs?: number;
  randomId?: () => string;
  zeroIdle?: boolean;
  /** Device-wide background transfer budgets shared by every runtime of the worker (D8). */
  transfers?: { scheduler: import('./transfer-budget.js').TransferScheduler; foreground: () => boolean };
}

export interface PeerSummary {
  dev: string;
  uname: string;
  role: Role;
  route: PeerRoute;
  limited: string | null;
  /** Advisory awareness from updated clients; absence means an ordinary/older client. */
  seed?: boolean;
}

/** Decodes a JWS payload without verifying it (own tickets only: role, epoch and expiry for scheduling). */
export function decodeTicketClaims(ticket: string): TicketClaims | null {
  try {
    const part = ticket.split('.')[1] ?? '';
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as TicketClaims;
  } catch {
    return null;
  }
}

export class ProjectRuntime {
  model!: ProjectModel;
  mesh!: Mesh;
  blobs!: BlobManager;
  fork!: OfflineFork;
  tracker!: SyncTracker;
  changelog!: ChangeLog;

  role: Role;
  offline = false;
  revoked = false;
  authRequired = false;
  paused = false;
  saveFailing = false;
  unsharedWork = false;
  mergeError: unknown = null;
  conflicts: MergeConflict[] = [];
  syncStatus: SyncSnapshot | null = null;
  connecting: Candidate[] = [];
  peers: PeerSummary[] = [];
  doorbellState: PushState = 'off';

  /**
   * The ticket authority's public keys: one array for the whole runtime, the mesh and the connection manager verify
   * against this very object, so keys loaded after an offline start reach them without rebuilding anything.
   */
  readonly trusted: TrustedKey[] = [];
  private trustedLoaded = false;
  private loadingTrusted: Promise<void> | null = null;
  private registered: boolean;
  private registering: Promise<void> | null = null;
  private devId: string;
  private ticket = '';
  private ticketTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every ticket request, pause and close: only the latest, still-wanted request may act on its answer. */
  private ticketSeq = 0;
  /** No renewal was scheduled because nobody needed the ticket (alone, no socket): renew when a peer appears. */
  private ticketDormant = false;
  private manager: ConnectionManager | null = null;
  private bell: Doorbell | null = null;
  private bellOff: (() => void) | null = null;
  private bellWatch: (() => void) | null = null;
  private doorbellInfo: DoorbellInfo | null = null;
  private disposed = false;
  private pendingRing = false;
  private presenceChanged = () => this.refreshPeers();

  constructor(private o: ProjectRuntimeOptions) {
    this.role = o.role;
    this.registered = !!o.deviceId;
    // A temporary id until registered: nothing is ever requested from the control plane with it.
    this.devId = o.deviceId || `offline-${(o.randomId ?? (() => crypto.randomUUID()))()}`;
    this.trusted.push(...(o.trusted ?? []));
  }

  get deviceId() {
    return this.devId;
  }
  get currentTicket() {
    return this.ticket;
  }
  get managerDiagnostics() {
    return { candidates: this.manager?.candidates() ?? [], stages: this.manager?.diagnostics() ?? {}, socketOpen:this.manager?.socketOpen ?? false, doorbellMode:this.manager?.doorbellMode ?? false, answers:this.manager?.stats?.answers ?? 0 };
  }

  private extra = new Set<RuntimeEvents>();
  private listeners(): RuntimeEvents[] {
    return this.o.events ? [this.o.events, ...this.extra] : [...this.extra];
  }
  /** More observers (several editor attachments, the background dashboard). Returns the unsubscribe function. */
  listen(events: RuntimeEvents) {
    this.extra.add(events);
    return () => void this.extra.delete(events);
  }

  private emit() {
    for (const l of this.listeners()) l.change?.();
  }

  /** Builds the replica and starts recovering identity and connectivity in the background. */
  async open() {
    const { store } = this.o;
    this.model = new ProjectModel(store);
    await this.model.init();
    if (this.o.isLocal || this.o.createdHere) this.model.markComplete(ROOT_DOC_ID);
    this.model.onSaveState((st) => {
      this.saveFailing = st.failing;
      this.emit();
    });
    this.changelog = new ChangeLog({ model: this.model, store });
    this.changelog.start();

    // Before the mesh exists, so a local edit made before any link is already recorded as unshared work.
    this.fork = new OfflineFork({
      model: this.model,
      canEdit: () => this.o.canWrite(),
      enabled: () => !this.o.isLocal,
      onReport: (r) => { for (const l of this.listeners()) l.mergeReport?.(r); },
      onError: (e) => {
        this.mergeError = e;
        this.emit();
      },
      onChange: () => {
        this.unsharedWork = this.fork.active;
        if (!this.fork.active) this.mergeError = null;
        this.conflicts = [...this.fork.conflicts];
        this.emit();
      },
      ...forkMeshOptions(
        () => this.mesh,
        () => this.devId,
      ),
    });
    await this.fork.start();
    this.unsharedWork = this.fork.active;
    this.conflicts = [...this.fork.conflicts];

    this.mesh = new Mesh({
      projectId: this.o.projectId,
      model: this.model,
      keys: this.o.keys,
      trusted: this.trusted,
      getTicket: () => this.ticket,
      beforeSync: (peer) => this.fork.beforeSync(peer),
      // a failed preparation closes that link's document exchange; the next link tries again
      onSyncGateError: (_peer, e) => {
        this.mergeError = e;
        this.emit();
      },
      ...this.o.mesh,
    });
    this.blobs = new BlobManager(this.mesh, store);
    listenForkStatus(this.mesh, this.fork);
    this.mesh.onPeerJoin(() => {
      this.refreshPeers();
      if (this.ticketDormant) void this.refreshTicketLoop();
    });
    // A peer revealed a newer membership epoch (someone was removed or demoted): get a fresh ticket right away.
    this.mesh.onEpochAdvance((e) => {
      if (this.ticketEpoch() < e) void this.refreshTicketLoop();
    });
    this.mesh.onPeerLeave(() => this.refreshPeers());
    this.mesh.awareness.on('change', this.presenceChanged);
    this.tracker = new SyncTracker({
      mesh: this.mesh,
      model: this.model,
      store,
      blobs: this.blobs,
      connecting: () => this.connecting.length,
      offline: () => this.offline || this.paused,
      ...(this.o.transfers ? { transfers: { ...this.o.transfers, project: this.o.projectId } } : {}),
    });
    this.tracker.onChange((snap) => {
      this.syncStatus = snap;
      this.emit();
    });
    this.tracker.onEvent((e) => { for (const l of this.listeners()) l.syncEvent?.(e, this.tracker.snapshot); });
    this.tracker.start();
    if (this.o.isLocal) this.offline = true;
  }

  /** Starts the ticket loop (and with it peer discovery). A local project never does. */
  startNetworking() {
    // Several workspaces may share the runtime: the first one starts it.
    if (this.networking || this.o.isLocal) return;
    this.networking = true;
    void this.refreshTicketLoop();
  }
  private networking = false;
  private networkAvailable = true;

  /** The network is back (the platform says so): do not wait for the retry timer. */
  networkRestored() {
    this.networkAvailable = true;
    if (this.disposed || this.paused || this.o.isLocal) return;
    if (this.offline) void this.refreshTicketLoop();
    else if (this.mesh.peers.length) {
      for (const p of this.mesh.peers) p.conn.close();
      this.manager?.reconnectNow();
    }
  }
  networkLost() {
    this.networkAvailable = false; this.offline = true; ++this.ticketSeq;
    if (this.ticketTimer) clearTimeout(this.ticketTimer); this.ticketTimer = null;
    this.manager?.stop(); this.manager = null; this.connecting = [];
    for (const p of this.mesh.peers) p.conn.close();
    this.emit();
  }

  /** Fetch a fresh ticket now (e.g. right after the owner changed roles, so peers learn the new epoch). */
  refreshTicketNow() {
    return this.refreshTicketLoop();
  }
  /** A verified ring can wake a cold catalog actor; it obtains current authorization before answering. */
  async wakeOnRing() {
    if (this.o.isLocal || this.paused || this.disposed) return;
    this.networking = true;
    this.pendingRing = true;
    await this.ensureTicket();
    this.answerPendingRing();
  }
  private answerPendingRing() {
    if (!this.pendingRing || !this.manager || this.doorbellState !== 'subscribed' || !this.ticketUsable()
      || this.paused || this.disposed || this.revoked) return;
    this.pendingRing = false;
    this.manager.answerRing();
  }

  private ticketEpoch() {
    return decodeTicketClaims(this.ticket)?.ep ?? 0;
  }

  /** Registers this device when the control plane does not know it yet. Concurrent callers share one request. */
  private registerDevice(): Promise<void> {
    this.registering ??= (async () => {
      try {
        const id = await this.o.adapters.registerDevice();
        if (this.disposed) return;
        this.registered = true;
        if (id !== this.devId) {
          this.devId = id;
          for (const l of this.listeners()) l.deviceId?.(id);
        }
      } finally {
        this.registering = null;
      }
    })();
    return this.registering;
  }

  /** Loads the trusted ticket keys in place (see `trusted`). Concurrent callers share one request. */
  private loadTrusted(): Promise<void> {
    this.loadingTrusted ??= (async () => {
      try {
        const keys = await this.o.adapters.loadTrusted();
        if (this.disposed) return;
        this.trusted.splice(0, this.trusted.length, ...keys);
        this.trustedLoaded = true;
        this.o.adapters.saveTrusted?.(keys);
      } finally {
        this.loadingTrusted = null;
      }
    })();
    return this.loadingTrusted;
  }

  ticketUsable() {
    const exp = decodeTicketClaims(this.ticket)?.exp;
    return !!exp && exp * 1000 > Date.now() + 30_000;
  }

  private async refreshTicketLoop() {
    // A local project never talks to a server; a closed or paused runtime makes no requests.
    if (this.disposed || this.paused || this.o.isLocal || !this.networkAvailable) return;
    if (this.ticketTimer) clearTimeout(this.ticketTimer);
    this.ticketTimer = null;
    const seq = ++this.ticketSeq;
    /** False once the runtime closed or paused, or a newer request took over: the answer is then dropped. */
    const current = () => !this.disposed && !this.paused && seq === this.ticketSeq;
    let next = this.o.retryMs ?? 15_000;
    let stage: 'identity' | 'ticket' = 'identity';
    try {
      // Each missing part is recovered on its own; a failure of one never replaces or discards the others.
      if (!this.registered) await this.registerDevice();
      if (!this.trustedLoaded) {
        // Keys cached from earlier still verify tickets; without any, nothing can be verified yet.
        await this.loadTrusted().catch((e) => {
          if (this.trusted.length === 0) throw e;
        });
      }
      if (!current()) return;
      stage = 'ticket';
      const r = await this.o.adapters.fetchTicket(this.devId);
      if (!current()) return;
      if (r.doorbell) this.useDoorbell(r.doorbell, r.epoch ?? 0);
      const first = !this.ticket;
      this.ticket = r.ticket;
      const claims = decodeTicketClaims(r.ticket);
      if (claims && claims.role !== this.role) {
        this.role = claims.role;
        for (const l of this.listeners()) l.role?.(this.role);
      }
      this.revoked = false;
      this.authRequired = false;
      for (const l of this.listeners()) l.ticket?.(r);
      this.offline = false;
      if (first || !this.manager) this.startManager();
      if (!first) void this.mesh.refreshOwnTicket(r.ticket);
      next = Math.max(30_000, r.expiresAt - Date.now() - 3 * 60_000);
    } catch (e) {
      if (!current()) return;
      const status = (e as { status?: number }).status;
      this.authRequired = status === 401;
      // Only a refusal of the ticket request itself (for a registered device) means the access was withdrawn: a
      // failure while registering or loading keys is just the control plane being out of reach.
      if (stage === 'ticket' && (status === 403 || status === 404)) {
        this.role = 'viewer';
        this.revoked = true;
        this.manager?.stop(); this.manager = null;
        this.connecting = [];
        this.bellOff?.(); this.bellOff = null;
        this.doorbellInfo = null; this.doorbellState = 'off';
        for (const peer of this.mesh.peers) peer.conn.close();
        for (const l of this.listeners()) l.role?.(this.role);
        next = 60_000;
      } else this.offline = true;
    }
    // Zero idle cost (D14): alone and without a socket nobody needs a fresh ticket; it is fetched again before the next
    // introduction (ensureTicket) or as soon as a peer connects.
    this.ticketDormant = Boolean(this.manager?.doorbellMode && this.mesh.peers.length === 0 && !this.manager.socketOpen && this.ticketUsable());
    if (current() && !this.ticketDormant) this.ticketTimer = setTimeout(() => void this.refreshTicketLoop(), next);
    this.emit();
  }

  /** Registers (or moves, after an epoch change) this project's ring topic. */
  private useDoorbell(info: DoorbellInfo, epoch: number) {
    if (this.doorbellInfo?.topic === info.topic && this.doorbellInfo.url === info.url && this.bell) return;
    this.doorbellInfo = info;
    this.bell ??= new Doorbell({ channel: this.o.adapters.pushChannel ?? ((url) => ntfyChannel(url)), trusted: () => this.trusted });
    this.bellOff?.();
    this.bellOff = this.bell.register(this.o.projectId, info, epoch, () => this.manager?.answerRing());
    this.bellWatch ??= this.bell.onState(() => {
      this.doorbellState = this.bell?.state(this.o.projectId) ?? 'off';
      this.manager?.setDoorbellAvailable(this.doorbellState === 'subscribed');
      this.answerPendingRing();
      this.emit();
    });
  }

  /** Asks the server for a ring token and publishes it: dormant devices of this project come online for us. */
  private async ringProject(): Promise<boolean> {
    const bell = this.bell;
    if (!bell || !this.doorbellInfo || this.paused || this.disposed) return false;
    try {
      const r = await this.o.adapters.ring(this.devId);
      await bell.ring({ url: r.url, topic: r.topic }, r.token);
      return true;
    } catch {
      return false; // rate-limited or unreachable: the introduction still runs for devices already online
    }
  }

  /** Before an introduction socket opens: a ticket that lapsed while dormant is fetched again. */
  private async ensureTicket() {
    if (this.ticketUsable()) return;
    await this.refreshTicketLoop();
    if (!this.ticketUsable()) throw new Error('no usable ticket');
  }

  /** Manual offline mode: stop talking to anyone (push service included), keep editing locally, merge on reconnect. */
  setPaused(p: boolean) {
    this.paused = p;
    this.tracker?.touch();
    if (p) {
      this.pendingRing = false;
      this.ticketSeq++;
      if (this.ticketTimer) clearTimeout(this.ticketTimer);
      this.ticketTimer = null;
      this.manager?.stop();
      this.manager = null;
      this.connecting = [];
      this.bellOff?.();
      this.bellOff = null;
      this.doorbellInfo = null;
      this.doorbellState = 'off';
      for (const peer of this.mesh.peers) peer.conn.close();
    } else {
      if (this.ticketUsable()) this.startManager();
      void this.refreshTicketLoop();
    }
    this.emit();
  }

  private startManager() {
    if (this.manager || this.paused || this.disposed || !this.registered || !this.ticket) return;
    const a = this.o.adapters;
    const options: ManagerOptions = {
      ...(this.o.zeroIdle ? { zeroIdle: true } : {}),
      mesh: this.mesh,
      projectId: this.o.projectId,
      keys: this.o.keys,
      trusted: this.trusted,
      getTicket: () => this.ticket,
      signalUrl: a.signalUrl,
      wsFactory: a.wsFactory,
      rtcFactory: a.rtcFactory(),
      // The answer carries the relay credentials' expiry: the manager refreshes them before they run out.
      getIceServers: () => a.iceServers(),
      ...(this.doorbellInfo ? { doorbell: { ring: () => this.ringProject() }, ensureTicket: () => this.ensureTicket() } : {}),
    };
    const manager = (a.createManager ?? ((o) => new ConnectionManager(o)))(options);
    this.manager = manager;
    manager.setDoorbellAvailable(this.doorbellState === 'subscribed');
    manager.onState(() => {
      if (this.manager !== manager) return;
      this.connecting = manager.candidates();
      this.refreshPeers(); // routes change without a join (relay limits, TURN detected, handover)
      this.tracker?.touch();
      if (manager.doorbellMode && this.mesh.peers.length === 0 && !manager.socketOpen && this.ticketUsable()) {
        this.ticketDormant = true;
        if (this.ticketTimer) clearTimeout(this.ticketTimer);
        this.ticketTimer = null;
      }
    });
    manager.start();
    this.answerPendingRing();
  }

  /**
   * "Sync now": retry the connection to co-authors that are online, ask every connected peer again for every file and
   * fetch what is missing. Null when offline or paused (nothing is attempted).
   */
  async syncNow(): Promise<{ outcome: SyncOutcome; snapshot: SyncSnapshot } | null> {
    if (this.paused || this.offline) return null;
    this.manager?.reconnectNow();
    // Queued requests or silence are "pending", never success, and the sync time only advances on success.
    const outcome = await this.tracker.syncNow();
    const snapshot = await this.tracker.refresh();
    return { outcome, snapshot };
  }

  private refreshPeers() {
    const routes = this.manager?.routes() ?? {};
    this.peers = this.mesh.peers.map((p) => ({
      dev: p.deviceId,
      uname: p.claims.uname,
      role: p.claims.role,
      route: routes[p.deviceId]?.route ?? 'direct',
      limited: routes[p.deviceId]?.limited ?? null,
      seed: [...this.mesh.awareness.getStates().values()].some(
        (state) => state.deviceId === p.deviceId && state.seed === true,
      ),
    }));
    this.emit();
  }

  /** Stops networking and timers, then releases the replica. Pending edits are flushed by `model.destroy()`. */
  async close() {
    if (this.disposed) return;
    this.disposed = true;
    this.ticketSeq++;
    if (this.ticketTimer) clearTimeout(this.ticketTimer);
    this.ticketTimer = null;
    this.bellWatch?.();
    this.bellOff?.();
    this.bell?.close();
    this.manager?.stop();
    this.manager = null;
    this.tracker?.stop();
    this.changelog?.stop();
    this.fork?.stop();
    this.mesh?.awareness.off('change', this.presenceChanged);
    this.mesh?.destroy();
  }
}
