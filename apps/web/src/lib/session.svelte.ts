import {
  CompileClient,
  CompileLeader,
  type CompileEngine,
  type CompileResult,
  Election,
  NativeEngine,
  SystemMonitor,
  type SystemProbe,
  measurePerformance,
  parseSyncTeXGz,
  type SyncIndex,
} from '@p2platex/compile';
import type { Role, TicketClaims, TrustedKey } from '@p2platex/protocol';
import {
  BlobManager,
  ConnectionManager,
  MirrorSync,
  type FileEntry,
  IndexedDbPersistence,
  Mesh,
  ProjectModel,
  type RtcFactory,
  type WebSocketLike,
  tauriRtcFactory,
  sha256Hex,
} from '@p2platex/sync';
import { BackupAgent, GitHubClient, importRepo, type Binding } from '@p2platex/github';
import { api, isDesktop, wsBase } from './api.js';
import { applyImport, planFor } from './import/apply.js';
import { classify } from './import/classify.js';
import type { ApplyChoices, ApplyResult, ImportPlan } from './import/plan.js';
import type { ImportBundle } from './import/sources.js';
import { getGithubToken } from './github.js';
import { ensureRegistered } from './keys.js';

export interface ProjectInfo {
  id: string;
  slug: string;
  role: Role;
  defaultRole: string;
  passwordProtected: boolean;
  githubRepo?: string | null;
  epoch: number;
}

export interface PeerView {
  dev: string;
  uname: string;
  role: Role;
}

type TauriInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function decodeClaims(ticket: string): TicketClaims | null {
  try {
    const p = ticket.split('.')[1] ?? '';
    return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))) as TicketClaims;
  } catch {
    return null;
  }
}

/** Everything that belongs to one open project on this device. UI reads the reactive fields. */
export class ProjectSession {
  files = $state<FileEntry[]>([]);
  peers = $state<PeerView[]>([]);
  role = $state<Role>('viewer');
  leaderName = $state<string | null>(null);
  amLeader = $state(false);
  connected = $state(false);
  noPeerOnline = $state(true);
  compileStatus = $state<'idle' | 'compiling' | 'ok' | 'error'>('idle');
  result = $state<CompileResult | null>(null);
  pdf = $state<Uint8Array | null>(null);
  pdfRev = $state(0);
  stale = $state(true);
  syncIndex = $state<SyncIndex | null>(null);
  engineKind = $state<'native' | 'wasm' | 'none'>('none');
  engineNote = $state('');
  compiledBy = $state<string | null>(null);
  offline = $state(false);

  model!: ProjectModel;
  mesh!: Mesh;
  blobs!: BlobManager;
  election!: Election;
  leader!: CompileLeader;
  client!: CompileClient;
  engine: CompileEngine | null = null;

  get myDeviceId() {
    return this.deviceId;
  }

  private ticket = '';
  private ticketTimer: ReturnType<typeof setTimeout> | null = null;
  private manager: ConnectionManager | null = null;
  private trusted: TrustedKey[] = [];
  store!: IndexedDbPersistence;
  private disposed = false;
  private deviceId = '';
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private keys!: Awaited<ReturnType<typeof ensureRegistered>>['keys'];

  constructor(
    readonly project: ProjectInfo,
    private user: { id: string; username: string },
  ) {
    this.role = project.role;
  }

