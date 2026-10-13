import { generateDeviceKeys } from '@hivetex/crypto';
import { RING_TYP, type TrustedKey } from '@hivetex/protocol';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, expect, it, vi } from 'vitest';
import { SharedPushChannels } from '../src/shared-push.js';
import type { PushChannel, PushState } from '../src/doorbell.js';
import { SeedCatalog, emptySeedData, type SeedData } from '../src/worker/catalog.js';
import { WorkerProjects, type ProjectOpen } from '../src/worker/projects.js';
import { ProjectRuntime, type RuntimeAdapters } from '../src/runtime.js';
import { MemoryPersistence } from '../src/persistence.js';
import { MemoryIngressJournal } from '../src/ingress.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const f of cleanup.splice(0)) await f(); });
const tick = () => new Promise((r) => setTimeout(r, 15));
const topic = (i: number) => 'ht' + String.fromCharCode(97 + i).repeat(26);
const profile = { server: 'https://hivetex.example', account: 'ann' };
const p = (project = 'p'): ProjectOpen => ({ ...profile, project, scope: 'a'.repeat(64), isLocal: false, role: 'editor', createdHere: false });

async function fixture(data = emptySeedData(), credentials = true, signing?: Awaited<ReturnType<typeof generateKeyPair>>, pushState: PushState = 'subscribed') {
  const keys = await generateDeviceKeys();
  const signerKeys = signing ?? await generateKeyPair('EdDSA', { extractable: true });
  const { privateKey, publicKey } = signerKeys;
  const trusted: TrustedKey[] = [{ kid: 'catalog-k', jwk: await exportJWK(publicKey) }];
  const subscriptions = new Set<{ topics: string[]; cb: (topic: string, data: string) => void }>();
  let created = 0, saved = structuredClone(data);
  const channel: PushChannel = {
    subscribe(topics, cb, state) {
      const sub = { topics, cb }; subscriptions.add(sub); state(pushState);
      return () => { subscriptions.delete(sub); };
    },
    publish: async (topic, message) => { for (const s of subscriptions) if (s.topics.includes(topic)) s.cb(topic, message); },
  };
  const push = new SharedPushChannels(() => channel);
  let catalog!: SeedCatalog;
  const host = new WorkerProjects({
    emit: () => {}, opened: (p, runtime) => catalog.opened(p, runtime),
    detached: (p, runtime) => catalog.detached(p, runtime),
    create: async (project) => {
      created++;
      const store = new MemoryPersistence();
      // Real actor/registry/awareness; networking injected as local in this catalog-only unit fixture.
      const runtime = new ProjectRuntime({ projectId: project.project, isLocal: true, role: project.role,
        createdHere: true, store, keys, deviceId: 'desktop', canWrite: () => true, trusted,
        adapters: {} as RuntimeAdapters });
      await runtime.open();
      return { runtime, store, journal: new MemoryIngressJournal(), close: async () => {
        await runtime.close(); await runtime.model.destroy();
      } };
    },
  });
  catalog = new SeedCatalog({ host, push, load: async () => structuredClone(data),
    save: async (next) => { saved = structuredClone(next); }, credentials: async () => credentials, emit: () => {} });
  cleanup.push(async () => { await catalog.close(); await host.stop(); push.close(); });
  const ring = async (topic: string, epoch = 2) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ v: 1, topic, ep: epoch, n: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'catalog-k', typ: RING_TYP }).setIssuedAt(now).setExpirationTime(now + 60).sign(privateKey);
    await channel.publish(topic, token); await catalog.settled(); await tick();
  };
  return { catalog, host, push, channel, subscriptions, trusted, ring, signerKeys, get created() { return created; }, get saved() { return saved; } };
}

