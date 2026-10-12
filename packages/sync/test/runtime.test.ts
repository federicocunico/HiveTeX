import { generateDeviceKeys } from '@hivetex/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionManager, ManagerOptions } from '../src/connect.js';
import { MemoryPersistence } from '../src/persistence.js';
import { ProjectRuntime, type RuntimeAdapters, type TicketAnswer } from '../src/runtime.js';

/** 4.1: the framework-neutral project actor, driven through injected adapters only (no DOM, no Svelte, no Tauri). */
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ticketFor = (dev: string, role = 'editor', ep = 1) => `h.${b64({ dev, role, ep, exp: Math.floor(Date.now() / 1000) + 900, uname: 'ann' })}.s`;

interface World {
  online: boolean;
  calls: string[];
  refuse?: number;
  gate?: Promise<void> | undefined;
  managers: Array<{ started: boolean; stopped: boolean; options: ManagerOptions }>;
}
function adapters(w: World): RuntimeAdapters {
  const net = async <T>(name: string, value: () => T) => {
    w.calls.push(name);
    if (!w.online) throw Object.assign(new Error('offline'), { status: 0 });
    return value();
  };
  return {
    registerDevice: () => net('register', () => 'dev-real'),
    loadTrusted: () => net('keys', () => [{ kid: 'k1', jwk: { kty: 'OKP' } }]),
    fetchTicket: async (deviceId) => {
      await w.gate;
      return net('ticket', (): TicketAnswer => {
        if (w.refuse) throw Object.assign(new Error('refused'), { status: w.refuse });
        return { ticket: ticketFor(deviceId), expiresAt: Date.now() + 15 * 60_000, epoch: 1 };
      });
    },
    ring: () => net('ring', () => ({ url: 'x', topic: 't', token: 'k' })),
    iceServers: async () => [],
    signalUrl: 'ws://test',
    wsFactory: () => { throw new Error('no sockets in this test'); },
    rtcFactory: () => () => { throw new Error('no rtc'); },
    createManager: (options) => {
      const m = {
        started: false, stopped: false, options,
        start() { m.started = true; }, stop() { m.stopped = true; },
        onState() {}, candidates: () => [], diagnostics: () => ({}), routes: () => ({}), reconnectNow() {},
        setDoorbellAvailable() {}, answerRing() {}, doorbellMode: false, socketOpen: false,
      };
      w.managers.push(m);
      return m as unknown as ConnectionManager;
    },
  };
}
const runtimes: ProjectRuntime[] = [];
afterEach(async () => { for (const r of runtimes.splice(0)) await r.close(); });
async function runtime(w: World, o: { deviceId?: string | null; isLocal?: boolean } = {}) {
  const r = new ProjectRuntime({
    projectId: 'p', isLocal: o.isLocal ?? false, role: 'editor', createdHere: false, store: new MemoryPersistence(),
    keys: await generateDeviceKeys(), deviceId: o.deviceId === undefined ? null : o.deviceId, canWrite: () => true,
    adapters: adapters(w), retryMs: 30, randomId: () => 'tmp',
  });
  runtimes.push(r);
  await r.open();
  return r;
}
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((res) => setTimeout(res, 5));
  }
};

describe('project runtime (4.1)', () => {
  it('starts offline with a temporary id, then registers, loads keys and gets a ticket by itself', async () => {
    const w: World = { online: false, calls: [], managers: [] };
    const r = await runtime(w);
    expect(r.deviceId).toBe('offline-tmp');
    r.startNetworking();
    await until(() => r.offline);
    expect(w.calls).toEqual(['register']); // never a ticket request for the temporary identity
    w.online = true;
    await until(() => !r.offline && w.managers.length === 1, 3000);
    expect(r.deviceId).toBe('dev-real');
    expect(r.trusted).toHaveLength(1);
    expect(w.managers[0]?.started).toBe(true);
    expect(w.calls.filter((c) => c === 'ticket').length).toBeGreaterThan(0);
  });

  it('treats a refused ticket as revocation, not as being offline', async () => {
    const w: World = { online: true, calls: [], managers: [], refuse: 403 };
    const r = await runtime(w, { deviceId: 'dev-real' });
    r.startNetworking();
    await until(() => r.revoked);
    expect(r.role).toBe('viewer');
    expect(r.offline).toBe(false);
    expect(w.managers).toHaveLength(0);
  });
  it('a later membership refusal stops the existing signaling manager before reporting revocation', async () => {
    const w: World = { online: true, calls: [], managers: [] };
    const r = await runtime(w, { deviceId: 'dev-real' });
    r.startNetworking();
    await until(() => w.managers.length === 1);
    w.refuse = 403;
    await r.refreshTicketNow();
    expect(r.revoked).toBe(true);
    expect(w.managers[0]?.stopped).toBe(true);
    expect(r.managerDiagnostics.socketOpen).toBe(false);
    expect(r.role).toBe('viewer');
  });

  it('a local project never contacts anyone', async () => {
    const w: World = { online: true, calls: [], managers: [] };
    const r = await runtime(w, { isLocal: true });
    r.startNetworking();
    r.networkRestored();
    await r.refreshTicketNow();
    await new Promise((res) => setTimeout(res, 50));
    expect(w.calls).toEqual([]);
    expect(r.offline).toBe(true);
  });
  it('a native network-down signal stops requests until healthy resume, and persistent pause still wins', async () => {
    const w: World = { online: true, calls: [], managers: [] };
    const r = await runtime(w, { deviceId: 'dev-real' });
    r.networkLost(); r.startNetworking();
    await r.refreshTicketNow(); expect(w.calls).toEqual([]);
    r.networkRestored(); await until(() => w.managers.length === 1);
    r.setPaused(true); const before = w.calls.length;
    r.networkLost(); r.networkRestored();
    await r.refreshTicketNow(); expect(w.calls.length).toBe(before);
  });

  it('pausing drops a ticket request in flight; resuming recovers; closing stops everything', async () => {
    let release!: () => void;
    const w: World = { online: true, calls: [], managers: [], gate: new Promise<void>((res) => (release = res)) };
    const r = await runtime(w, { deviceId: 'dev-real' });
    r.startNetworking();
    await until(() => w.calls.includes('keys'));
    r.setPaused(true);
    release();
    await new Promise((res) => setTimeout(res, 50));
    expect(w.managers).toHaveLength(0); // the late answer was dropped
    w.gate = undefined;
    r.setPaused(false);
    await until(() => w.managers.length === 1);
    await r.close();
    expect(w.managers[0]?.stopped).toBe(true);
    const before = w.calls.length;
    await r.refreshTicketNow();
    expect(w.calls.length).toBe(before);
  });
});

describe('sync-only startup (4.3)', () => {
  it('the runtime module graph reaches no compiler, backup or folder service', async () => {
    const { readFileSync } = await import('node:fs');
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
        const spec = m[1] as string;
        expect(spec).not.toMatch(/@hivetex\/(compile|github)|mirror|tauri/);
        if (spec.startsWith('./')) visit(spec.slice(2).replace(/\.js$/, '.ts'));
      }
    };
    visit('runtime.ts');
    expect(seen.has('connect.ts')).toBe(true);
  });
});
