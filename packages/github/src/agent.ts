import { type BlobManager, type Mesh, type PeerInfo, type ProjectModel, PeerConnection } from '@hivetex/sync';
import { type PushResult, pushBackup } from './backup.js';
import { GitHubClient, GitHubError, type RepoRef } from './client.js';
import { type BackupMeta, type BackupPolicy, DEFAULT_POLICY, commitMessage, decide, emptyMeta } from './policy.js';

export interface Binding {
  repo: RepoRef;
  branch: string;
}

interface WriterCap {
  dev: string;
  uname: string;
  role: 'owner' | 'editor' | 'viewer';
  hasToken: boolean;
}

export interface AgentOptions {
  mesh: Mesh;
  model: ProjectModel;
  blobs: BlobManager;
  self: { dev: string; uname: string };
  getRole: () => 'owner' | 'editor' | 'viewer';
  /** Project identity for the repository's `.hivetex.json` marker. */
  project?: { id: string; slug: string };
  /** Returns a valid GitHub user token for this device, or null if the user has not connected GitHub. */
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Extra files to include (e.g. the latest PDF when the owner enabled it). */
  extraFiles?: () => Promise<Map<string, Uint8Array>>;
  tickMs?: number;
  /**
   * The binding an owner recorded on the control plane (`owner/repo@branch`), the only repository this device will
   * push to. The copy in the shared project metadata is writable by any editor, so it is never trusted on its own.
   * Omitted only in tests that do not exercise authority.
   */
  authorizedBinding?: () => string | null;
}

export const bindingKey = (b: Binding) => `${b.repo.owner}/${b.repo.repo}@${b.branch}`;

const META = {
  binding: 'backupBinding',
  policy: 'backupPolicy',
  state: 'backupState',
} as const;

/**
 * Keeps an automatic GitHub backup of the project. Exactly one online device with a valid token does the
 * pushing (owners first, then lowest device id), and the counters/policy live in the shared project meta so
 * a different device can take over seamlessly.
 */
export class BackupAgent {
  private caps = new Map<string, WriterCap>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private hasToken = false;
  private tokenCheckedAt = 0;
  statusCbs = new Set<() => void>();
  pushes = 0;

