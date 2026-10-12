// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { type StoredDeviceKeys, generateDeviceKeys } from '@hivetex/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The session's connectivity bootstrap (F07, F10): a shared project opened without the control plane recovers its
 * device registration, trusted keys and membership ticket by itself, and a closed or paused session never restarts.
 */

const world = vi.hoisted(() => ({
  online: false,
  /** The control plane knows this device id. */
  knownDevice: 'dev-real',
  stored: { keys: null as unknown, deviceId: null as string | null },
  calls: [] as string[],
  tickets: 0,
  ticketGate: null as null | Promise<void>,
  managers: [] as Array<{ started: boolean; stopped: boolean }>,
  /** What the fake manager reports: relying on the doorbell (no gatekeeper socket). */
  doorbellMode: false,
}));

vi.mock('../src/lib/api.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/api.js')>();
  return {
    ...real,
    api: vi.fn(async (method: string, path: string, body?: { deviceId?: string }) => {
      world.calls.push(`${method} ${path}`);
      if (!world.online) throw new real.ApiError(0, 'network', 'Cannot reach the server');
      if (path === '/keys') return { keys: [{ kid: 'k1', jwk: { kty: 'OKP' } }] };
      if (path === '/devices') {
        world.stored.deviceId = world.knownDevice;
        return { deviceId: world.knownDevice };
      }
      if (path.endsWith('/ticket')) {
        world.tickets++;
        if (world.ticketGate) await world.ticketGate;
        if (body?.deviceId !== world.knownDevice) throw new real.ApiError(404, 'not_found', 'Unknown device');
        const claims = { dev: world.knownDevice, role: 'editor', ep: 1, exp: Math.floor(Date.now() / 1000) + 900 };
        return { ticket: `h.${btoa(JSON.stringify(claims))}.s`, expiresAt: Date.now() + 15 * 60_000 };
      }
      if (path === '/turn') return { iceServers: [], expiresAt: Date.now() + 3_600_000 };
      throw new real.ApiError(404, 'not_found', path);
    }),
  };
});

vi.mock('../src/lib/keys.js', () => ({
  localKeys: vi.fn(async () => world.stored),
  registerKeys: vi.fn(async (_u: string, keys: StoredDeviceKeys) => {
    world.calls.push('register');
    if (!world.online) throw new Error('Cannot reach the server');
    world.stored = { keys, deviceId: world.knownDevice };
    return world.knownDevice;
  }),
  // the previous bootstrap's entry point
  ensureRegistered: vi.fn(async () => {
    world.calls.push('register');
    if (!world.online) throw new Error('Cannot reach the server');
    world.stored.deviceId ??= world.knownDevice;
    return { keys: world.stored.keys, deviceId: world.stored.deviceId };
  }),
}));

vi.mock('@hivetex/sync', async (orig) => {
  const real = await orig<typeof import('@hivetex/sync')>();
  class FakeManager {
    started = false;
    stopped = false;
    constructor() {
      world.managers.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
    }
    onState() {}
    candidates() {
      return [];
    }
    diagnostics() {
      return {};
    }
    reconnectNow() {}
    routes() {
      return {};
    }
    setDoorbellAvailable() {}
    answerRing() {}
    get doorbellMode() {
      return world.doorbellMode;
    }
    socketOpen = false;
  }
  return { ...real, ConnectionManager: FakeManager };
});

import { api } from '../src/lib/api.js';
import { createLocalProject, localProjectInfo } from '../src/lib/local-projects.js';
import { type ProjectInfo, ProjectSession } from '../src/lib/session.svelte.js';

const project = (id = 'proj-1'): ProjectInfo => ({ id, slug: 'thesis', role: 'editor', defaultRole: 'editor', passwordProtected: false, epoch: 1 });
const sessions: ProjectSession[] = [];

async function openSession(p: ProjectInfo = project()) {
  const s = new ProjectSession(p, { id: 'u1', username: 'ann' });
  sessions.push(s);
  await s.open();
  return s;
}
/** Opens while the control plane is unreachable and waits until the first bootstrap attempt has failed. */
async function openOffline() {
  const s = await openSession();
  await vi.waitFor(() => expect(s.offline).toBe(true));
  return s;
}
const running = () => world.managers.filter((m) => m.started && !m.stopped);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('hivetex.compileMode', 'peers'); // no compiler needed for these tests
  world.online = false;
  world.knownDevice = 'dev-real';
  world.stored = { keys: await generateDeviceKeys(), deviceId: null };
  world.calls = [];
  world.tickets = 0;
  world.ticketGate = null;
  world.managers = [];
  world.doorbellMode = false;
  vi.mocked(api).mockClear();
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => {});
  vi.useRealTimers();
});

