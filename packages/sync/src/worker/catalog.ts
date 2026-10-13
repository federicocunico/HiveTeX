import type { DoorbellInfo, TrustedKey } from '@hivetex/protocol';
import { Doorbell } from '../doorbell.js';
import { runtimeKeyString } from '../registry.js';
import type { ProjectRuntime, TicketAnswer } from '../runtime.js';
import type { WorkerProjects, ProjectOpen } from './projects.js';
import { decodeValue, encodeValue } from '../native-persistence.js';
import type { RpcEndpoint } from '../worker-ipc.js';
import { SharedPushChannels } from '../shared-push.js';

export interface SeedProfile { server: string; account: string }
export interface RetainedProject {
  project: ProjectOpen;
  seedEnabled: boolean;
  paused: boolean;
  doorbell: DoorbellInfo | null;
  epoch: number;
  trusted: TrustedKey[];
}
export interface SeedData {
  v: 1;
  active: SeedProfile | null;
  background: boolean;
  paused: boolean;
  projects: RetainedProject[];
  /** Automatic router port mapping (UPnP) for active sync; absent means on. */
  upnp?: boolean;
  /** Server rollout switches last received with a ticket (12.3); absent fields mean on. */
  rollout?: { background?: boolean; upnp?: boolean };
}
/// Exactly the fields the native catalog accepts (src-tauri/src/catalog.rs rejects unknown ones): never a caller's extras.
const retainedProject = (p: ProjectOpen): ProjectOpen =>
  ({ server: p.server, account: p.account, project: p.project, scope: p.scope, role: p.role, isLocal: p.isLocal, createdHere: p.createdHere });
export const emptySeedData = (): SeedData => ({ v: 1, active: null, background: true, paused: false, projects: [] });
const profileKey = (p: SeedProfile) => JSON.stringify([new URL(p.server).origin.toLowerCase(), p.account]);

