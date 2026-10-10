import { generateDeviceKeys } from '@hivetex/crypto';
import {
  BlobManager,
  ConnectionManager,
  Mesh,
  MemoryPersistence,
  ProjectModel,
} from '@hivetex/sync';
import { FakeRtcNetwork, inProcessSocket } from '@hivetex/sync/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.js';
import { MemorySignalBackend, createSignalSession } from '../src/signal/hub.js';
import { Client, type TestEnv, makeEnv, register } from './helpers.js';

let env: TestEnv;
let backend: MemorySignalBackend;
let rtc: FakeRtcNetwork;
const cleanup: Array<() => void> = [];

beforeEach(async () => {
  env = await makeEnv();
  backend = new MemorySignalBackend();
  rtc = new FakeRtcNetwork();
});
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}

async function trusted() {
  return (await new Client(env).get('/keys')).json.keys;
}

interface Dev {
  name: string;
  model: ProjectModel;
  mesh: Mesh;
  mgr: ConnectionManager;
  blobs: BlobManager;
  store: MemoryPersistence;
  dev: string;
}

async function makeDevice(client: Client, pid: string, name: string, extra: { linkTimeoutMs?: number; maxBackoffMs?: number } = {}): Promise<Dev> {
  const keys = await generateDeviceKeys();
  const dev = (await client.post('/devices', { ed25519Pub: keys.edPub, x25519Pub: keys.xPub, label: name })).json.deviceId as string;
  const ticket = (await client.post(`/projects/${pid}/ticket`, { deviceId: dev })).json.ticket as string;
  const store = new MemoryPersistence();
  const model = new ProjectModel(store, { flushMs: 5 });
  await model.init();
  const tk = await trusted();
  const mesh = new Mesh({ projectId: pid, model, keys, trusted: tk, getTicket: () => ticket, now: env.deps.now });
  const blobs = new BlobManager(mesh, store);
  const mgr = new ConnectionManager({
    mesh,
    projectId: pid,
    keys,
    trusted: tk,
    getTicket: () => ticket,
    signalUrl: 'ws://test/api/signal',
    wsFactory: () => inProcessSocket((sock) => createSignalSession(sock, env.deps, backend)),
    rtcFactory: rtc.factory,
    getIceServers: async () => [],
    now: env.deps.now,
    idleCloseMs: 50,
    ...extra,
  });
  cleanup.push(() => {
    mgr.stop();
    mesh.destroy();
  });
  return { name, model, mesh, mgr, blobs, store, dev };
}

async function setupProject(slug = 'e2e-project-1') {
  const owner = await register(env, 'olga');
  const pid = (await owner.post('/projects', { slug, password: 'project-secret-1' })).json.project.id as string;
  const join = async (name: string) => {
    const c = await register(env, name);
    await c.post('/projects/join', { slug, password: 'project-secret-1' });
    return c;
  };
  return { owner, pid, join };
}

