import { generateDeviceKeys } from '@hivetex/crypto';
import type { DoorbellInfo } from '@hivetex/protocol';
import { ConnectionManager, Doorbell, type ManagerOptions, Mesh, MemoryPersistence, ProjectModel, ntfyChannel, type WebSocketLike } from '@hivetex/sync';
import { FakeRtcNetwork, inProcessSocket } from '@hivetex/sync/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.js';
import { createDevPush } from '../src/dev-push.js';
import { MemorySignalBackend, createSignalSession } from '../src/signal/hub.js';
import { Client, type TestEnv, makeEnv, register } from './helpers.js';

/**
 * 3B.3: doorbell mode end to end with the real hub, the real ring endpoint and an ntfy-compatible push service. Nobody
 * keeps a gatekeeper socket; a ring wakes exactly the devices that must answer.
 */
let env: TestEnv;
let backend: MemorySignalBackend;
let rtc: FakeRtcNetwork;
let push: ReturnType<typeof createDevPush>;
const cleanup: Array<() => void> = [];
const PUSH = 'http://push.test';
const pushFetch = ((url: string, init?: RequestInit) => push.app.request(url.slice(PUSH.length), init)) as unknown as typeof fetch;

beforeEach(async () => {
  env = await makeEnv();
  env.deps.config.doorbellUrl = PUSH;
  backend = new MemorySignalBackend();
  rtc = new FakeRtcNetwork();
  push = createDevPush(1000);
});
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}

interface Dev { name: string; dev: string; model: ProjectModel; mesh: Mesh; mgr: ConnectionManager; sockets: WebSocketLike[]; bell: Doorbell | null; requests: string[] }
async function makeDevice(client: Client, pid: string, name: string, o: { bell?: boolean; channel?: typeof ntfyChannel } & Partial<Omit<ManagerOptions, 'doorbell'>> = {}): Promise<Dev> {
  const { bell: useBell = true, channel = ntfyChannel, ...extra } = o;
  const keys = await generateDeviceKeys();
  const dev = (await client.post('/devices', { ed25519Pub: keys.edPub, x25519Pub: keys.xPub, label: name })).json.deviceId as string;
  const requests: string[] = [];
  const t = (await client.post(`/projects/${pid}/ticket`, { deviceId: dev })).json as { ticket: string; epoch: number; doorbell?: DoorbellInfo };
  const ticket = t.ticket;
  const model = new ProjectModel(new MemoryPersistence(), { flushMs: 5 });
  await model.init();
  const tk = (await new Client(env).get('/keys')).json.keys;
  const mesh = new Mesh({ projectId: pid, model, keys, trusted: tk, getTicket: () => ticket, now: env.deps.now });
  const sockets: WebSocketLike[] = [];
  const bell = useBell && t.doorbell ? new Doorbell({ channel: (url) => channel(url, { fetch: pushFetch, maxBackoffMs: 50 }), trusted: () => tk, now: () => env.deps.now().getTime(), minWakeIntervalMs: 0 }) : null;
  const mgr = new ConnectionManager({
    mesh, projectId: pid, keys, trusted: tk, getTicket: () => ticket, signalUrl: 'ws://test/api/signal',
    wsFactory: () => {
      requests.push('socket');
      const ws = inProcessSocket((sock) => createSignalSession(sock, env.deps, backend));
      sockets.push(ws);
      return ws;
    },
    rtcFactory: rtc.factory, getIceServers: async () => [], now: env.deps.now, idleCloseMs: 20,
    introductionWindowMs: 2000, introductionMinMs: 300, answerJitterMs: 50,
    ...(bell
      ? {
          doorbell: {
            ring: async () => {
              requests.push('ring');
              const r = await client.post(`/projects/${pid}/ring`, { deviceId: dev });
              if (r.status !== 200) return false;
              await bell.ring({ url: r.json.url, topic: r.json.topic }, r.json.token);
              return true;
            },
          },
        }
      : {}),
    ...extra,
  });
  if (bell && t.doorbell) {
    bell.register(pid, t.doorbell, t.epoch, () => mgr.answerRing());
    bell.onState(() => mgr.setDoorbellAvailable(bell.state(pid) === 'subscribed'));
  }
  cleanup.push(() => { mgr.stop(); mesh.destroy(); bell?.close(); });
  return { name, dev, model, mesh, mgr, sockets, bell, requests };
}
async function project(slug: string, names: string[]) {
  const owner = await register(env, names[0] as string);
  const pid = (await owner.post('/projects', { slug, password: 'project-secret-1' })).json.project.id as string;
  const others: Client[] = [];
  for (const n of names.slice(1)) {
    const c = await register(env, n);
    await c.post('/projects/join', { slug, password: 'project-secret-1' });
    const uid = (await env.db.select().from(schema.users)).find((u) => u.username === n)?.id;
    await owner.patch(`/projects/${pid}/members/${uid}`, { role: 'editor' });
    others.push(c);
  }
  return { pid, clients: [owner, ...others] };
}
const subscribed = async (d: Dev) => waitFor(() => d.mgr.doorbellMode);