  async open() {
    this.store = await IndexedDbPersistence.open(`p2platex-project-${this.project.id}`);
    this.model = new ProjectModel(this.store);
    await this.model.init();
    this.refreshFiles();
    this.model.onFilesChanged(() => this.refreshFiles());

    let reg: Awaited<ReturnType<typeof ensureRegistered>> | null = null;
    try {
      reg = await ensureRegistered(this.user.id, navigator.userAgent.slice(0, 48));
      const k = await api<{ keys: TrustedKey[] }>('GET', '/keys');
      this.trusted = k.keys;
      sessionStorage.setItem('p2platex.trusted', JSON.stringify(this.trusted));
    } catch {
      this.offline = true;
      try {
        this.trusted = JSON.parse(sessionStorage.getItem('p2platex.trusted') ?? '[]');
      } catch {
        this.trusted = [];
      }
      // Offline-first: work locally with a throwaway identity until the control plane is reachable.
      const { generateDeviceKeys } = await import('@p2platex/crypto');
      reg = { keys: await generateDeviceKeys(), deviceId: `offline-${crypto.randomUUID()}` };
    }
    this.keys = reg.keys;
    this.deviceId = reg.deviceId;

    this.mesh = new Mesh({
      projectId: this.project.id,
      model: this.model,
      keys: this.keys,
      trusted: this.trusted,
      getTicket: () => this.ticket,
      // test hook only: shortens the revocation grace period in end-to-end tests
      ...(Number(localStorage.getItem('p2platex.epochGraceMs')) ? { epochGraceMs: Number(localStorage.getItem('p2platex.epochGraceMs')) } : {}),
    });
    this.blobs = new BlobManager(this.mesh, this.store);
    this.mesh.onPeerJoin(() => this.refreshPeers());
    // A peer revealed a newer membership epoch (someone was removed or demoted): get a fresh ticket right away.
    this.mesh.onEpochAdvance((e) => {
      if (this.ticketEpoch() < e) void this.refreshTicketLoop();
    });
    this.mesh.onPeerLeave(() => this.refreshPeers());
    this.mesh.awareness.setLocalStateField('user', { name: this.user.username, ...colorFor(this.user.username) });

    await this.setupCompile();
    this.backup = new BackupAgent({
      mesh: this.mesh,
      model: this.model,
      blobs: this.blobs,
      self: { dev: this.deviceId, uname: this.user.username },
      getRole: () => this.role,
      getToken: () => getGithubToken(),
      // Only the owner-recorded repository (control plane) is ever pushed to.
      authorizedBinding: () => this.project.githubRepo ?? null,
      extraFiles: async () => (this.pdf ? new Map([[`${String(this.model.settings.get('main') ?? 'main.tex').replace(/\.tex$/, '')}.pdf`, this.pdf]]) : new Map()),
    });
    this.backup.statusCbs.add(() => {
      this.backupTick++;
      // An owner on another device just changed the binding: refresh the authoritative copy (throttled).
      if (this.backup?.bindingMismatch) void this.refreshAuthorizedBinding();
    });
    this.backup.start();
    this.dedupeTimer = undefined;
    this.model.onFilesChanged(() => this.scheduleDedupe());
    const savedDir = isDesktop ? localStorage.getItem(`p2platex.mirror.${this.project.id}`) : null;
    if (savedDir) await this.bindFolder(savedDir).catch((e) => (this.mirrorNotice = `Could not re-open the linked folder: ${e instanceof Error ? e.message : e}`));
    this.model.onDocUpdate(() => {
      this.stale = true;
      this.scheduleSnapshot();
      this.scheduleStaleCheck();
    });
    void this.refreshTicketLoop();
    // Persist pending edits when the tab is hidden or closed (writes are normally batched every 250 ms).
    this.flushHandler = () => void this.model.flush();
    window.addEventListener('pagehide', this.flushHandler);
    document.addEventListener('visibilitychange', this.flushHandler);
  }
  private flushHandler: (() => void) | null = null;
  private dedupeTimer: ReturnType<typeof setTimeout> | undefined;

  /** After merging with peers, drop identical duplicate files (e.g. the same GitHub backup imported twice). */
  private scheduleDedupe() {
    if (!this.canWrite) return;
    clearTimeout(this.dedupeTimer);
    this.dedupeTimer = setTimeout(() => void this.model.dedupeIdentical().catch(() => {}), 2500);
  }

  /** The bound GitHub repository (shared project setting), if any. */
  get githubBinding(): Binding | null {
    void this.backupTick;
    return this.backup?.binding ?? null;
  }