it('first open retains an eligible project by default, without downloading other memberships or changing recents', async () => {
  const f = await fixture();
  await f.catalog.activate(profile);
  expect((await f.catalog.list()).projects).toEqual([]);
  await expect(f.catalog.select(p('untouched'), true)).rejects.toThrow('Download and seed');
  expect(f.created).toBe(0);
  await f.host.open(p(), 'editor');
  expect(f.saved.projects.map((r) => [r.project.project, r.seedEnabled])).toEqual([['p', true]]);
  await f.catalog.select(p(), false);
  await f.host.detach('editor'); await f.host.open(p(), 'reopened');
  expect(f.saved.projects[0]?.seedEnabled).toBe(false);
  expect(JSON.stringify(f.saved)).not.toMatch(/lastOpened|recents|token|Seed|private/);
  await f.host.detach('reopened');
});

it('restores dormant projects with no actor or ticket work, one push stream, and wakes only on a verified current ring', async () => {
  const f = await fixture();
  await f.catalog.activate(profile);
  const data: SeedData = { ...f.saved, projects: Array.from({ length: 12 }, (_, i) => ({
    project: p('p' + i), seedEnabled: true, paused: false,
    doorbell: { url: 'https://push.example', topic: topic(i) }, epoch: 2, trusted: f.trusted,
  })) };
  const actual = await fixture(data, true, f.signerKeys);
  await tick(); await tick();
  expect(actual.created).toBe(0);
  expect(actual.subscriptions.size).toBe(1);
  expect((await actual.catalog.list()).projects.every((r) => r.stage === 'dormant')).toBe(true);
  vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(3 * 3600_000); vi.useRealTimers();
  expect(actual.created).toBe(0);
  // Wrong signer and old epoch both leave every runtime asleep.
  const wrong = await fixture();
  const now = Math.floor(Date.now() / 1000);
  const forged = await new SignJWT({ v: 1, topic: topic(0), ep: 2, n: crypto.randomUUID() })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'catalog-k', typ: RING_TYP }).setIssuedAt(now).setExpirationTime(now + 60).sign(wrong.signerKeys.privateKey);
  await actual.channel.publish(topic(0), forged); await actual.catalog.settled(); await tick(); expect(actual.created).toBe(0);
  await actual.ring(topic(0), 1); expect(actual.created).toBe(0);
  await actual.ring(topic(0), 2); expect(actual.created).toBe(1);
  expect(actual.host.registry.demand(p('p0'))).toEqual(['background']);
  await actual.catalog.deactivate(); await tick(); await tick();
  expect(actual.subscriptions.size).toBe(0);
  expect(actual.host.registry.keys()).toEqual([]);
});

it('global disable releases only background demand; persistent pause and logout remove ring subscriptions', async () => {
  const f = await fixture(); await f.catalog.activate(profile);
  await f.catalog.select(p(), true, true);
  expect(f.host.registry.demand(p())).toEqual(['background']);
  await f.host.open(p(), 'editor');
  await f.catalog.settings({ background: false }); await tick();
  expect(f.host.registry.demand(p())).toEqual(['editor']);
  await f.catalog.pause(p(), true);
  expect(f.saved.projects[0]?.paused).toBe(true);
  expect(f.host.registry.get(p())?.runtime.paused).toBe(true);
  await f.catalog.deactivate();
  expect((await f.catalog.list()).projects).toEqual([]);
  expect(f.saved.active).toBeNull();
  await expect(f.catalog.select({ ...p(), account: 'other' }, true)).rejects.toThrow('eligible');
  await f.host.detach('editor');
});