describe('doorbell introductions (3B.3)', () => {
  it('a lone device closes its socket after the window; a newcomer rings it awake; then nobody keeps a socket', async () => {
    const { pid, clients } = await project('bell-e2e-1', ['olga', 'bob']);
    const a = await makeDevice(clients[0] as Client, pid, 'a');
    await subscribed(a);
    a.mgr.start();
    await waitFor(() => a.mgr.socketOpen);
    await waitFor(() => !a.mgr.socketOpen, 4000); // nobody answered: the socket closes, the device waits for rings
    const idleRequests = a.requests.length;
    await sleep(800);
    expect(a.requests.length).toBe(idleRequests); // idle: no socket, no request
    const b = await makeDevice(clients[1] as Client, pid, 'b');
    await subscribed(b);
    b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1);
    expect(a.mgr.stats.answers).toBe(1);
    const id = await a.model.createTextNow('bell.tex', 'woken by the doorbell');
    await waitFor(() => b.model.files.has(id));
    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await b.model.openText(id)).toString() === 'woken by the doorbell');
    await waitFor(() => !a.mgr.socketOpen && !b.mgr.socketOpen, 4000);
    (await a.model.openText(id)).insert(0, 'p2p: ');
    await waitFor(async () => (await b.model.openText(id)).toString().startsWith('p2p: '));
    expect(a.mgr.socketOpen || b.mgr.socketOpen).toBe(false);
  }, 30_000);

  it('a ring reaching an existing mesh is answered by its representative only; peer exchange does the rest', async () => {
    const { pid, clients } = await project('bell-e2e-2', ['olga', 'bob', 'cyd']);
    const [a, b] = [await makeDevice(clients[0] as Client, pid, 'a'), await makeDevice(clients[1] as Client, pid, 'b')];
    await subscribed(a); await subscribed(b);
    a.mgr.start(); b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1);
    await waitFor(() => !a.mgr.socketOpen && !b.mgr.socketOpen, 4000);
    const answersBefore = a.mgr.stats.answers + b.mgr.stats.answers;
    const c = await makeDevice(clients[2] as Client, pid, 'c');
    await subscribed(c);
    c.mgr.start();
    await waitFor(() => c.mesh.peers.length === 2 && a.mesh.peers.length === 2 && b.mesh.peers.length === 2, 10_000);
    expect(a.mgr.stats.answers + b.mgr.stats.answers - answersBefore).toBe(1);
    const rep = [a, b].sort((x, y) => (x.dev < y.dev ? -1 : 1))[0] as Dev;
    expect(rep.mgr.stats.answers).toBeGreaterThan(0);
    await waitFor(() => [a, b, c].every((d) => !d.mgr.socketOpen), 4000);
  }, 30_000);

  it('interoperates with an older gatekeeper client and falls back to a gatekeeper socket without the push channel', async () => {
    const { pid, clients } = await project('bell-e2e-3', ['olga', 'bob', 'cyd']);
    const old = await makeDevice(clients[0] as Client, pid, 'old', { bell: false });
    old.mgr.start();
    await waitFor(() => old.mgr.socketOpen);
    const cur = await makeDevice(clients[1] as Client, pid, 'cur');
    await subscribed(cur);
    cur.mgr.start();
    await waitFor(() => old.mesh.peers.length === 1 && cur.mesh.peers.length === 1);
    // A push service that never answers: the device keeps today's behaviour and stays reachable while open.
    const dead = (() => ({ subscribe: (_t: string[], _m: unknown, onState: (s: 'unavailable') => void) => { onState('unavailable'); return () => {}; }, publish: async () => {} })) as unknown as typeof ntfyChannel;
    const lone = await makeDevice(clients[2] as Client, pid, 'lone', { channel: dead });
    lone.mgr.start();
    await sleep(300);
    expect(lone.mgr.doorbellMode).toBe(false);
    await waitFor(() => lone.mesh.peers.length >= 1, 10_000);
  }, 30_000);
});