  async linkGithub(repoFull: string, branch: string, create = false) {
    if (!this.backup) throw new Error('Not ready');
    const token = await getGithubToken();
    if (!token) throw new Error('Connect GitHub first');
    const client = new GitHubClient(token);
    let [owner, repo] = repoFull.split('/') as [string, string];
    if (create) {
      const r = await client.createRepo(repoFull.includes('/') ? (repo as string) : repoFull, true);
      [owner, repo] = r.full_name.split('/') as [string, string];
    } else {
      await client.repo({ owner, repo }); // verifies access
    }
    // Control plane first: it is the authority the backup writer checks before pushing.
    await api('PATCH', `/projects/${this.project.id}`, { githubRepo: `${owner}/${repo}@${branch}` });
    this.project.githubRepo = `${owner}/${repo}@${branch}`;
    this.backup.setBinding({ repo: { owner, repo }, branch });
    await this.backup.tokenChanged();
  }

  private bindingCheckedAt = 0;
  private async refreshAuthorizedBinding() {
    if (Date.now() - this.bindingCheckedAt < 30_000) return;
    this.bindingCheckedAt = Date.now();
    try {
      const r = await api<{ project: ProjectInfo }>('GET', `/projects/${this.project.id}`);
      this.project.githubRepo = r.project.githubRepo ?? null;
      this.backupTick++;
    } catch {
      /* offline: keep refusing to push until the owner's binding can be confirmed */
    }
  }

  async unlinkGithub() {
    await api('PATCH', `/projects/${this.project.id}`, { githubRepo: null });
    this.project.githubRepo = null;
    this.backup?.setBinding(null);
  }

  /** Loads the last backup from GitHub (used when no collaborator is online). Returns the number of files. */
  async importFromGithub(repoRef: string): Promise<number> {
    if (!this.canWrite) throw new Error('Read-only members cannot import into the project. Ask the owner for editor access, or wait until a collaborator is online.');
    const m = /^([^/]+)\/([^@]+)@(.+)$/.exec(repoRef);
    if (!m) throw new Error('Invalid repository reference');
    const token = await getGithubToken();
    if (!token) throw new Error('Connect GitHub first');
    const files = await importRepo(new GitHubClient(token), { owner: m[1] as string, repo: m[2] as string }, m[3] as string);
    for (const [path, bytes] of files) await this.addFile(path, bytes);
    return files.size;
  }


  // ---- compile wiring ----