it('locked credentials do not invent an identity or subscribe a retained account', async () => {
  const data: SeedData = { ...emptySeedData(), active: profile, projects: [{ project: p(), seedEnabled: true,
    paused: false, doorbell: { url: 'https://push.example', topic: 'htlocked' }, epoch: 2,
    trusted: [{ kid: 'k', jwk: { kty: 'OKP' } }] }] };
  const f = await fixture(data, false); await tick();
  expect((await f.catalog.list()).projects[0]?.stage).toBe('auth-required');
  expect(f.created).toBe(0); expect(f.subscriptions.size).toBe(0);
});
it('persistent Work offline remains in force after catalog restart and a healthy resume signal', async () => {
  const first = await fixture(); await first.catalog.activate(profile);
  await first.catalog.select(p(), true, true);
  await first.catalog.settings({ paused: true });
  const restored = await fixture(first.saved);
  await restored.catalog.resume(); await tick();
  await expect.poll(async () => (await restored.catalog.list()).paused, { timeout: 15_000 }).toBe(true);
  expect(restored.created).toBe(0); expect(restored.subscriptions.size).toBe(0);
});
it('a healthy resume restores previously awake background demand and leaves dormant projects asleep', async () => {
  const f = await fixture(); await f.catalog.activate(profile);
  await f.catalog.select(p(), true, true);
  expect(f.created).toBe(1);
  await f.catalog.networkLost(); await tick();
  expect(f.host.registry.keys()).toEqual([]);
  await f.catalog.resume();
  await expect.poll(() => f.created).toBe(2);
  expect(f.host.registry.demand(p())).toEqual(['background']);
});

it('keeps at most four background projects awake, queues the rest, and rotates them in when an awake one sleeps', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const f = await fixture();
  await f.catalog.activate(profile);
  const data: SeedData = { ...f.saved, projects: Array.from({ length: 5 }, (_, i) => ({
    project: p('q' + i), seedEnabled: true, paused: false,
    doorbell: { url: 'https://push.example', topic: topic(i) }, epoch: 2, trusted: f.trusted,
  })) };
  const actual = await fixture(data, true, f.signerKeys);
  await tick(); await tick();
  for (let i = 0; i < 5; i++) await actual.ring(topic(i));
  await tick();
  expect(actual.created).toBe(4);
  const stages = (await actual.catalog.list()).projects.map((r) => r.stage);
  expect(stages.filter((s) => s === 'queued')).toHaveLength(1);
  // With no peer to serve, awake seeds go back to sleep at their next check and the queued project wakes.
  await vi.advanceTimersByTimeAsync(31_000); await tick();
  expect(actual.created).toBe(5);
  expect((await actual.catalog.list()).projects.some((r) => r.stage === 'queued')).toBe(false);
});

it('reports every documented seed status: disabled, paused, offline, ring channel unreachable; viewers cannot seed', async () => {
  const f = await fixture(); await f.catalog.activate(profile);
  const retained = () => ({ ...f.saved, projects: [{ project: p(), seedEnabled: true, paused: false,
    doorbell: { url: 'https://push.example', topic: topic(0) }, epoch: 2, trusted: f.trusted }] });
  const stage = async (c: SeedCatalog) => (await c.list()).projects[0]?.stage;
  const a = await fixture(retained(), true, f.signerKeys);
  await expect.poll(() => stage(a.catalog)).toBe('dormant');
  await a.catalog.select(p(), false); expect(await stage(a.catalog)).toBe('disabled');
  await a.catalog.select(p(), true); await a.catalog.pause(p(), true); expect(await stage(a.catalog)).toBe('paused');
  await a.catalog.pause(p(), false); await a.catalog.networkLost(); expect(await stage(a.catalog)).toBe('offline');
  const b = await fixture(retained(), true, f.signerKeys, 'unavailable');
  await expect.poll(() => stage(b.catalog)).toBe('ring-channel-unreachable');
  expect(b.created).toBe(0);
  await expect(b.catalog.select({ ...p('v'), role: 'viewer' }, true, true)).rejects.toThrow('not eligible');
});