describe('P2P bootstrap and content privacy (5.3, 6.9)', () => {
  it('connects peers through the signaling relay then the mesh, closing sockets once connected', async () => {
    const { owner, pid, join } = await setupProject();
    const [bob, cy] = [await join('bob'), await join('cyd')];
    for (const [c, role] of [[bob, 'editor'], [cy, 'editor']] as const) {
      const uid = (await env.db.select().from(schema.users)).find((u) => u.username === (c === bob ? 'bob' : 'cyd'))?.id;
      await owner.patch(`/projects/${pid}/members/${uid}`, { role });
    }
    const a = await makeDevice(owner, pid, 'a');
    a.mgr.start();
    await sleep(30);
    expect(a.mgr.socketOpen).toBe(true); // lone device waits on the relay

    const b = await makeDevice(bob, pid, 'b');
    b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1);

    await waitFor(() => [a, b].filter((d) => d.mgr.socketOpen).length === 1); // non-gatekeeper hung up
    const c = await makeDevice(cy, pid, 'c');
    c.mgr.start();
    await waitFor(() => [a, b, c].every((d) => d.mesh.peers.length === 2)).catch((e) => { throw new Error(JSON.stringify([a, b, c].map((d) => ({ n: d.name, dev: d.dev, peers: d.mesh.peers.length, sock: d.mgr.socketOpen, st: d.mgr.stats, rej: d.mesh.rejected })))); });

    // exactly one gatekeeper (lowest device id) keeps a socket; the others hung up
    await waitFor(() => [a, b, c].filter((d) => d.mgr.socketOpen).length === 1);
    const gate = [a, b, c].sort((x, y) => (x.dev < y.dev ? -1 : 1))[0] as Dev;
    expect(gate.mgr.socketOpen).toBe(true);
    // at least one link was negotiated over existing mesh links rather than the server
    const viaMesh = [a, b, c].reduce((n, d) => n + d.mgr.stats.signalsViaMesh, 0);
    expect(viaMesh).toBeGreaterThan(0);
  });

  it('retries links that stall without failing, so the mesh still becomes complete', async () => {
    const { owner, pid, join } = await setupProject('retry-project-1');
    const [bob, cy] = [await join('bob'), await join('cyd')];
    for (const name of ['bob', 'cyd']) {
      const uid = (await env.db.select().from(schema.users)).find((u) => u.username === name)?.id;
      await owner.patch(`/projects/${pid}/members/${uid}`, { role: 'editor' });
    }
    rtc.stallNext = 2; // the first two WebRTC attempts hang forever (no 'failed' event)
    const devs = [await makeDevice(owner, pid, 'a', { linkTimeoutMs: 200 }), await makeDevice(bob, pid, 'b', { linkTimeoutMs: 200 }), await makeDevice(cy, pid, 'c', { linkTimeoutMs: 200 })];
    for (const d of devs) d.mgr.start();
    await waitFor(() => devs.every((d) => d.mesh.peers.length === 2), 15_000).catch((e) => {
      throw new Error(`mesh incomplete: ${JSON.stringify(devs.map((d) => ({ n: d.name, peers: d.mesh.peers.length })))} ${e}`);
    });
  }, 30_000);

  it('keeps retrying past 8 failed attempts, reports the candidate meanwhile, and records stage timestamps', async () => {
    const { owner, pid, join } = await setupProject('retry-forever-1');
    const bob = await join('bob');
    const uid = (await env.db.select().from(schema.users)).find((u) => u.username === 'bob')?.id;
    await owner.patch(`/projects/${pid}/members/${uid}`, { role: 'editor' });
    rtc.stallNext = 12; // more stalled attempts than the old cap of 8
    const opts = { linkTimeoutMs: 60, maxBackoffMs: 60 };
    const devs = [await makeDevice(owner, pid, 'a', opts), await makeDevice(bob, pid, 'b', opts)];
    let sawCandidate = false;
    for (const d of devs) d.mgr.onState(() => { sawCandidate ||= d.mgr.candidates().length > 0; });
    for (const d of devs) d.mgr.start();
    await waitFor(() => devs.every((d) => d.mesh.peers.length === 1), 20_000);
    expect(sawCandidate).toBe(true);
    const [a, b] = devs as [Dev, Dev];
    const st = a.mgr.diagnostics()[b.dev];
    expect(st?.relaySeenAt).toBeTypeOf('number');
    expect(st?.linkUpAt).toBeTypeOf('number');
    expect(devs.every((d) => d.mgr.candidates().length === 0)).toBe(true);
  }, 30_000);

  it('reconnectNow resets backoff and reaches a device that is online but not connected', async () => {
    const { owner, pid, join } = await setupProject('reconnect-now-1');
    const bob = await join('bob');
    const uid = (await env.db.select().from(schema.users)).find((u) => u.username === 'bob')?.id;
    await owner.patch(`/projects/${pid}/members/${uid}`, { role: 'editor' });
    rtc.stallNext = 3;
    const opts = { linkTimeoutMs: 100_000, maxBackoffMs: 100_000 }; // would not retry on its own within the test
    const devs = [await makeDevice(owner, pid, 'a', opts), await makeDevice(bob, pid, 'b', opts)];
    for (const d of devs) d.mgr.start();
    await sleep(300);
    expect(devs.some((d) => d.mesh.peers.length > 0)).toBe(false);
    expect(devs.some((d) => d.mgr.candidates().length > 0)).toBe(true);
    rtc.stallNext = 0;
    for (const d of devs) d.mgr.reconnectNow();
    await waitFor(() => devs.every((d) => d.mesh.peers.length === 1), 10_000);
  }, 30_000);

  it('keeps document text, file names and blobs off the control plane', async () => {
    const { owner, pid, join } = await setupProject('privacy-project-1');
    const bob = await join('bob');
    const bobId = (await env.db.select().from(schema.users)).find((u) => u.username === 'bob')?.id;
    await owner.patch(`/projects/${pid}/members/${bobId}`, { role: 'editor' });
    const a = await makeDevice(owner, pid, 'a');
    const b = await makeDevice(bob, pid, 'b');
    a.mgr.start();
    b.mgr.start();
    await waitFor(() => a.mesh.peers.length === 1 && b.mesh.peers.length === 1);

    const SECRET = 'TOP-SECRET-UNPUBLISHED-RESULT-4242';
    const NAME = 'confidential-chapter.tex';
    const id = await a.model.createTextNow(NAME, `\\section{${SECRET}}`);
    const blobBytes = new TextEncoder().encode(`PNGDATA-${SECRET}`);
    const hash = await a.blobs.add(blobBytes);
    a.model.createBinary('figures/secret.png', hash, blobBytes.length);

    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await b.model.openText(id)).toString().includes(SECRET));
    expect(new TextDecoder().decode(await b.blobs.fetch(hash, 5000))).toContain(SECRET);
    (await b.model.openText(id)).insert(0, `% edited by bob ${SECRET}\n`);
    await sleep(100);
    await a.mgr.stop(); // force everything through persistence/disconnect paths too

    const dump = JSON.stringify({
      tables: {
        users: await env.db.select().from(schema.users),
        sessions: await env.db.select().from(schema.sessions),
        projects: await env.db.select().from(schema.projects),
        memberships: await env.db.select().from(schema.memberships),
        devices: await env.db.select().from(schema.devices),
        audit: await env.db.select().from(schema.auditLog),
      },
      relay: backend.log,
      presence: await backend.getPresence(pid),
      mail: (env.mailer as unknown as { sent: unknown[] }).sent,
    });
    for (const needle of [SECRET, NAME, 'secret.png', 'PNGDATA', 'section']) expect(dump).not.toContain(needle);
    expect(backend.log.length).toBeGreaterThan(0); // the relay did carry (encrypted) setup traffic
  });

  it('fails closed if the relay swaps SDP fingerprints (man-in-the-middle)', async () => {
    const { owner, pid, join } = await setupProject('mitm-project-1');
    const bob = await join('bob');
    const bobId = (await env.db.select().from(schema.users)).find((u) => u.username === 'bob')?.id;
    await owner.patch(`/projects/${pid}/members/${bobId}`, { role: 'editor' });
    rtc.tamper = (sdp) => sdp.replace(/a=fingerprint:sha-256 \S+/, 'a=fingerprint:sha-256 EVIL:EVIL');
    const a = await makeDevice(owner, pid, 'a');
    const b = await makeDevice(bob, pid, 'b');
    a.mgr.start();
    b.mgr.start();
    await sleep(600);
    expect(a.mesh.peers).toHaveLength(0);
    expect(b.mesh.peers).toHaveLength(0);
    expect(a.mesh.rejected.length + b.mesh.rejected.length).toBeGreaterThan(0);
  });
});
