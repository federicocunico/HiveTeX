import { exportRecoveryZip } from './recovery-export.js';
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
} from '@hivetex/compile';
import type { Role, TicketClaims, TrustedKey } from '@hivetex/protocol';
import {
  BlobManager,
  type Candidate,
  ChangeLog,
  type ChangeSet,
  ConnectionManager,
  MirrorSync,
  LOCAL_ORIGIN,
  type FsAdapter,
  type FileEntry,
  IndexedDbPersistence,
  Mesh,
  ProjectModel,
  type RtcFactory,
  type WebSocketLike,
  tauriRtcFactory,
  sha256Hex,
  SyncTracker,
  OfflineFork,
  type MergeConflict,
  type MergeReport,
  type HunkDecision,
  type FileChoice,
  forkMeshOptions,
  listenForkStatus,
  type SyncSnapshot,
} from '@hivetex/sync';
import { BackupAgent, GitHubClient, importRepo, type Binding } from '@hivetex/github';
import { api, isDesktop, wsBase } from './api.js';
import { copyText } from './clipboard.js';
import { isLocalProjectId } from './local-projects.js';
import { type FolderAction, type FolderDeps, runFolderAction } from './project-folder.js';
import { HelperEngine, type PairResult, helperToken, pairWithDesktop, probeHelper } from './helper-engine.js';
import { applyImport, planFor } from './import/apply.js';
import { classify } from './import/classify.js';
import { detectEngine, detectMain } from './import/detect.js';
import type { ApplyChoices, ApplyResult, ImportPlan } from './import/plan.js';
import type { ImportBundle } from './import/sources.js';
import { getGithubToken } from './github.js';
import { toast } from '../ui/toast.svelte.js';
import { syncEventText, syncNowMessage } from './sync-view.js';
import { type PresentPerson, peopleFromAwareness, presenceColor } from './presence.js';
import { COMPILE_MODE_KEY, type CompileMode, compilerLabel, policyFor, readCompileMode } from './compile-mode.js';
import { folderPermission, webFs } from './fs-access.js';
import { type Location, folderLabel, getLocation, migrateLegacyMirrors, setLocation } from './locations.js';
import { ensureRegistered } from './keys.js';

export interface ProjectInfo {
  id: string;
  slug: string;
  role: Role;
  defaultRole: string;
  passwordProtected: boolean;
  githubRepo?: string | null;
  /** Last time this account opened the project (any device), ISO; null if never. */
  lastOpenedAt?: string | null;
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
  /** When the shown PDF arrived; change sets that end later are "edits since the last compile". */
  private pdfShownAt = $state(0);
  /** Editing bursts (change sets) newer than the shown PDF. */
  get editsSincePdf(): number {
    return this.changes.filter((c) => c.endedAt > this.pdfShownAt).length;
  }
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
  private tracker!: SyncTracker;
  /** How far the join / sync is (stage, per-file state, percent, last sync). Null before the first computation. */
  syncStatus = $state<SyncSnapshot | null>(null);

  /** Work done without a peer linked, merged git-style at the next link (offline-mode-git-merge). */
  private fork!: OfflineFork;
  /** This device holds changes not shared yet (they are merged at the next link). */
  unsharedWork = $state(false);
  /** Conflicts between this device's offline work and others' changes, waiting for the member's decision. */
  conflicts = $state<MergeConflict[]>([]);
  /** The last merge of offline work (for the Sync panel). */
  lastMerge = $state<MergeReport | null>(null);
  /** Co-authors that are online (seen by the signaling relay or announced by a peer) but not connected yet. */
  connecting = $state<Candidate[]>([]);
  syncingNow = $state(false);
  syncNowResult = $state('');
  /** Edits could not be written to this device's storage (they are kept in memory and retried). Independent of peer sync. */
  saveFailing = $state(false);
  private trusted: TrustedKey[] = [];
  store!: IndexedDbPersistence;
  private disposed = false;
  private deviceId = '';
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private keys!: Awaited<ReturnType<typeof ensureRegistered>>['keys'];