describe('recovery after offline startup (F07)', () => {
  it('a device that was never registered registers, loads the trusted keys and gets a ticket once the network is back', async () => {
    const s = await openOffline();
    expect(world.managers).toHaveLength(0);
    world.online = true;
    await s.refreshTicketNow(); // what the retry timer and the browser's online event do
    expect(s.offline).toBe(false);
    expect(s.revoked).toBe(false);
    expect(s.myDeviceId).toBe('dev-real');
    expect(world.stored.deviceId).toBe('dev-real');
    expect(running()).toHaveLength(1); // peer discovery started without reopening
    // no ticket was ever requested for the temporary identity
    expect(api).not.toHaveBeenCalledWith('POST', '/projects/proj-1/ticket', { deviceId: expect.stringMatching(/^offline-/) });
  });

  it('a registered device keeps its identity when only the trusted keys cannot be loaded', async () => {
    world.stored.deviceId = 'dev-real';
    const s = await openOffline();
    expect(s.myDeviceId).toBe('dev-real'); // not replaced by a throwaway identity
    world.online = true;
    await s.refreshTicketNow();
    expect(s.offline).toBe(false);
    expect(s.revoked).toBe(false);
    expect(running()).toHaveLength(1);
    // the keys arrived in the array the mesh already verifies with (it is the same object)
    expect((s as unknown as { trusted: unknown[] }).trusted).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem('hivetex.trusted') ?? '[]')).toHaveLength(1);
  });

  it('retries on its own timer while offline, and the failures of an unregistered device are no revocation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await openOffline();
    await vi.advanceTimersByTimeAsync(15_000); // still offline: tries again, still no ticket requested
    expect(world.tickets).toBe(0);
    expect(s.revoked).toBe(false);
    world.online = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    expect(s.revoked).toBe(false);
    expect(s.offline).toBe(false);
  });

  it('recovers at once when the browser reports that the network is back', async () => {
    const s = await openOffline();
    world.online = true;
    // the connectivity event brings the session back without any user action
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(running()).toHaveLength(1), { timeout: 3000 });
    expect(s.revoked).toBe(false);
    expect(s.offline).toBe(false);
  });

  it('only one registration is in flight however often recovery is requested', async () => {
    const s = await openOffline();
    world.calls = [];
    world.online = true;
    await Promise.all([s.refreshTicketNow(), s.refreshTicketNow(), s.refreshTicketNow()]);
    expect(world.calls.filter((c) => c === 'register')).toHaveLength(1);
    expect(running()).toHaveLength(1);
  });
});

describe('session-owned work stops with the session (F10)', () => {
  it('a ticket response arriving after close does not start a manager or schedule a refresh', async () => {
    world.stored.deviceId = 'dev-real';
    world.online = true;
    let release!: () => void;
    world.ticketGate = new Promise<void>((r) => (release = r));
    const s = await openSession(); // the ticket request is pending
    await vi.waitFor(() => expect(world.tickets).toBe(1));
    await s.close();
    release();
    await sleep(50);
    expect(world.managers).toHaveLength(0);
    expect((s as unknown as { runtime: { ticketTimer: unknown } }).runtime.ticketTimer).toBeNull();
  });

  it('pausing cancels a pending ticket request; resuming recovers', async () => {
    world.stored.deviceId = 'dev-real';
    world.online = true;
    let release!: () => void;
    world.ticketGate = new Promise<void>((r) => (release = r));
    const s = await openSession();
    await vi.waitFor(() => expect(world.tickets).toBe(1));
    s.setPaused(true);
    release();
    await sleep(50);
    expect(world.managers).toHaveLength(0);
    expect((s as unknown as { runtime: { ticketTimer: unknown } }).runtime.ticketTimer).toBeNull();
    world.ticketGate = null;
    s.setPaused(false);
    await vi.waitFor(() => expect(running()).toHaveLength(1));
  });

  it('repeated pause and resume leaves exactly one running manager and stops the others', async () => {
    world.stored.deviceId = 'dev-real';
    world.online = true;
    const s = await openSession();
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    for (let i = 0; i < 3; i++) {
      s.setPaused(true);
      s.setPaused(false);
      await vi.waitFor(() => expect(running()).toHaveLength(1));
    }
    expect(world.managers.filter((m) => !m.stopped)).toHaveLength(1);
  });

  it('an explicit local project makes no server request at all', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const p = localProjectInfo(createLocalProject('Notes'));
    world.online = true;
    const s = await openSession(p);
    await s.refreshTicketNow();
    await sleep(20);
    expect(api).not.toHaveBeenCalled();
    expect(world.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(world.managers).toHaveLength(0);
    fetchSpy.mockRestore();
  });
});

describe('zero idle cost (3B.4)', () => {
  it('stops renewing the ticket while alone without a socket in doorbell mode, and keeps renewing otherwise', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    world.online = true;
    world.doorbellMode = true;
    world.stored.deviceId = 'dev-real';
    await openSession();
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    const first = world.tickets;
    await vi.advanceTimersByTimeAsync(3 * 3600_000);
    expect(world.tickets).toBe(first); // dormant: nobody needs a fresh ticket, nothing is requested
    world.doorbellMode = false;
    await openSession(project('proj-2'));
    const before = world.tickets;
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(world.tickets).toBeGreaterThan(before + 2); // gatekeeper mode renews as before
  });
});

describe('editor detach versus background demand (7.4)', () => {
  it('closing the workspace keeps the runtime while a background lease remains, and the last release stops it', async () => {
    world.online = true;
    world.stored.deviceId = 'dev-real';
    const { runtimes } = await import('../src/lib/runtimes.js');
    const s = await openSession();
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    const key = { server: (await import('../src/lib/api.js')).apiBase(), account: 'u1', project: 'proj-1' };
    const seed = runtimes.attach(key, 'background');
    await seed.runtime;
    await s.close();
    sessions.splice(sessions.indexOf(s), 1);
    expect(running()).toHaveLength(1); // the seed keeps synchronizing without the editor
    expect(runtimes.get(key)).not.toBeNull();
    await seed.release();
    expect(running()).toHaveLength(0);
    expect(runtimes.get(key)).toBeNull();
  });
});