it('wants router port mapping only for a signed-in, unpaused account with an actively syncing project', async () => {
  const f = await fixture();
  expect(f.catalog.upnpWanted()).toBe(false); // signed out
  await f.catalog.activate(profile);
  expect(f.catalog.upnpWanted()).toBe(false); // nothing running
  await f.host.open(p(), 'editor');
  const runtime = f.host.registry.get(p())!.runtime;
  // The fixture runtime is local (offline by construction): local mode never maps.
  expect(runtime.offline).toBe(true);
  expect(f.catalog.upnpWanted()).toBe(false);
  (runtime as { offline: boolean }).offline = false; // as a networked runtime would be
  expect(f.catalog.upnpWanted()).toBe(true);
  await f.catalog.settings({ upnp: false });
  expect(f.catalog.upnpWanted()).toBe(false);
  expect((await f.catalog.list()).upnp).toBe(false);
  expect(f.saved.upnp).toBe(false);
  await f.catalog.settings({ upnp: true, paused: true });
  expect(f.catalog.upnpWanted()).toBe(false); // global Work offline
  await f.catalog.settings({ paused: false });
  expect(f.catalog.upnpWanted()).toBe(true);
  await f.catalog.networkLost();
  expect(f.catalog.upnpWanted()).toBe(false);
  await f.host.detach('editor');
  await f.catalog.deactivate();
  expect(f.catalog.upnpWanted()).toBe(false); // logout
});

it('quit reports projects that cannot save; a closed window detaches only editor attachments', async () => {
  const f = await fixture(); await f.catalog.activate(profile);
  await f.catalog.select(p(), true, true); // background seed
  await f.host.open(p(), 'editor');
  expect(f.host.registry.demand(p()).sort()).toEqual(['background', 'editor']);
  expect(await f.host.flushAll()).toEqual([]);
  const runtime = f.host.registry.get(p())!.runtime;
  (runtime as { saveFailing: boolean }).saveFailing = true;
  expect(await f.host.flushAll()).toEqual(['p']); // the app stays open and offers recovery
  (runtime as { saveFailing: boolean }).saveFailing = false;
  await f.host.detachAll(); // the renderer went away
  expect(f.host.registry.demand(p())).toEqual(['background']); // the seed continues
});

it('server rollout switches turn background demand and port mapping off without touching the open editor', async () => {
  const f = await fixture(); await f.catalog.activate(profile);
  await f.catalog.select(p(), true, true);
  await f.host.open(p(), 'editor');
  const runtime = f.host.registry.get(p())!.runtime;
  (runtime as { offline: boolean }).offline = false;
  expect(f.host.registry.demand(p()).sort()).toEqual(['background', 'editor']);
  expect(f.catalog.upnpWanted()).toBe(true);
  f.catalog.ticket(p(), runtime, { ticket: 't', expiresAt: Date.now() + 60_000, features: { background: false, upnp: false } });
  await tick(); await tick();
  await expect.poll(async () => f.host.registry.demand(p()), { timeout: 15_000 }).toEqual(['editor']); // the foreground stays current
  expect(f.catalog.upnpWanted()).toBe(false);
  expect((await f.catalog.list()).projects[0]?.stage).toBe('disabled');
  expect(f.saved.rollout).toEqual({ background: false, upnp: false }); // applies at the next start without a request
  f.catalog.ticket(p(), runtime, { ticket: 't', expiresAt: Date.now() + 60_000, features: { background: true, upnp: true } });
  await tick();
  await expect.poll(async () => f.catalog.upnpWanted(), { timeout: 15_000 }).toBe(true);
  expect(f.saved.rollout).toEqual({ background: true, upnp: true });
  await f.host.detach('editor');
});

it('keeps a current-run session usable without persisting the active account or token, then allows a successful retry', async () => {
  const f = await fixture();
  await f.catalog.activate(profile, { token: 'live-only', remembered: false });
  await f.host.open(p(), 'editor');
  expect(f.saved.active).toBeNull();
  expect(JSON.stringify(f.saved)).not.toContain('live-only');
  expect((await f.catalog.list()).projects).toHaveLength(1);
  await f.catalog.activate(profile, { token: 'remembered-session', remembered: true });
  expect(f.saved.active).toEqual(profile);
  expect(JSON.stringify(f.saved)).not.toContain('remembered-session');
  await f.host.detach('editor');
});