  constructor(private o: AgentOptions) {
    o.mesh.onApp('gh-cap', (from, body) => this.onCap(from, body as WriterCap));
    o.mesh.onPeerJoin((p) => {
      void this.announceTo(p.deviceId);
    });
    o.mesh.onPeerLeave((p) => {
      this.caps.delete(p.deviceId);
    });
    // The root doc also carries our own bookkeeping (settings, backup state): count file edits and table changes only.
    o.model.onDocUpdate((id, _u, origin) => {
      if (id !== 'root') this.noteChange(origin);
    });
    o.model.onFilesChanged(() => this.noteChange(null));
    // Binding / policy / progress live in the shared project meta; keep UIs in step with local and remote changes.
    o.model.meta.observe(() => {
      for (const cb of this.statusCbs) cb();
    });
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  start() {
    void this.refreshToken().then(() => this.announce());
    this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 30_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- shared configuration (owners write it, everyone reads it) ----

  get binding(): Binding | null {
    const raw = this.o.model.meta.get(META.binding);
    return typeof raw === 'string' ? (JSON.parse(raw) as Binding) : null;
  }
  setBinding(b: Binding | null) {
    if (this.o.getRole() !== 'owner') throw new Error('Only owners can change the GitHub binding');
    if (b) this.o.model.meta.set(META.binding, JSON.stringify(b));
    else this.o.model.meta.delete(META.binding);
  }
  get policy(): BackupPolicy {
    const raw = this.o.model.meta.get(META.policy);
    return typeof raw === 'string' ? { ...DEFAULT_POLICY, ...(JSON.parse(raw) as Partial<BackupPolicy>) } : DEFAULT_POLICY;
  }
  setPolicy(p: Partial<BackupPolicy>) {
    if (this.o.getRole() !== 'owner') throw new Error('Only owners can change the backup policy');
    this.o.model.meta.set(META.policy, JSON.stringify({ ...this.policy, ...p }));
  }
  get meta(): BackupMeta {
    const raw = this.o.model.meta.get(META.state);
    return typeof raw === 'string' ? { ...emptyMeta(), ...(JSON.parse(raw) as Partial<BackupMeta>) } : emptyMeta();
  }
  private saveMeta(m: BackupMeta) {
    this.o.model.meta.set(META.state, JSON.stringify(m));
    for (const cb of this.statusCbs) cb();
  }

  // ---- writer election ----

  private selfCap(): WriterCap {
    return { dev: this.o.self.dev, uname: this.o.self.uname, role: this.o.getRole(), hasToken: this.hasToken };
  }

  private async announceTo(dev: string) {
    await this.o.mesh.sendApp(dev, 'gh-cap', this.selfCap());
  }
  announce() {
    this.o.mesh.broadcastApp('gh-cap', this.selfCap());
  }

  private onCap(from: PeerInfo, cap: WriterCap) {
    if (cap.dev !== from.deviceId) return;
    this.caps.set(cap.dev, { ...cap, role: from.claims.role }); // trust the verified role, not the claim
    for (const cb of this.statusCbs) cb();
  }

  /** The device that should push right now: an owner/editor with a token; owners first, then lowest id. */
  writer(): string | null {
    const all = [this.selfCap(), ...this.caps.values()].filter((c) => c.hasToken && c.role !== 'viewer');
    all.sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner') || (a.dev < b.dev ? -1 : 1));
    return all[0]?.dev ?? null;
  }
  isWriter() {
    return this.writer() === this.o.self.dev;
  }

  private async refreshToken() {
    const t = await this.o.getToken().catch(() => null);
    const had = this.hasToken;
    this.hasToken = !!t;
    this.tokenCheckedAt = this.now();
    if (had !== this.hasToken) this.announce();
    return t;
  }

  /** Call after the user connected / disconnected GitHub. */
  async tokenChanged() {
    await this.refreshToken();
  }

  // ---- change tracking (done by the writer only) ----

  private noteChange(origin: unknown) {
    if (!this.isWriter() || !this.binding) return;
    const m = this.meta;
    const t = this.now();
    m.changesSince += 1;
    if (!m.firstChangeAt || m.changesSince === 1) m.firstChangeAt = t;
    m.lastChangeAt = t;
    const who = origin instanceof PeerConnection ? origin.claims?.uname : this.o.self.uname;
    if (who && !m.contributors.includes(who)) m.contributors.push(who);
    this.saveMeta(m);
  }

  // ---- running backups ----

  /** True when the shared binding is not the one an owner recorded on the control plane (never pushed to). */
  get bindingMismatch(): boolean {
    const b = this.binding;
    if (!b || !this.o.authorizedBinding) return false;
    return bindingKey(b) !== this.o.authorizedBinding();
  }

  async tick() {
    if (this.running) return;
    if (this.now() - this.tokenCheckedAt > 5 * 60_000) await this.refreshToken();
    const b = this.binding;
    if (!b || !this.isWriter() || this.bindingMismatch) return;
    // A takeover can inherit unsaved work the previous writer never counted: treat unknown state as dirty.
    let m = this.meta;
    if (m.changesSince === 0 && m.lastSha === null && this.o.model.list().length > 0) {
      m = { ...m, changesSince: 1, lastChangeAt: this.now(), firstChangeAt: this.now() };
      this.saveMeta(m);
    }
    if (decide(this.policy, m, this.now()) === 'backup') await this.backupNow().catch(() => {});
  }

  /** Pushes immediately. Any device with a token may run it, writer or not. */
  async backupNow(): Promise<PushResult | null> {
    const b = this.binding;
    if (!b) throw new Error('This project is not linked to a GitHub repository');
    if (this.bindingMismatch) {
      throw new Error(`Backup target ${bindingKey(b)} was not set by an owner of this project; nothing was pushed`);
    }
    if (this.running) return null;
    this.running = true;
    try {
      const token = await this.o.getToken();
      if (!token) throw new GitHubError(401, 'GitHub authorization expired — reconnect GitHub');
      const client = new GitHubClient(token, this.o.fetchImpl ?? fetch.bind(globalThis));
      const files = await this.collect();
      const m = this.meta;
      const res = await pushBackup(client, b.repo, b.branch, files, { message: commitMessage(m, this.now()), lastSha: m.lastSha, ...(this.o.project ? { project: this.o.project } : {}) });
      const next = this.meta;
      next.lastBackupAt = this.now();
      next.lastError = null;
      if (!res.noop && res.commit) {
        next.lastSha = res.commit;
        this.pushes++;
      }
      next.changesSince = 0;
      next.contributors = [];
      next.firstChangeAt = 0;
      this.saveMeta(next);
      return res;
    } catch (e) {
      const m = this.meta;
      m.lastError = e instanceof Error ? e.message : String(e);
      this.saveMeta(m);
      if (e instanceof GitHubError && e.status === 401) {
        this.hasToken = false; // let another device take over
        this.announce();
      }
      throw e;
    } finally {
      this.running = false;
    }
  }

  private async collect(): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    await this.o.mesh.prefetchAll();
    for (const f of this.o.model.list()) {
      if (f.kind === 'text') out.set(f.path, new TextEncoder().encode((await this.o.model.openText(f.id)).toString()));
      else if (f.kind === 'binary' && f.hash) {
        try {
          out.set(f.path, await this.o.blobs.fetch(f.hash, 15_000));
        } catch {
          /* blob not available yet: skipped this round, kept on GitHub from earlier */
        }
      }
    }
    if (this.policy.includePdf && this.o.extraFiles) for (const [p, b] of await this.o.extraFiles()) out.set(p, b);
    return out;
  }
}
