import { exportRecoveryZip } from './recovery-export.js';
import type { StoredDeviceKeys } from '@hivetex/crypto';
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
import { ROOT_DOC_ID, type Role, type TicketClaims, type TrustedKey } from '@hivetex/protocol';
import {
  BlobManager,
  type Candidate,
  ChangeLog,
  type ChangeSet,
  ConnectionManager,
  ProjectRuntime,
  type PushState,
  MirrorSync,
  LOCAL_ORIGIN,
  type FsAdapter,
  type FileEntry,
  type Persistence,
  Mesh,
  ProjectModel,
  type PeerRoute,
  type RtcFactory,
  type WebSocketLike,
  tauriRtcFactory,
  sha256Hex,
  type SyncTracker,
  type OfflineFork,
  type MergeConflict,
  type MergeReport,
  type HunkDecision,
  type FileChoice,
  type SyncSnapshot,
} from '@hivetex/sync';
import { BackupAgent, GitHubClient, importRepo, type Binding } from '@hivetex/github';
import { api, apiBase, isDesktop, wsBase } from './api.js';
import { copyText } from './clipboard.js';
import { takeCreatedHere } from './created-here.js';
import { isLocalProjectId } from './local-projects.js';
import { openProjectStore, hasNativeProjectStore, type StoreRef } from './project-store.js';
import { type HostedRuntime, attachRuntime } from './runtimes.js';
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
import { localKeys, registerKeys } from './keys.js';

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
  /** Direct WebRTC, WebRTC through TURN, or the server's encrypted application relay. */
  route: PeerRoute;
  /** Relay only: why the server currently refuses forwarding (queued edits and files wait). */
  limited: string | null;
  seed?: boolean;
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

  /**
   * The project's synchronization actor (packages/sync runtime.ts): replica, mesh, offline fork, tracker, identity and
   * ticket recovery, connection manager and doorbell. This class adds the reactive view and the foreground services.
   */
  private runtime!: ProjectRuntime;
  /** This workspace's editor lease on the shared runtime (runtimes.ts); released on close. */
  private lease: import('@hivetex/sync').Lease<HostedRuntime> | null = null;
  private unlisten: (() => void) | null = null;
  private foregroundUnsubs: Array<() => void> = [];
  private recoveryEntries: HostedRuntime['recoveryEntries'];
  private get deviceId() {
    return this.runtime?.deviceId ?? '';
  }
  private get tracker(): SyncTracker {
    return this.runtime.tracker;
  }
  private get fork(): OfflineFork {
    return this.runtime.fork;
  }
  /** How far the join / sync is (stage, per-file state, percent, last sync). Null before the first computation. */
  syncStatus = $state<SyncSnapshot | null>(null);

  /** This device holds changes not shared yet (they are merged at the next link). */
  unsharedWork = $state(false);
  /** Why the merge of offline changes is waiting or could not be prepared (they are kept); null when nothing is wrong. */
  mergeError = $state<unknown>(null);
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
  /** The ticket authority's public keys (the runtime's array: the mesh verifies against this very object). */
  private get trusted(): TrustedKey[] {
    return this.runtime.trusted;
  }
  /** Identity handed to compile and backup; `dev` follows the registration. */
  private selfRef = { dev: '', uname: '' };
  doorbellState = $state<PushState>('off');
  private onlineHandler: (() => void) | null = null;
  store!: Persistence;
  /** Which store holds this project on this device (desktop: native once migrated; see project-store.ts). */
  storeKind: 'indexeddb' | 'native' = 'indexeddb';
  private disposed = false;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private keys!: Awaited<ReturnType<typeof localKeys>>['keys'];

  project = $state({} as ProjectInfo);

  constructor(
    project: ProjectInfo,
    readonly user: { id: string; username: string },
  ) {
    this.project = project;
    this.role = project.role;
  }

  /** Apply the authoritative share ID without changing internal routes or persistence identities. */
  async updateShareId(slug: string) {
    this.project.slug = slug;
    try {
      localStorage.setItem(`hivetex.proj.${this.project.id}`, JSON.stringify(this.project));
      const list = JSON.parse(localStorage.getItem('hivetex.projects') ?? '[]') as ProjectInfo[];
      localStorage.setItem('hivetex.projects', JSON.stringify(list.map(p => p.id === this.project.id ? { ...p, slug } : p)));
    } catch { /* current metadata remains available if local storage is unavailable */ }
    try {
      await this.mirror?.updateProjectSlug(slug);
    } catch {
      this.mirrorNotice = 'Project ID changed, but the folder marker could not be updated. Reopen the folder to retry.';
    }
  }

  async open() {
    const pid = this.project.id;
    const key = { server: this.isLocal ? 'local' : apiBase(), account: this.user.id, project: pid };
    this.lease = attachRuntime(key, 'editor', () => this.createRuntime());
    const hosted = await this.lease.runtime;
    if (this.disposed) {
      await this.lease?.release();
      return;
    }
    this.runtime = hosted.runtime;
    this.recoveryEntries = hosted.recoveryEntries;
    this.store = hosted.store;
    this.storeKind = hosted.storeKind;
    this.keys = hosted.keys;
    this.unlisten = this.runtime.listen({
      change: () => this.mirrorRuntime(),
      syncEvent: (e, snap) => toast(syncEventText(e, snap), e === 'complete' ? 'ok' : 'info', e === 'complete' ? 4000 : 10_000),
      mergeReport: (r) => this.onMergeReport(r),
      role: (role) => {
        this.role = role;
        this.election?.update({}); // leadership eligibility depends on the role (viewers never lead)
      },
      deviceId: (id) => this.adoptDevice(id),
      ticket: (r) => {
        if (r.githubRepo !== undefined) this.project.githubRepo = r.githubRepo;
      },
    });
    this.role = this.runtime.role;
    this.selfRef = { dev: this.deviceId, uname: this.user.username };

    this.model = this.runtime.model;
    this.mesh = this.runtime.mesh;
    this.blobs = this.runtime.blobs;
    this.changelog = this.runtime.changelog;
    this.refreshFiles();
    this.foregroundUnsubs.push(this.model.onFilesChanged(() => this.refreshFiles()));
    // Who changed what (folder / editor / co-authors), kept on this device only.
    this.foregroundUnsubs.push(this.changelog.onChange(() => void this.refreshChanges()));
    void this.refreshChanges();
    this.mirrorRuntime();
    this.mesh.awareness.setLocalStateField('user', { name: this.user.username, ...colorFor(this.user.username) });
    this.mesh.awareness.setLocalStateField('deviceId', this.deviceId);
    this.mesh.awareness.setLocalStateField('seed', false);
    const presenceChanged = () => this.refreshPresence();
    this.mesh.awareness.on('change', presenceChanged);
    this.foregroundUnsubs.push(() => this.mesh.awareness.off('change', presenceChanged));
    this.refreshPresence();

    await this.setupCompile();
    if (this.disposed) return;
    this.backup = new BackupAgent({
      mesh: this.mesh,
      model: this.model,
      blobs: this.blobs,
      self: this.selfRef,
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
    this.foregroundUnsubs.push(this.model.onFilesChanged(() => this.scheduleDedupe()));
    this.foregroundUnsubs.push(this.mesh.onDocReconciled(() => this.scheduleDedupe()));
    await this.restoreLocation();
    if (this.disposed) return;
    this.foregroundUnsubs.push(this.model.onDocUpdate(() => {
      this.stale = true;
      this.scheduleSnapshot();
      this.scheduleStaleCheck();
      this.scheduleLocalCompile();
    }));
    // A local project (no account, local-mode spec) never meets anyone: no ticket, no connections.
    if (this.isLocal) this.offline = true;
    else {
      this.runtime.startNetworking();
      // Network back (the browser says so): do not wait for the retry timer.
      this.onlineHandler = () => this.runtime.networkRestored();
      window.addEventListener('online', this.onlineHandler);
    }
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
    return exportRecoveryZip(this.model, (h) => this.blobs.fetch(h, 5000), this.recoveryEntries);
  }
  private dedupeTimer: ReturnType<typeof setTimeout> | undefined;

  /** After merging with peers, drop identical duplicate files (e.g. the same GitHub backup imported twice). */
  private scheduleDedupe() {
    if (!this.canWrite) return;
    clearTimeout(this.dedupeTimer);
    // Only complete, settled files are compared (see ProjectModel.dedupeIdentical); the pass runs again as answers arrive.
    this.dedupeTimer = setTimeout(() => void this.model.dedupeIdentical({ settled: (id) => !this.mesh.reconciling(id) }).catch(() => {}), 2500);
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
    if (this.disposed) return;
    if (isDesktop) {
      // Packages the compiler downloads during a build (quick compiler), for the status bar.
      const { listen } = await import('@tauri-apps/api/event');
      this.unlistenPackages = await listen<string>('compile://package', (e) => {
        this.compilerPhase = 'packages';
        this.compilerDetail = e.payload.startsWith('installing ') ? e.payload : `downloading ${e.payload}`;
      });
      if (this.disposed) { this.unlistenPackages(); return; }
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
      self: this.selfRef,
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
    if (this.disposed) return;
    if (!this.policy().autoLocal || !this.engine) return;
    if (this.localTimer) clearTimeout(this.localTimer);
    this.localTimer = setTimeout(() => void this.compileLocal().catch(() => {}), delay);
  }

  /** Creates the project's runtime (first attachment only): store, identity, replica and synchronization actor. */
  private async createRuntime(): Promise<HostedRuntime> {
    const ref: StoreRef = this.isLocal ? { kind: 'local', id: this.project.id } : { kind: 'shared', project: this.project.id, account: this.user.id };
    if (await hasNativeProjectStore(ref)) {
      // Attaching to a retained actor never opens the store in the renderer, even briefly.
      return this.openWorkerRuntime((await localKeys(this.user.id)).keys);
    }
    const opened = await openProjectStore(ref);
    if (opened.migrationError) console.warn('[hivetex] store migration will be retried', opened.migrationError);
    // Offline-first: the local identity (device keys, the id a registration gave them) never needs the network. What
    // is missing (registration, trusted keys, a ticket) is recovered by the runtime's ticket loop whenever the control
    // plane is reachable, each part on its own.
    let cachedTrusted: TrustedKey[] = [];
    try {
      cachedTrusted = JSON.parse(sessionStorage.getItem('hivetex.trusted') ?? '[]') as TrustedKey[];
    } catch {
      /* no cached keys */
    }
    let local: Awaited<ReturnType<typeof localKeys>>;
    try {
      local = await localKeys(this.user.id);
    } catch (e) {
      // Device storage is unavailable: run with keys that live only in memory.
      if (isDesktop) {
        await opened.store.close();
        throw e;
      }
      const { generateDeviceKeys } = await import('@hivetex/crypto');
      local = { keys: await generateDeviceKeys(isDesktop ? { forceNoble: true } : {}), deviceId: null };
    }
    const keys = local.keys;
    const pid = this.project.id;
    const userId = this.user.id;
    if (isDesktop && opened.kind === 'native') {
      // Migration has finished and released its writer before the worker takes custody of this scope.
      await opened.store.close();
      return this.openWorkerRuntime(keys);
    }
    const runtime: ProjectRuntime = new ProjectRuntime({
      projectId: pid,
      isLocal: this.isLocal,
      role: this.role,
      // A project made on this device (or kept only here) authors its own file table; a joined one waits for a peer.
      createdHere: takeCreatedHere(pid),
      store: opened.store,
      keys,
      deviceId: local.deviceId || null,
      trusted: cachedTrusted,
      // The runtime's own role, not one workspace's: several workspaces and the background share it.
      canWrite: () => runtime.role !== 'viewer',
      // test hook only: shortens the revocation grace period in end-to-end tests
      mesh: Number(localStorage.getItem('hivetex.epochGraceMs')) ? { epochGraceMs: Number(localStorage.getItem('hivetex.epochGraceMs')) } : {},
      adapters: {
        registerDevice: () => registerKeys(userId, keys, navigator.userAgent.slice(0, 48)),
        loadTrusted: async () => (await api<{ keys: TrustedKey[] }>('GET', '/keys')).keys,
        fetchTicket: (deviceId) => api('POST', `/projects/${pid}/ticket`, { deviceId }),
        ring: (deviceId) => api('POST', `/projects/${pid}/ring`, { deviceId }),
        iceServers: () => api<{ iceServers: unknown[]; expiresAt?: number }>('POST', '/turn', { projectId: pid }),
        signalUrl: `${wsBase()}/api/signal`,
        wsFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
        rtcFactory: () => this.rtcFactory(),
        createManager: (o) => new ConnectionManager(o),
        saveTrusted: (k) => {
          try {
            sessionStorage.setItem('hivetex.trusted', JSON.stringify(k));
          } catch {
            /* private mode: the cache is only an optimisation */
          }
        },
      },
    });
    await runtime.open();
    return {
      runtime,
      store: opened.store,
      storeKind: opened.kind,
      keys,
      setPaused: (p) => runtime.setPaused(p),
      close: async () => {
        await runtime.close();
        // Unsaved edits (failing storage) keep the database open: closing it would end their retries.
        const saved = await runtime.model?.destroy().then(() => true, () => false);
        if (saved !== false) opened.store.close();
      },
    };
  }
  private async openWorkerRuntime(keys: StoredDeviceKeys): Promise<HostedRuntime> {
    const { openDesktopWorker } = await import('./desktop-worker.js');
    const hosted = await openDesktopWorker(this.project, this.user.id, takeCreatedHere(this.project.id));
    return {
      runtime: hosted.renderer.runtime, store: hosted.renderer.store, storeKind: 'native', keys,
      recoveryEntries: () => hosted.renderer.recoveryEntries(),
      setPaused: (paused) => hosted.renderer.runtime.setPaused(paused), close: hosted.close,
    };
  }

  // ---- tickets & connectivity (the runtime owns them; these are the session's views) ----

  /** Fetch a fresh ticket now (e.g. right after the owner changed roles, so peers learn the new epoch). */
  refreshTicketNow() {
    return this.runtime.refreshTicketNow();
  }

  /** Copies the runtime's observable state into the reactive fields the UI reads. */
  private mirrorRuntime() {
    const r = this.runtime;
    if (!r) return;
    this.offline = r.offline;
    this.revoked = r.revoked;
    this.saveFailing = r.saveFailing;
    this.unsharedWork = r.unsharedWork;
    this.mergeError = r.mergeError;
    this.conflicts = r.conflicts;
    this.connecting = r.connecting;
    this.doorbellState = r.doorbellState;
    if (r.syncStatus !== this.syncStatus) this.syncStatus = r.syncStatus;
    if (r.peers !== this.lastPeers) {
      this.lastPeers = r.peers;
      this.refreshPeers();
    }
  }
  private lastPeers: unknown = null;

  /** The registration gave this device its id: everything that identified it by the temporary one follows. */
  private adoptDevice(id: string) {
    this.selfRef.dev = id;
    this.election?.setDevice(id);
  }

  /** Browser RTC, or the Rust stack where the webview has none; chosen when the connection manager starts. */
  private rtcFactory(): RtcFactory {
    // Some system webviews (notably WebKitGTK on Linux) lack WebRTC: the desktop app then uses the Rust stack.
    const useRust = isDesktop && (typeof RTCPeerConnection === 'undefined' || localStorage.getItem('hivetex.rtc') === 'rust');
    // Test builds only (VITE_E2E=1): `hivetex.e2e.noWebrtc` makes every WebRTC attempt unable to find a path, to exercise
    // the application relay in the packaged desktop app (browsers use an init script instead).
    const noPath = import.meta.env.VITE_E2E === '1' && localStorage.getItem('hivetex.e2e.noWebrtc') === '1';
    if (useRust) {
      // The factory is synchronous; the Tauri imports resolve lazily inside the wrapper's async setup.
      return (ice) => lazyTauriRtc()(ice);
    }
    return (ice) =>
      new RTCPeerConnection(noPath ? { iceServers: [], iceTransportPolicy: 'relay' } : { iceServers: ice as RTCIceServer[] }) as unknown as ReturnType<RtcFactory>;
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
  private folderGeneration = 0;
  private mirrorNativeId: string | null = null;
  setPaused(p: boolean) {
    this.paused = p;
    // No server request, no push subscription and no timer while paused; resuming recovers.
    this.runtime.setPaused(p);
  }

  /**
   * "Sync now": retry the connection to co-authors that are online, ask every connected peer again for every file and
   * fetch what is missing. Returns the message shown to the user.
   */
  async syncNow(): Promise<string> {
    if (this.syncingNow) return this.syncNowResult;
    this.syncingNow = true;
    try {
      const round = this.paused || this.offline ? null : await this.runtime.syncNow();
      if (!round) {
        this.syncNowResult = 'Offline: edits are kept on this device and sync when you reconnect.';
        return this.syncNowResult;
      }
      // The outcome of this round: queued requests or silence are "pending", never success, and the sync time only advances on success.
      this.syncNowResult = syncNowMessage(round.snapshot, round.outcome);
      toast(this.syncNowResult, 'info', 6000);
      return this.syncNowResult;
    } finally {
      this.syncingNow = false;
    }
  }

  /** For diagnosing a slow join: when each stage of reaching each co-author device happened. */
  syncDiagnostics() {
    return { status: this.syncStatus, ...this.runtime.managerDiagnostics };
  }

  private refreshPeers() {
    this.peers = this.runtime.peers.map((p) => ({ ...p }));
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
    this.mergeError = null;
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
    const src = (await openProjectStore({ kind: 'local', id: localId })).store;
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
    if (this.disposed) return;
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
    if (this.disposed) return;
    await this.unbindFolder(false);
    const generation = this.folderGeneration;
    if (this.disposed) return;
    let fsa: FsAdapter & { dispose(): unknown };
    let loc: Location;
    if ('desktopPath' in target) {
      const { tauriFs } = await import('./tauri-fs.js');
      const id = `${this.project.id}-${crypto.randomUUID()}`;
      fsa = await tauriFs(id, target.desktopPath);
      if (generation === this.folderGeneration && !this.disposed) this.mirrorNativeId = id;
      loc = { kind: 'folder', label: target.label ?? folderLabel(target.desktopPath), desktopPath: target.desktopPath };
    } else {
      fsa = webFs(target.handle);
      loc = { kind: 'folder', label: target.label ?? target.handle.name, handle: target.handle };
    }
    if (generation !== this.folderGeneration || this.disposed) { await fsa.dispose(); return; }
    this.mirrorFs = fsa;
    const mirror = new MirrorSync({
      model: this.model,
      mesh: this.mesh,
      blobs: this.blobs,
      fs: fsa,
      getRole: () => this.runtime.role,
      marker: { id: this.project.id, slug: this.project.slug },
      // Folder and project changed the same lines while the app was closed: kept as a conflict to resolve.
      onConflict: (c) => this.fork.recordTextConflict(c),
      onNotice: (m) => {
        this.mirrorNotice = m;
      },
    });
    this.mirror = mirror;
    try {
      await mirror.start();
    } catch (e) {
      mirror.stop();
      if (generation === this.folderGeneration) await this.unbindFolder(false);
      else await fsa.dispose();
      throw e;
    }
    if (generation !== this.folderGeneration || this.disposed) { mirror.stop(); await fsa.dispose(); return; }
    this.mirrorDir = loc.label;
    this.location = loc;
    this.folderPending = false;
    await setLocation(this.project.id, loc).catch(() => {});
  }

  /** Stops using the folder. The files stay where they are; the project keeps living in the app. */
  async unbindFolder(forget = true) {
    const generation = ++this.folderGeneration;
    this.mirror?.stop();
    this.mirror = null;
    const oldFs = this.mirrorFs;
    this.mirrorFs = null;
    this.mirrorNativeId = null;
    this.mirrorDir = null;
    await Promise.resolve(oldFs?.dispose()).catch(() => {});
    if (generation !== this.folderGeneration) return;
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
        bindingId: () => this.mirrorNativeId ?? this.project.id,
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
    await invoke('mirror_reveal', { id: this.mirrorNativeId ?? this.project.id });
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
    // Reversing a change needs the text it applies to: not while a file's content is still arriving.
    const have = await this.mesh.awaitComplete({ timeoutMs: 8000 });
    if (!have.complete) throw new Error(`Cannot undo yet: these files have not arrived on this device: ${have.missing.map((m) => m.path ?? 'the file list').join(', ')}`);
    return this.changelog.undo(set);
  }

  async close() {
    if (this.disposed) return;
    this.disposed = true;
    // Remove schedulers before awaiting storage, so a retained seed cannot start foreground work meanwhile.
    for (const off of this.foregroundUnsubs.splice(0)) off();
    this.leader?.stop();
    this.client?.stop();
    this.backup?.stop();
    this.monitor?.stop();
    this.election?.stop();
    if (this.snapTimer) clearTimeout(this.snapTimer);
    await this.changelog?.flush().catch(() => {});
    if (this.flushHandler) {
      window.removeEventListener('pagehide', this.flushHandler);
      document.removeEventListener('visibilitychange', this.flushHandler);
    }
    if (this.onlineHandler) window.removeEventListener('online', this.onlineHandler);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    await this.unbindFolder(false);
    this.backup?.stop();
    clearTimeout(this.dedupeTimer);
    clearTimeout(this.localTimer);
    this.unlistenPackages?.();
    this.monitor?.stop();
    this.election?.stop();
    this.unlisten?.();
    if (this.unloadGuard) window.removeEventListener('beforeunload', this.unloadGuard);
    // Detach this editor: the runtime (replica, mesh, store) closes only if nothing else needs it (a background seed).
    await this.lease?.release();
    this.lease = null;
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