  constructor(
    readonly project: ProjectInfo,
    readonly user: { id: string; username: string },
  ) {
    this.role = project.role;
  }

  async open() {
    this.store = await IndexedDbPersistence.open(`hivetex-project-${this.project.id}`);
    this.model = new ProjectModel(this.store);
    await this.model.init();
    this.model.onSaveState((st) => {
      this.saveFailing = st.failing;
    });
    this.refreshFiles();
    this.model.onFilesChanged(() => this.refreshFiles());
    // Who changed what (folder / editor / co-authors), kept on this device only.
    this.changelog = new ChangeLog({ model: this.model, store: this.store });
    this.changelog.start();
    this.changelog.onChange(() => void this.refreshChanges());
    void this.refreshChanges();

    let reg: Awaited<ReturnType<typeof ensureRegistered>> | null = null;
    try {
      reg = await ensureRegistered(this.user.id, navigator.userAgent.slice(0, 48));
      const k = await api<{ keys: TrustedKey[] }>('GET', '/keys');
      this.trusted = k.keys;
      sessionStorage.setItem('hivetex.trusted', JSON.stringify(this.trusted));
    } catch {
      this.offline = true;
      try {
        this.trusted = JSON.parse(sessionStorage.getItem('hivetex.trusted') ?? '[]');
      } catch {
        this.trusted = [];
      }
      // Offline-first: work locally with a throwaway identity until the control plane is reachable.
      const { generateDeviceKeys } = await import('@hivetex/crypto');
      reg = { keys: await generateDeviceKeys(), deviceId: `offline-${crypto.randomUUID()}` };
    }
    this.keys = reg.keys;
    this.deviceId = reg.deviceId;

    // Before the mesh exists, so a local edit made before any link is already recorded as unshared work.
    this.fork = new OfflineFork({
      model: this.model,
      canEdit: () => this.canWrite,
      enabled: () => !this.isLocal,
      onReport: (r) => this.onMergeReport(r),
      onChange: () => {
        this.unsharedWork = this.fork.active;
        this.conflicts = [...this.fork.conflicts];
      },
      ...forkMeshOptions(
        () => this.mesh,
        () => this.deviceId,
      ),
    });
    await this.fork.start();
    this.unsharedWork = this.fork.active;
    this.conflicts = [...this.fork.conflicts];

    this.mesh = new Mesh({
      projectId: this.project.id,
      model: this.model,
      keys: this.keys,
      trusted: this.trusted,
      getTicket: () => this.ticket,
      beforeSync: (peer) => this.fork.beforeSync(peer),
      // test hook only: shortens the revocation grace period in end-to-end tests
      ...(Number(localStorage.getItem('hivetex.epochGraceMs')) ? { epochGraceMs: Number(localStorage.getItem('hivetex.epochGraceMs')) } : {}),
    });
    this.blobs = new BlobManager(this.mesh, this.store);
    listenForkStatus(this.mesh, this.fork);
    this.mesh.onPeerJoin(() => this.refreshPeers());
    // A peer revealed a newer membership epoch (someone was removed or demoted): get a fresh ticket right away.
    this.mesh.onEpochAdvance((e) => {
      if (this.ticketEpoch() < e) void this.refreshTicketLoop();
    });
    this.mesh.onPeerLeave(() => this.refreshPeers());
    this.tracker = new SyncTracker({
      mesh: this.mesh,
      model: this.model,
      store: this.store,
      blobs: this.blobs,
      connecting: () => this.connecting.length,
      offline: () => this.offline || this.paused,
    });
    this.tracker.onChange((snap) => (this.syncStatus = snap));
    this.tracker.onEvent((e) => toast(syncEventText(e, this.tracker.snapshot), e === 'complete' ? 'ok' : 'info', e === 'complete' ? 4000 : 10_000));
    this.tracker.start();
    this.mesh.awareness.setLocalStateField('user', { name: this.user.username, ...colorFor(this.user.username) });
    this.mesh.awareness.on('change', () => this.refreshPresence());
    this.refreshPresence();

    await this.setupCompile();
    this.backup = new BackupAgent({
      mesh: this.mesh,
      model: this.model,
      blobs: this.blobs,
      self: { dev: this.deviceId, uname: this.user.username },
      getRole: () => this.role,
      project: { id: this.project.id, slug: this.project.slug },
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
    await this.restoreLocation();
    this.model.onDocUpdate(() => {
      this.stale = true;
      this.scheduleSnapshot();
      this.scheduleStaleCheck();
      this.scheduleLocalCompile();
    });
    // A local project (no account, local-mode spec) never meets anyone: no ticket, no connections.
    if (this.isLocal) this.offline = true;
    else void this.refreshTicketLoop();
    // Persist pending edits when the tab is hidden or closed (writes are normally batched every 250 ms).
    this.flushHandler = () => void this.model.flush().catch(() => {}); // a failure stays visible through saveFailing
    window.addEventListener('pagehide', this.flushHandler);
    document.addEventListener('visibilitychange', this.flushHandler);
    // Leaving now would lose edits that could not be stored: let the browser ask first.
    this.unloadGuard = (e: BeforeUnloadEvent) => {
      if (this.saveFailing) e.preventDefault();
    };
    window.addEventListener('beforeunload', this.unloadGuard);
  }
  private flushHandler: (() => void) | null = null;
  private unloadGuard: ((e: BeforeUnloadEvent) => void) | null = null;

  /** A zip of the project as held in memory right now, including edits storage refused (see recovery-export.ts). */
  async exportRecovery() {
    return exportRecoveryZip(this.model, (h) => this.blobs.fetch(h, 5000));
  }
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

  /** This device's compiler preference (Settings → Compiler); applies to every project. */
  compileMode = $state<CompileMode>(readCompileMode());
  private policy() {
    // A compiler whose reads cannot be verified (the quick compiler) builds for this device only (design D3b).
    const mode = this.compileMode === 'peers' ? 'peers' : this.localOnlyCompiler ? 'local' : this.compileMode;
    return policyFor(mode, localStorage.getItem('hivetex.compileForOthers') !== '0');
  }

  /** The quick compiler's builds stay on this device (never shared, never leader). */
  localOnlyCompiler = $state(false);
  /** Which compiler this device uses, for the status bar ("TeX Live", "quick compiler", "in-browser compiler"...). */
  compilerName = $state('');
  compilerPhase = $state<'ready' | 'setting-up' | 'packages' | 'unavailable'>('ready');
  compilerDetail = $state('');

  /** Downloads the quick compiler (Tectonic) with progress, then re-detects. Returns whether a compiler is available. */
  async installQuickCompiler(native?: NativeEngine): Promise<boolean> {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    this.compilerPhase = 'setting-up';
    this.compilerName = 'quick compiler';
    this.compilerDetail = 'downloading';
    const un = await listen<{ received: number; total: number }>('managed://progress', (e) => {
      const mb = (n: number) => (n / 1048576).toFixed(0);
      this.compilerDetail = e.payload.total ? `${mb(e.payload.received)} / ${mb(e.payload.total)} MB` : `${mb(e.payload.received)} MB`;
    });
    try {
      await invoke('managed_install', { component: 'tectonic' });
      const engine = native ?? new NativeEngine(invoke as TauriInvoke, this.project.id);
      const ok = await engine.init();
      if (ok && !native && this.engine === null) {
        // Installed from the Compiler panel while this project was open: start using it.
        this.engine = engine;
        this.engineKind = 'native';
        this.localOnlyCompiler = !engine.verifiedReads;
        this.election?.update({ engine: 'native', supports: engine.supports, optOut: this.policy().optOut });
      }
      this.compilerPhase = ok ? 'ready' : 'unavailable';
      this.compilerDetail = '';
      if (ok) this.engineNote = '';
      return ok;
    } catch (e) {
      this.compilerPhase = 'unavailable';
      this.compilerDetail = '';
      this.engineNote = `The quick compiler could not be set up: ${e instanceof Error ? e.message : String(e)}. Retry in Account > Compiler.`;
      return false;
    } finally {
      un();
    }
  }

  /** Detects the compiler available on this device (native TeX on desktop, the in-browser engine on the web). */
  private async loadEngine(): Promise<{ kind: 'native' | 'wasm' | 'none'; supports: ('pdflatex' | 'xelatex' | 'lualatex')[] }> {
    let kind: 'native' | 'wasm' | 'none' = 'none';
    let supports: ('pdflatex' | 'xelatex' | 'lualatex')[] = [];
    this.engineNote = '';
    if (isDesktop) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const native = new NativeEngine(invoke as TauriInvoke, this.project.id);
        let found = await native.init();
        // No TeX on this computer: set up the quick compiler (downloaded once, packages fetched as documents need them).
        if (!found && localStorage.getItem('hivetex.autoCompiler') !== '0') found = await this.installQuickCompiler(native);
        if (found) {
          this.engine = native;
          kind = 'native';
          supports = native.supports;
          this.localOnlyCompiler = !native.verifiedReads;
          this.compilerName = compilerLabel(native.flavor);
          this.compilerPhase = 'ready';
        } else if (!this.engineNote) {
          this.engineNote = 'No LaTeX on this computer yet. Download the quick compiler in Account > Compiler, or let peers compile for you.';
        }
      } catch (e) {
        this.engineNote = `Native compiler unavailable: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!this.engine) {
        // Last resort: the in-browser engine (its files are kept on disk by the app).
        const { loadWasmEngine } = await import('./wasm-engine.js');
        const wasm = await loadWasmEngine(this.project.id);
        if (wasm) {
          this.engine = wasm;
          kind = 'wasm';
          supports = wasm.supports;
          this.compilerName = 'in-browser compiler';
          this.compilerPhase = 'ready';
        }
      }
    } else {
      // The desktop app running on this computer compiles for the browser (paired once), else the in-browser engine.
      const helper = await this.useDesktopHelper();
      if (helper) {
        kind = 'native';
        supports = helper.supports;
      } else {
        const { loadWasmEngine } = await import('./wasm-engine.js');
        const wasm = await loadWasmEngine(this.project.id);
        if (wasm) {
          this.engine = wasm;
          kind = 'wasm';
          supports = wasm.supports;
          this.compilerName = 'in-browser compiler';
          this.compilerPhase = 'ready';
        } else this.engineNote = 'In-browser compilation needs a TeX package server, which is not reachable. Another collaborator running the desktop app (with TeX installed) will compile for everyone, or set a server in Settings.';
      }
    }
    this.engineKind = kind;
    return { kind, supports };
  }

  /** Uses the paired desktop app as this browser's compiler when it is running; returns it, or null. */
  private async useDesktopHelper(): Promise<HelperEngine | null> {
    const stored = helperToken();
    // Browsers ask the user before a website reaches this computer (Local Network Access): probe only once paired.
    if (!stored) return null;
    const status = await probeHelper();
    if (!status?.compiler) return null;
    const engine = new HelperEngine(status, stored.token, this.project.id);
    this.engine = engine;
    this.localOnlyCompiler = !engine.verifiedReads;
    this.compilerName = `desktop app (${compilerLabel(engine.flavor)})`;
    this.compilerPhase = 'ready';
    return engine;
  }

  /** Pairs this browser with the desktop app (the user confirms there), then compiles with it. */
  async pairDesktopHelper(): Promise<PairResult> {
    const result = await pairWithDesktop(this.user.username);
    if (result !== 'paired') return result;
    const engine = await this.useDesktopHelper();
    if (!engine) return 'not-found';
    this.engineKind = 'native';
    this.engineNote = '';
    this.election?.update({ engine: 'native', supports: engine.supports, optOut: this.policy().optOut });
    return 'paired';
  }

  private async setupCompile() {
    let kind: 'native' | 'wasm' | 'none' = 'none';
    let supports: ('pdflatex' | 'xelatex' | 'lualatex')[] = [];
    const policy = this.policy();
    if (policy.loadEngine) ({ kind, supports } = await this.loadEngine());
    else this.engineNote = 'Using peers: this device does not compile.';
    if (isDesktop) {
      // Packages the compiler downloads during a build (quick compiler), for the status bar.
      const { listen } = await import('@tauri-apps/api/event');
      this.unlistenPackages = await listen<string>('compile://package', (e) => {
        this.compilerPhase = 'packages';
        this.compilerDetail = e.payload.startsWith('installing ') ? e.payload : `downloading ${e.payload}`;
      });
    }
    if (kind === 'wasm') {
      // TeX files the in-browser compiler downloads (the first time each is needed), for the status bar.
      const { onTexFetch } = await import('./wasm-engine.js');
      const un = onTexFetch((f) => {
        if (f.state !== 'start') return;
        this.compilerPhase = 'packages';
        this.compilerDetail = `downloading ${f.file}`;
      });
      const prev = this.unlistenPackages;
      this.unlistenPackages = () => {
        prev?.();
        un();
      };
    }

    const power: 'mains' | 'battery' = 'mains';
    const batteryPct = 100;

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
        optOut: this.policy().optOut, // after loadEngine: a local-only compiler never leads
      },
      { engine: () => (String(this.model.settings.get('engine') ?? 'pdflatex') as 'pdflatex'), selfRole: () => this.role },
    );
    this.election.onLeaderChange((l) => this.onLeader(l));
    const engineProxy: CompileEngine = {
      kind,
      supports,
      compile: async (input, opts) => {
        this.compileStatus = 'compiling';
        try {
          return await (this.engine as CompileEngine).compile(input, opts);
        } finally {
          // packages fetched during this build are done
          if (this.compilerPhase === 'packages') {
            this.compilerPhase = 'ready';
            this.compilerDetail = '';
          }
        }
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
    // "This device only": the PDF shown is always this device's own.
    if (!this.policy().acceptRemote) return;
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
      if (good.result.stateHash !== this.pdfState) {
        this.pdfState = good.result.stateHash;
        this.pdfShownAt = Date.now();
      }
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

  /** Project state the shown PDF was built from. */
  private pdfState = '';

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
        this.pdfState = r.result.stateHash;
        this.pdfShownAt = Date.now();
      }
    } catch (e) {
      this.compileStatus = 'error';
      throw e;
    }
  }

  setCompileForOthers(on: boolean) {
    localStorage.setItem('hivetex.compileForOthers', on ? '1' : '0');
    this.election.update({ optOut: this.policy().optOut });
  }

  /** Switches this device's compiler preference; takes effect at once (election eligibility, engine, local compiles). */
  async setCompileMode(mode: CompileMode) {
    this.compileMode = mode;
    try {
      localStorage.setItem(COMPILE_MODE_KEY, mode);
    } catch {
      /* storage unavailable: applies to this session only */
    }
    const policy = this.policy();
    if (policy.loadEngine && !this.engine) {
      const { kind, supports } = await this.loadEngine();
      this.election.update({ engine: kind, supports });
    }
    if (!policy.loadEngine) this.engineNote = 'Using peers: this device does not compile.';
    else if (this.engine && this.engineNote.startsWith('Using peers')) this.engineNote = '';
    this.election.update({ optOut: policy.optOut });
    if (policy.autoLocal) this.scheduleLocalCompile(0);
    else void this.onCompileChange(); // back to the leader's results
  }

  private localTimer: ReturnType<typeof setTimeout> | undefined;
  private unlistenPackages: (() => void) | null = null;
  /** "This device only": compile here once edits settle. */
  private scheduleLocalCompile(delay = 1500) {
    if (!this.policy().autoLocal || !this.engine) return;
    if (this.localTimer) clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => void this.compileLocal().catch(() => {}), delay);
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
  private mirrorFs: { dispose(): unknown } | null = null;
  setPaused(p: boolean) {
    this.paused = p;
    this.tracker?.touch();
    if (p) {
      this.manager?.stop();
      this.manager = null;
      this.connecting = [];
      for (const peer of this.mesh.peers) peer.conn.close();
    } else this.startManager();
  }

  private startManager() {
    if (this.manager || this.paused || !this.deviceId || this.deviceId.startsWith('offline-')) return;
    // Some system webviews (notably WebKitGTK on Linux) lack WebRTC: the desktop app then uses the Rust stack.
    const useRust = isDesktop && (typeof RTCPeerConnection === 'undefined' || localStorage.getItem('hivetex.rtc') === 'rust');
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
    this.manager.onState(() => {
      this.connecting = this.manager?.candidates() ?? [];
      this.tracker?.touch();
    });
    this.manager.start();
  }

  /**
   * "Sync now": retry the connection to co-authors that are online, ask every connected peer again for every file and
   * fetch what is missing. Returns the message shown to the user.
   */
  async syncNow(): Promise<string> {
    if (this.syncingNow) return this.syncNowResult;
    this.syncingNow = true;
    try {
      if (this.paused || this.offline) {
        this.syncNowResult = 'Offline: edits are kept on this device and sync when you reconnect.';
        return this.syncNowResult;
      }
      this.manager?.reconnectNow();
      await this.mesh.resync();
      const r = await this.tracker.fetchAll();
      const snap = await this.tracker.refresh();
      this.syncNowResult = syncNowMessage(snap, r);
      toast(this.syncNowResult, 'info', 6000);
      return this.syncNowResult;
    } finally {
      this.syncingNow = false;
    }
  }

  /** For diagnosing a slow join: when each stage of reaching each co-author device happened. */
  syncDiagnostics() {
    return { status: this.syncStatus, candidates: this.manager?.candidates() ?? [], stages: this.manager?.diagnostics() ?? {} };
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

  private onMergeReport(r: MergeReport) {
    this.lastMerge = r;
    this.unsharedWork = this.fork.active;
    this.conflicts = [...this.fork.conflicts];
    if (r.discarded) {
      toast('You can no longer edit this project: the changes you made offline were not shared.', 'error', 10_000);
      return;
    }
    const parts: string[] = [];
    if (r.merged.length) parts.push(`merged with others' changes: ${r.merged.join(', ')}`);
    if (r.conflicts) parts.push(`${r.conflicts} conflict${r.conflicts === 1 ? '' : 's'} to resolve`);
    if (parts.length) toast(`Merged your offline changes. ${parts.join('; ')}.`, r.conflicts ? 'error' : 'info', 12_000);
  }

  /**
   * Link: merges a project that existed only on this computer into this one (local-mode spec). Files only there are
   * added; files at the same path with different content become conflicts to resolve. The local copy is left as is.
   */
  async mergeLocalProject(localId: string): Promise<MergeReport> {
    const src = await IndexedDbPersistence.open(`hivetex-project-${localId}`);
    try {
      const m = new ProjectModel(src);
      await m.init();
      const entries: Array<{ path: string; kind: 'text' | 'binary' | 'dir'; text?: string; hash?: string; size?: number }> = [];
      for (const f of m.list()) {
        if (f.kind === 'text') entries.push({ path: f.path, kind: 'text', text: (await m.openText(f.id)).toString() });
        else if (f.kind === 'binary' && f.hash) {
          const bytes = await src.getBlob(f.hash);
          if (bytes) await this.store.putBlob(f.hash, bytes);
          entries.push({ path: f.path, kind: 'binary', hash: f.hash, ...(f.size !== undefined ? { size: f.size } : {}) });
        } else if (f.kind === 'dir') entries.push({ path: f.path, kind: 'dir' });
      }
      const r = await this.fork.mergeIn(entries);
      this.conflicts = [...this.fork.conflicts];
      return r;
    } finally {
      src.close();
    }
  }

  /** Decides a text conflict (every hunk). 'conflict-again': others changed the same lines meanwhile. */
  async resolveTextConflict(id: string, decisions: Array<HunkDecision | undefined>) {
    const r = await this.fork.resolveText(id, decisions);
    this.conflicts = [...this.fork.conflicts];
    return r;
  }

  async resolveFileConflict(id: string, choice: FileChoice) {
    await this.fork.resolveFile(id, choice);
    this.conflicts = [...this.fork.conflicts];
  }

  /** A project that exists only on this computer (local mode). */
  get isLocal() {
    return isLocalProjectId(this.project.id);
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
        const { applyTextDiff } = await import('@hivetex/sync');
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

  /** Where this project lives on this device; `folderPending` is set when a web folder needs "Allow access" again. */
  location = $state<Location>({ kind: 'app' });
  folderPending = $state(false);

  /** Re-binds the folder remembered for this project on this device (desktop path or web handle). */
  private async restoreLocation() {
    await migrateLegacyMirrors().catch(() => 0);
    const loc = await getLocation(this.project.id).catch((): Location => ({ kind: 'app' }));
    this.location = loc;
    if (loc.kind !== 'folder') return;
    try {
      if (loc.desktopPath && isDesktop) await this.bindFolder({ desktopPath: loc.desktopPath, label: loc.label });
      else if (loc.handle) {
        // Browsers ask again for access after a restart; that needs a click (see allowFolderAccess).
        if ((await folderPermission(loc.handle)) === 'granted') await this.bindFolder({ handle: loc.handle, label: loc.label });
        else this.folderPending = true;
      }
    } catch (e) {
      this.mirrorNotice = `Could not re-open the folder "${loc.label}": ${e instanceof Error ? e.message : e}`;
    }
  }

  /** Web: the user clicked "Allow access" for the remembered folder. */
  async allowFolderAccess() {
    const loc = this.location;
    if (loc.kind !== 'folder' || !loc.handle) return false;
    if ((await folderPermission(loc.handle, true)) !== 'granted') return false;
    this.folderPending = false;
    await this.bindFolder({ handle: loc.handle, label: loc.label });
    return true;
  }

  /**
   * Makes a folder this project's location on this device: the project is mirrored into it so external tools
   * (Claude Code, Codex, Cursor, an editor...) can edit the files, and every change syncs with collaborators.
   */
  async bindFolder(target: { desktopPath: string; label?: string } | { handle: FileSystemDirectoryHandle; label?: string }) {
    await this.unbindFolder(false);
    let fsa: FsAdapter & { dispose(): unknown };
    let loc: Location;
    if ('desktopPath' in target) {
      const { tauriFs } = await import('./tauri-fs.js');
      fsa = await tauriFs(this.project.id, target.desktopPath);
      loc = { kind: 'folder', label: target.label ?? folderLabel(target.desktopPath), desktopPath: target.desktopPath };
    } else {
      fsa = webFs(target.handle);
      loc = { kind: 'folder', label: target.label ?? target.handle.name, handle: target.handle };
    }
    this.mirrorFs = fsa;
    this.mirror = new MirrorSync({
      model: this.model,
      mesh: this.mesh,
      blobs: this.blobs,
      fs: fsa,
      getRole: () => this.role,
      marker: { id: this.project.id, slug: this.project.slug },
      onNotice: (m) => {
        this.mirrorNotice = m;
      },
    });
    try {
      await this.mirror.start();
    } catch (e) {
      await this.unbindFolder(false);
      throw e;
    }
    this.mirrorDir = loc.label;
    this.location = loc;
    this.folderPending = false;
    await setLocation(this.project.id, loc).catch(() => {});
  }

  /** Stops using the folder. The files stay where they are; the project keeps living in the app. */
  async unbindFolder(forget = true) {
    this.mirror?.stop();
    this.mirror = null;
    await Promise.resolve(this.mirrorFs?.dispose()).catch(() => {});
    this.mirrorFs = null;
    this.mirrorDir = null;
    if (forget) {
      this.location = { kind: 'app' };
      this.folderPending = false;
      await setLocation(this.project.id, { kind: 'app' }).catch(() => {});
    }
  }

  /**
   * After a project was created from a folder: picks the main document and the engine from the imported sources,
   * unless they were already chosen. Returns the detected main file.
   */
  async detectMainAndEngine(): Promise<string | null> {
    if (this.model.settings.get('main')) return String(this.model.settings.get('main'));
    const texts: Array<{ path: string; text: string }> = [];
    for (const f of this.model.list()) {
      if (f.kind === 'text' && /\.tex$/i.test(f.path)) texts.push({ path: f.path, text: (await this.model.openText(f.id)).toString() });
    }
    const { main } = detectMain(texts);
    if (!main) return null;
    const engine = detectEngine(texts.find((t) => t.path === main)?.text ?? '');
    this.model.root.transact(() => {
      this.model.settings.set('main', main);
      if (engine && !this.model.settings.get('engine')) this.model.settings.set('engine', engine);
    }, LOCAL_ORIGIN);
    return main;
  }

  /**
   * Desktop: Open folder / Open in terminal / Copy folder path / Show in file manager. A project kept in the app first
   * gets its own folder in Documents/HiveTeX (see project-folder.ts).
   */
  async folderAction(action: FolderAction, onCreating?: (path: string) => void) {
    const { invoke } = await import('@tauri-apps/api/core');
    return runFolderAction(
      {
        projectId: this.project.id,
        slug: this.project.slug,
        boundPath: () => (this.mirrorDir && this.location.kind === 'folder' ? (this.location.desktopPath ?? null) : null),
        bind: (path) => this.bindFolder({ desktopPath: path }),
        invoke: invoke as FolderDeps['invoke'],
        copy: (text) => copyText(text),
        ...(onCreating ? { onCreating } : {}),
      },
      action,
    );
  }

  /** Desktop: opens the bound folder in the system file manager. */
  async revealFolder() {
    if (!isDesktop || !this.mirrorDir) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('mirror_reveal', { id: this.project.id });
  }

  async hashOf(bytes: Uint8Array) {
    return sha256Hex(bytes);
  }

  /** Co-authors online and the file each has open (from the shared presence state). */
  presence = $state<PresentPerson[]>([]);

  /** Tells co-authors which file this user has open. */
  setOpenFile(path: string | null) {
    this.mesh.awareness.setLocalStateField('file', path);
  }

  private refreshPresence() {
    this.presence = peopleFromAwareness(this.mesh.awareness.getStates(), this.mesh.awareness.clientID);
  }

  /** The file a co-author has open, by username, if they share it. */
  fileOf(name: string): string | null {
    return this.presence.find((p) => p.name === name && p.file)?.file ?? null;
  }

  changelog: ChangeLog | null = null;
  changes = $state<ChangeSet[]>([]);

  async refreshChanges() {
    if (this.changelog) this.changes = await this.changelog.list();
  }

  /** Reverses a change set as a normal edit (editors/owners only). */
  async undoChange(set: ChangeSet) {
    if (!this.canWrite) throw new Error('Read-only members cannot undo changes.');
    if (!this.changelog) return null;
    await this.mesh.prefetchAll();
    return this.changelog.undo(set);
  }

  async close() {
    this.disposed = true;
    await this.changelog?.flush().catch(() => {});
    this.changelog?.stop();
    if (this.flushHandler) {
      window.removeEventListener('pagehide', this.flushHandler);
      document.removeEventListener('visibilitychange', this.flushHandler);
    }
    if (this.ticketTimer) clearTimeout(this.ticketTimer);
    await this.unbindFolder(false);
    this.manager?.stop();
    this.tracker?.stop();
    this.backup?.stop();
    clearTimeout(this.dedupeTimer);
    clearTimeout(this.localTimer);
    this.unlistenPackages?.();
    this.monitor?.stop();
    this.fork?.stop();
    this.election?.stop();
    this.mesh?.destroy();
    if (this.unloadGuard) window.removeEventListener('beforeunload', this.unloadGuard);
    // Unsaved edits (failing storage) keep the database open: closing it would end their retries.
    const saved = await this.model?.destroy().then(() => true, () => false);
    if (saved !== false) this.store?.close();
  }
}

/** A member's color for cursors and selections: the same presence color their avatar has everywhere. */
export function colorFor(name: string) {
  const color = presenceColor(name);
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