  private async setupCompile() {
    let kind: 'native' | 'wasm' | 'none' = 'none';
    let supports: ('pdflatex' | 'xelatex' | 'lualatex')[] = [];
    if (isDesktop) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const native = new NativeEngine(invoke as TauriInvoke, this.project.id);
        if (await native.init()) {
          this.engine = native;
          kind = 'native';
          supports = native.supports;
        } else this.engineNote = 'No TeX installation found. Install TeX Live, MiKTeX or MacTeX to compile on this device.';
      } catch (e) {
        this.engineNote = `Native compiler unavailable: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else {
      const { loadWasmEngine } = await import('./wasm-engine.js');
      const wasm = await loadWasmEngine(this.project.id);
      if (wasm) {
        this.engine = wasm;
        kind = 'wasm';
        supports = wasm.supports;
      } else this.engineNote = 'In-browser compilation needs a TeX package server, which is not reachable. Another collaborator running the desktop app (with TeX installed) will compile for everyone, or set a server in Settings.';
    }
    this.engineKind = kind;

    const power: 'mains' | 'battery' = 'mains';
    const batteryPct = 100;

    const noOptOut = localStorage.getItem('p2platex.compileForOthers') !== '0';
    this.election = new Election(
      this.mesh,
      {
        dev: this.deviceId,
        uname: this.user.username,
        engine: kind,
        supports,
        perf: measurePerformance(),
        power,
        batteryPct,
        load: 0,
        optOut: !noOptOut,
      },
      { engine: () => (String(this.model.settings.get('engine') ?? 'pdflatex') as 'pdflatex'), selfRole: () => this.role },
    );
    this.election.onLeaderChange((l) => this.onLeader(l));
    const engineProxy: CompileEngine = {
      kind,
      supports,
      compile: (input, opts) => {
        this.compileStatus = 'compiling';
        return (this.engine as CompileEngine).compile(input, opts);
      },
    };
    this.leader = new CompileLeader({
      mesh: this.mesh,
      model: this.model,
      blobs: this.blobs,
      election: this.election,
      engine: engineProxy,
      self: { dev: this.deviceId, uname: this.user.username },
    });
    this.client = new CompileClient({ mesh: this.mesh, model: this.model, blobs: this.blobs, election: this.election, leader: this.leader });
    this.client.onChange(() => void this.onCompileChange());
    this.election.start();
    this.onLeader(this.election.leader());
    this.monitor = new SystemMonitor(this.election, () => this.probeSystem());
    this.monitor.start();
  }

  private monitor: SystemMonitor | null = null;

  private async probeSystem(): Promise<SystemProbe> {
    if (isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      const p = await invoke<{ power: 'mains' | 'battery'; battery_pct: number; cpu_load: number }>('probe_system');
      return { power: p.power, batteryPct: p.battery_pct, load: p.cpu_load };
    }
    try {
      const nav = navigator as unknown as { getBattery?: () => Promise<{ charging: boolean; level: number }> };
      const b = await nav.getBattery?.();
      if (b) return { power: b.charging ? 'mains' : 'battery', batteryPct: Math.round(b.level * 100), load: 0 };
    } catch {
      /* Battery API unavailable (Firefox/Safari): assume mains */
    }
    return { power: 'mains', batteryPct: 100, load: 0 };
  }

  private onLeader(l: string | null) {
    this.amLeader = l === this.deviceId;
    const peer = this.mesh.peers.find((p) => p.deviceId === l);
    this.leaderName = this.amLeader ? `${this.user.username} (this device)` : (peer?.claims.uname ?? null);
  }

  private async onCompileChange() {
    const r = this.client.latest;
    if (r) {
      this.result = r;
      this.compileStatus = r.ok ? 'ok' : 'error';
    }
    this.compiledBy = this.client.lastGood?.result.by.uname ?? null;
    const good = this.client.lastGood;
    if (good && good.pdf !== this.pdf) {
      this.pdf = good.pdf;
      this.pdfRev++;
      this.syncIndex = good.synctex ? await parseSyncTeXGz(good.synctex).catch(() => null) : null;
    }
    this.scheduleStaleCheck();
  }

  private scheduleStaleCheck() {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(async () => {
      try {
        this.stale = await this.client.isStale();
      } catch {
        this.stale = true;
      }
    }, 300);
  }

  requestCompile() {
    if (this.amLeader) void this.leader.run();
    else this.client.requestCompile();
    if (this.mesh.peers.length === 0 && this.engine) void this.compileLocal();
  }

  async compileLocal() {
    if (!this.engine) throw new Error(this.engineNote || 'No compiler available on this device');
    this.compileStatus = 'compiling';
    try {
      const r = await this.leader.compileLocally();
      this.result = r.result;
      this.compileStatus = r.result.ok ? 'ok' : 'error';
      if (r.pdf) {
        this.compiledBy = `${this.user.username} (this device)`;
        this.pdf = r.pdf;
        this.pdfRev++;
        this.syncIndex = r.synctex ? await parseSyncTeXGz(r.synctex).catch(() => null) : null;
        this.stale = false;
      }
    } catch (e) {
      this.compileStatus = 'error';
      throw e;
    }
  }

  setCompileForOthers(on: boolean) {
    localStorage.setItem('p2platex.compileForOthers', on ? '1' : '0');
    this.election.update({ optOut: !on });
  }

  // ---- tickets & connectivity ----

  /** Fetch a fresh ticket now (e.g. right after the owner changed roles, so peers learn the new epoch). */
  refreshTicketNow() {
    return this.refreshTicketLoop();
  }

  private ticketEpoch() {
    return decodeClaims(this.ticket)?.ep ?? 0;
  }

  private async refreshTicketLoop() {
    if (this.disposed) return;
    if (this.ticketTimer) clearTimeout(this.ticketTimer);
    let next = 15_000;
    try {
      const r = await api<{ ticket: string; expiresAt: number; githubRepo?: string | null }>('POST', `/projects/${this.project.id}/ticket`, { deviceId: this.deviceId });
      if (r.githubRepo !== undefined) this.project.githubRepo = r.githubRepo;
      const first = !this.ticket;
      this.ticket = r.ticket;
      const claims = decodeClaims(r.ticket);
      if (claims && claims.role !== this.role) {
        this.role = claims.role;
        this.election?.update({}); // leadership eligibility depends on the role (viewers never lead)
      }
      this.offline = false;
      if (first || !this.manager) this.startManager();
      if (!first) this.mesh.refreshOwnTicket(r.ticket);
      next = Math.max(30_000, r.expiresAt - Date.now() - 3 * 60_000);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403 || status === 404) {
        this.role = 'viewer';
        this.revoked = true;
        next = 60_000;
      } else this.offline = true;
    }
    if (!this.disposed) this.ticketTimer = setTimeout(() => void this.refreshTicketLoop(), next);
  }

  revoked = $state(false);

  /** Manual offline mode: stop talking to anyone, keep editing locally, merge on reconnect. */
  paused = $state(false);
  backup: BackupAgent | null = null;
  backupTick = $state(0);
  mirrorDir = $state<string | null>(null);
  mirrorNotice = $state('');
  private mirror: MirrorSync | null = null;
  private mirrorFs: { dispose(): Promise<void> } | null = null;
  setPaused(p: boolean) {
    this.paused = p;
    if (p) {
      this.manager?.stop();
      this.manager = null;
      for (const peer of this.mesh.peers) peer.conn.close();
    } else this.startManager();
  }

  private startManager() {
    if (this.manager || this.paused || !this.deviceId || this.deviceId.startsWith('offline-')) return;
    // Some system webviews (notably WebKitGTK on Linux) lack WebRTC: the desktop app then uses the Rust stack.
    const useRust = isDesktop && (typeof RTCPeerConnection === 'undefined' || localStorage.getItem('p2platex.rtc') === 'rust');
    let rtcFactory: RtcFactory = (ice) => new RTCPeerConnection({ iceServers: ice as RTCIceServer[] }) as unknown as ReturnType<RtcFactory>;
    if (useRust) {
      rtcFactory = (ice) => {
        // The factory is synchronous; the Tauri imports resolve lazily inside the wrapper's async setup.
        const lazy = lazyTauriRtc();
        return lazy(ice);
      };
    }
    this.manager = new ConnectionManager({
      mesh: this.mesh,
      projectId: this.project.id,
      keys: this.keys,
      trusted: this.trusted,
      getTicket: () => this.ticket,
      signalUrl: `${wsBase()}/api/signal`,
      wsFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
      rtcFactory,
      getIceServers: async () => (await api<{ iceServers: unknown[] }>('POST', '/turn', { projectId: this.project.id })).iceServers,
    });
    this.manager.start();
  }

  private refreshPeers() {
    this.peers = this.mesh.peers.map((p) => ({ dev: p.deviceId, uname: p.claims.uname, role: p.claims.role }));
    this.connected = this.peers.length > 0;
    this.noPeerOnline = this.peers.length === 0;
    this.onLeader(this.election?.leader() ?? null);
  }

  // ---- files ----

  private refreshFiles() {
    this.files = this.model.list();
  }

  get canWrite() {
    return this.role === 'owner' || this.role === 'editor';
  }

  async addBinary(path: string, bytes: Uint8Array) {
    const hash = await this.blobs.add(bytes);
    const existing = this.model.find(path);
    if (existing && existing.kind === 'binary') this.model.setBinary(existing.id, hash, bytes.length);
    else this.model.createBinary(path, hash, bytes.length);
  }

  async addFile(path: string, bytes: Uint8Array) {
    const c = classify(path, bytes);
    if (c.kind === 'text') {
      const existing = this.model.find(path);
      if (existing?.kind === 'text') {
        const { applyTextDiff } = await import('@p2platex/sync');
        applyTextDiff(await this.model.openText(existing.id), c.text);
      } else await this.model.createTextNow(path, c.text);
    } else await this.addBinary(path, bytes);
  }

  /** Compares an import with the current tree (see lib/import). */
  planImport(bundle: ImportBundle): Promise<ImportPlan> {
    return planFor(this.model, bundle);
  }

  /** Applies a confirmed import as one coherent change. */
  async applyImport(plan: ImportPlan, choices: ApplyChoices, onProgress?: (done: number, total: number) => void): Promise<ApplyResult> {
    if (!this.canWrite) throw new Error('Read-only members cannot import into the project.');
    // Replacing deletes files: keep a restorable snapshot of the tree as it was.
    if (choices.mode === 'replace' && this.files.length > 0) await this.model.captureSnapshot();
    return applyImport(this.model, (b) => this.blobs.add(b), plan, choices, onProgress);
  }

  scheduleSnapshot() {
    if (this.snapTimer) return;
    this.snapTimer = setTimeout(async () => {
      this.snapTimer = null;
      try {
        await this.model.captureSnapshot();
      } catch {
        /* storage full: skip */
      }
    }, 10 * 60_000);
  }

  /** Desktop: mirror the project into a plain folder so external tools (Claude Code, Codex, Cursor...) can edit it. */
  async bindFolder(dir: string) {
    await this.unbindFolder(false);
    const { tauriFs } = await import('./tauri-fs.js');
    const fsa = await tauriFs(this.project.id, dir);
    this.mirrorFs = fsa;
    this.mirror = new MirrorSync({
      model: this.model,
      mesh: this.mesh,
      blobs: this.blobs,
      fs: fsa,
      getRole: () => this.role,
      onNotice: (m) => {
        this.mirrorNotice = m;
      },
    });
    await this.mirror.start();
    this.mirrorDir = dir;
    localStorage.setItem(`p2platex.mirror.${this.project.id}`, dir);
  }

  async unbindFolder(forget = true) {
    this.mirror?.stop();
    this.mirror = null;
    await this.mirrorFs?.dispose().catch(() => {});
    this.mirrorFs = null;
    this.mirrorDir = null;
    if (forget) localStorage.removeItem(`p2platex.mirror.${this.project.id}`);
  }

  async hashOf(bytes: Uint8Array) {
    return sha256Hex(bytes);
  }

  async close() {
    this.disposed = true;
    if (this.flushHandler) {
      window.removeEventListener('pagehide', this.flushHandler);
      document.removeEventListener('visibilitychange', this.flushHandler);
    }
    if (this.ticketTimer) clearTimeout(this.ticketTimer);
    await this.unbindFolder(false);
    this.manager?.stop();
    this.backup?.stop();
    clearTimeout(this.dedupeTimer);
    this.monitor?.stop();
    this.election?.stop();
    this.mesh?.destroy();
    await this.model?.destroy();
    this.store?.close();
  }
}

const PALETTE = ['#d33f49', '#2a9d8f', '#e9a23b', '#3a86ff', '#8e5bd9', '#ef6f9c', '#4caf50', '#ff7a45'];
export function colorFor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const color = PALETTE[h % PALETTE.length] as string;
  return { color, colorLight: `${color}33` };
}

/** A Rust-backed RtcFactory that loads the Tauri APIs on first use (they only exist inside the desktop shell). */
function lazyTauriRtc(): RtcFactory {
  let cached: Promise<{ invoke: TauriInvoke; listen: (event: string, cb: (p: never) => void) => Promise<() => void> }> | null = null;
  const apis = () =>
    (cached ??= Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]).then(([core, ev]) => ({
      invoke: core.invoke as TauriInvoke,
      listen: (event: string, cb: (p: never) => void) => ev.listen(event, (e) => cb(e.payload as never)),
    })));
  return (ice) =>
    tauriRtcFactory(
      (cmd, args) => apis().then((a) => a.invoke(cmd, args)),
      (event, cb) => apis().then((a) => a.listen(event, cb as (p: never) => void)),
    )(ice);
}