/** Retained selections are durable; dormant projects hold no runtime/ticket/socket and only listen for verified rings. */
export class SeedCatalog {
  private data = emptySeedData();
  private ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private registrations = new Map<string, () => void>();
  private awake = new Map<string, { release: () => Promise<void>; off: () => void; timer: ReturnType<typeof setTimeout> | null; since: number }>();
  private queued = new Set<string>();
  private resumeDemand = new Set<string>();
  private errors = new Map<string, string>();
  private generation = 0;
  private stopped = false;
  private credentialsAvailable = false;
  private networkAvailable = true;
  private bell: Doorbell;
  constructor(private o: {
    host: WorkerProjects;
    push: SharedPushChannels;
    load(): Promise<SeedData>;
    save(data: SeedData): Promise<void>;
    credentials(profile: SeedProfile): Promise<boolean>;
    emit(): void;
  }) {
    this.bell = new Doorbell({ channel: o.push.channel, trusted: () => this.data.projects
      .filter((r) => this.matches(r.project)).flatMap((r) => r.trusted) });
    this.bell.onState(() => o.emit());
    // The worker installs handlers and emits its protocol-ready frame before requesting native startup data.
    this.ready = Promise.resolve().then(() => this.restore());
    void this.ready.catch(() => o.emit());
  }
  private async restore() {
    this.data = await this.o.load();
    if (this.data.v !== 1) throw new Error('Unsupported seed catalog');
    if (this.data.active) {
      this.credentialsAvailable = await this.o.credentials(this.data.active).catch(() => false);
    }
    this.reconcile();
  }
  private matches(p: SeedProfile) {
    return !!this.data.active && profileKey(this.data.active) === profileKey(p);
  }
  private record(p: ProjectOpen) {
    return this.data.projects.find((r) => runtimeKeyString(r.project) === runtimeKeyString(p));
  }
  private eligible(r: RetainedProject) {
    return this.matches(r.project) && this.credentialsAvailable && this.networkAvailable && this.data.background && this.data.rollout?.background !== false && !this.data.paused
      && r.seedEnabled && !r.paused && r.project.role !== 'viewer' && !r.project.isLocal && !this.stopped;
  }
  private save() {
    const snapshot = structuredClone(this.data);
    const task = this.writes.catch(() => {}).then(() => this.o.save(snapshot));
    this.writes = task;
    return task;
  }
  async activate(profile: SeedProfile) {
    await this.ready;
    if (profile.account === 'local') {
      await this.deactivate(); this.o.host.activate(); return;
    }
    if (this.data.active && !this.matches(profile)) throw new Error('account stop barrier required');
    this.data.active = { server: new URL(profile.server).origin, account: profile.account };
    this.stopped = false;
    this.credentialsAvailable = await this.o.credentials(profile).catch(() => false);
    await this.save(); this.reconcile();
    this.o.host.activate();
  }
  async opened(p: ProjectOpen, runtime: ProjectRuntime) {
    await this.ready;
    if (p.isLocal) return;
    if (!this.matches(p) || this.stopped) throw new Error('account stop barrier required');
    // Successful native actor creation proves stable credentials are available.
    this.credentialsAvailable = true;
    let record = this.record(p);
    if (!record) {
      record = { project: retainedProject(p), seedEnabled: p.role !== 'viewer', paused: false, doorbell: null, epoch: 0, trusted: [] };
      this.data.projects.push(record);
    }
    if (runtime.paused !== (this.data.paused || record.paused)) runtime.setPaused(this.data.paused || record.paused);
    if (!this.networkAvailable) runtime.networkLost();
    await this.save(); this.reconcile();
  }
  ticket(p: ProjectOpen, runtime: ProjectRuntime, answer: TicketAnswer) {
    const record = this.record(p);
    if (!record || !this.matches(p) || this.stopped) return;
    record.project.role = runtime.role;
    record.trusted = structuredClone(runtime.trusted);
    record.epoch = Math.max(record.epoch, answer.epoch ?? 0);
    if (answer.doorbell) record.doorbell = { url: answer.doorbell.url, topic: answer.doorbell.topic };
    // Rollout switches apply to every project of this server/account; foreground sync is unaffected.
    if (answer.features) this.data.rollout = { background: answer.features.background !== false, upnp: answer.features.upnp !== false };
    if (runtime.revoked || runtime.role === 'viewer') record.seedEnabled = false;
    void this.save().catch(() => { this.errors.set(runtimeKeyString(p), 'save-failure'); this.o.emit(); });
    this.reconcile();
  }
  async detached(p: ProjectOpen, runtime: ProjectRuntime) {
    await this.ready;
    const record = this.record(p);
    if (record && this.eligible(record) && runtime.mesh.peers.length) await this.wake(record);
  }
  private reconcile() {
    for (const un of this.registrations.values()) un();
    this.registrations.clear();
    for (const r of this.data.projects) {
      const key = runtimeKeyString(r.project);
      if (!this.eligible(r)) {
        this.queued.delete(key);
        void this.sleep(key);
        continue;
      }
      if (r.doorbell && r.trusted.length) {
        this.registrations.set(key, this.bell.register(key, r.doorbell, r.epoch, () => {
          void this.wake(r, true).catch(() => { this.errors.set(key, 'offline'); this.o.emit(); });
        }));
      }
    }
    this.o.emit();
  }
  private async wake(r: RetainedProject, ring = false) {
    if (!this.eligible(r)) return;
    const key = runtimeKeyString(r.project);
    if (this.awake.has(key)) return;
    // Foreground runtimes do not count towards the awake background limit.
    const foreground = this.o.host.registry.demand(r.project).includes('editor');
    const backgroundCount = [...this.awake.keys()].filter((k) => {
      const project = this.data.projects.find((p) => runtimeKeyString(p.project) === k)?.project;
      return project && !this.o.host.registry.demand(project).includes('editor');
    }).length;
    if (!foreground && backgroundCount >= 4) { this.queued.add(key); this.o.emit(); return; }
    const generation = this.generation;
    const lease = this.o.host.seed(r.project);
    const entry = { release: () => lease.release(), off: () => {}, timer: null as ReturnType<typeof setTimeout> | null, since: Date.now() };
    this.awake.set(key, entry); this.queued.delete(key); this.errors.delete(key); this.o.emit();
    try {
      const actor = await lease.runtime;
      if (generation !== this.generation || !this.eligible(r)) { await this.sleep(key); return; }
      const runtime = actor.runtime;
      if (!foreground) runtime.mesh.awareness.setLocalState({ seed: true, deviceId: runtime.deviceId });
      const check = () => {
        if (this.awake.get(key) !== entry) return;
        if (runtime.revoked || runtime.role === 'viewer') {
          r.project.role = 'viewer'; r.seedEnabled = false;
          void this.save(); this.reconcile(); return;
        }
        this.o.emit();
      };
      entry.off = runtime.listen({ change: check });
      if (ring) await runtime.wakeOnRing(); else runtime.startNetworking();
      // Tracker requests all known documents and referenced assets, retaining partial/retryable status.
      const tick = () => {
        if (this.awake.get(key) !== entry) return;
        const foreground = this.o.host.registry.demand(r.project).includes('editor');
        if (!foreground && (!runtime.mesh.peers.length || (this.queued.size && Date.now() - entry.since >= 5 * 60_000))) {
          void this.sleep(key).then(() => this.drain()); return;
        }
        entry.timer = setTimeout(tick, 30_000);
      };
      entry.timer = setTimeout(tick, 30_000);
    } catch (error) {
      const required = this.o.host.registry.get(r.project)?.runtime.authRequired;
      this.errors.set(key, required || /credentials|sign in|keychain/i.test(String(error)) ? 'auth-required' : 'offline');
      await this.sleep(key); this.o.emit();
    }
  }
  private async sleep(key: string) {
    const entry = this.awake.get(key);
    if (!entry) return;
    this.awake.delete(key); entry.off(); if (entry.timer) clearTimeout(entry.timer);
    await entry.release();
  }
  private drain() {
    for (const key of [...this.queued]) {
      const r = this.data.projects.find((r) => runtimeKeyString(r.project) === key);
      if (r) void this.wake(r); else this.queued.delete(key);
    }
  }
  async select(p: ProjectOpen, enabled: boolean, download = false) {
    await this.ready;
    if (!this.matches(p) || p.isLocal || p.role === 'viewer') throw new Error('Project is not eligible for background seeding');
    let r = this.record(p);
    if (!r && !download) throw new Error('Download and seed is required for an undownloaded membership');
    if (!r) {
      r = { project: retainedProject(p), seedEnabled: true, paused: false, doorbell: null, epoch: 0, trusted: [] };
      this.data.projects.push(r);
    }
    r.seedEnabled = enabled;
    await this.save(); this.reconcile();
    if (enabled && download) await this.wake(r);
  }
  async pause(p: ProjectOpen, paused: boolean) {
    await this.ready;
    const r = this.record(p);
    if (!r || !this.matches(p)) return;
    r.paused = paused; this.o.host.registry.setPaused(p, paused || this.data.paused);
    await this.save(); this.reconcile();
  }
  async settings(update: { background?: boolean; paused?: boolean; upnp?: boolean }) {
    await this.ready;
    if (update.upnp !== undefined) this.data.upnp = update.upnp;
    if (update.background !== undefined) this.data.background = update.background;
    if (update.paused !== undefined) this.data.paused = update.paused;
    for (const r of this.data.projects.filter((r) => this.matches(r.project))) this.o.host.registry.setPaused(r.project, this.data.paused || r.paused);
    await this.save(); this.reconcile();
  }
  async list() {
    await this.ready;
    return {
      background: this.data.background, paused: this.data.paused, upnp: this.data.upnp !== false,
      projects: this.data.projects.filter((r) => this.matches(r.project)).map((r) => {
        const key = runtimeKeyString(r.project), actor = this.o.host.registry.get(r.project);
        const status = actor && this.o.host.status(actor.runtime);
        const stage = this.errors.get(key) ?? (!this.credentialsAvailable ? 'auth-required' : !this.networkAvailable ? 'offline' :
          !this.data.background || this.data.rollout?.background === false || !r.seedEnabled ? 'disabled' : this.data.paused || r.paused ? 'paused' :
          this.queued.has(key) ? 'queued' : this.awake.has(key) ? status?.syncStatus?.stage ?? 'waking' :
          !r.doorbell || !r.trusted.length ? 'offline' : this.bell.state(key) === 'subscribed' ? 'dormant'
          // Still opening the push stream is not an outage: only a failed stream is reported as unreachable.
          : this.bell.state(key) === 'unavailable' ? 'ring-channel-unreachable' : 'connecting');
        return { project: r.project, seedEnabled: r.seedEnabled, paused: r.paused, stage, status };
      }),
    };
  }
  /**
   * Whether router port mapping should run now: enabled, a signed-in account with usable credentials, network up,
   * not globally paused, and at least one project actively syncing. Never in local mode or signed out.
   */
  upnpWanted(): boolean {
    return this.data.upnp !== false && this.data.rollout?.upnp !== false && !!this.data.active && !this.stopped && this.credentialsAvailable
      && this.networkAvailable && !this.data.paused
      && this.o.host.registry.keys().some((k) => { const r = this.o.host.registry.get(k)?.runtime; return !!r && !r.offline && !r.paused; });
  }
  async deactivate() {
    await this.ready;
    ++this.generation; this.stopped = true; this.credentialsAvailable = false;
    this.queued.clear(); this.errors.clear();
    for (const un of this.registrations.values()) un(); this.registrations.clear();
    await Promise.all([...this.awake.keys()].map((key) => this.sleep(key)));
    this.data.active = null; await this.save(); this.o.emit();
  }
  async authorize(p: ProjectOpen) {
    await this.ready;
    if (!p.isLocal && (!this.matches(p) || this.stopped)) throw new Error('account is not active');
  }
  freeze() {
    ++this.generation; this.stopped = true; this.queued.clear();
    this.resumeDemand.clear();
    for (const un of this.registrations.values()) un(); this.registrations.clear();
  }
  async resume() {
    await this.ready;
    const profile = this.data.active, generation = this.generation;
    this.networkAvailable = true;
    if (!profile || this.stopped || this.data.paused) return;
    const available = await this.o.credentials(profile).catch(() => false);
    if (generation !== this.generation || !this.matches(profile) || this.stopped) return;
    this.credentialsAvailable = available;
    this.reconcile(); this.o.push.restart();
    for (const key of this.o.host.registry.keys()) {
      if (this.matches(key)) this.o.host.registry.get(key)?.runtime.networkRestored();
    }
    for (const r of this.data.projects) if (this.eligible(r) && !r.doorbell) void this.wake(r);
    for (const key of [...this.resumeDemand]) {
      const r = this.data.projects.find((r) => runtimeKeyString(r.project) === key);
      this.resumeDemand.delete(key);
      if (r && this.eligible(r)) void this.wake(r);
    }
  }
  async networkLost() {
    await this.ready;
    this.networkAvailable = false;
    for (const key of this.awake.keys()) this.resumeDemand.add(key);
    for (const key of this.o.host.registry.keys()) this.o.host.registry.get(key)?.runtime.networkLost();
    this.reconcile();
  }
  /** Process exit preserves the active profile for the next native startup. */
  async close() {
    ++this.generation; this.stopped = true;
    this.bell.close(); this.queued.clear();
    await Promise.all([...this.awake.keys()].map((key) => this.sleep(key)));
    await this.writes;
  }
  /** Resolves once every ring received so far was verified and handled (tests). */
  settled() {
    return this.bell.settled();
  }
  install(rpc: RpcEndpoint) {
    const handle = (name: string, fn: (p: any) => unknown) => rpc.handle(name, async (wire) => {
      if (typeof wire !== 'string') throw new Error('Encoded parameters required');
      return encodeValue((await fn(decodeValue(wire))) ?? null);
    });
    handle('catalog.activate', (p) => this.activate(p));
    handle('catalog.list', () => this.list());
    handle('catalog.select', (p) => this.select(p.project, p.enabled === true, p.download === true));
    handle('catalog.settings', (p) => this.settings(p));
    handle('catalog.pause', (p) => this.pause(p.project, p.paused === true));
  }
}
