import { generateDeviceKeys, open, seal } from '@p2platex/crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { cloudflareTurn } from '../src/signal/turn.js';
import { MemorySignalBackend, createSignalSession } from '../src/signal/hub.js';
import { Client, type TestEnv, makeEnv, register } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await makeEnv();
});

class FakeSocket {
  inbox: Array<Record<string, unknown>> = [];
  closed: { code?: number; reason?: string } | null = null;
  handlers!: ReturnType<typeof createSignalSession>;
  send = (d: string) => void this.inbox.push(JSON.parse(d));
  close = (code?: number, reason?: string) => {
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
  };
  async say(o: unknown) {
    await this.handlers.onMessage(JSON.stringify(o));
  }
  async until(pred: (m: Record<string, unknown>) => boolean, ms = 1000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = this.inbox.find(pred);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error(`no message; got ${JSON.stringify(this.inbox)}`);
  }
}

async function setup() {
  const owner = await register(env, 'olga');
  const pr = await owner.post('/projects', { slug: 'signal-proj-1', password: 'project-secret-1' });
  const pid = pr.json.project.id as string;
  const joiner = await register(env, 'jim');
  await joiner.post('/projects/join', { slug: 'signal-proj-1', password: 'project-secret-1' });
  const mk = async (c: Client) => {
    const keys = await generateDeviceKeys();
    const dev = (await c.post('/devices', { ed25519Pub: keys.edPub, x25519Pub: keys.xPub })).json.deviceId as string;
    const ticket = (await c.post(`/projects/${pid}/ticket`, { deviceId: dev })).json.ticket as string;
    return { keys, dev, ticket };
  };
  return { owner, joiner, pid, a: await mk(owner), b: await mk(joiner) };
}

function connect(backend: MemorySignalBackend) {
  const sock = new FakeSocket();
  sock.handlers = createSignalSession(sock, env.deps, backend);
  return sock;
}

describe('signaling relay (5.1)', () => {
  it('relays ciphertext between instances sharing a backend, and the server only sees ciphertext', async () => {
    const { a, b } = await setup();
    const backend = new MemorySignalBackend(); // shared pub/sub = Upstash across function instances
    const sa = connect(backend);
    const sb = connect(backend); // "different instance"
    await sa.say({ t: 'auth', ticket: a.ticket });
    await sa.until((m) => m.t === 'ready');
    await sb.say({ t: 'auth', ticket: b.ticket });
    const ready = await sb.until((m) => m.t === 'ready');
    expect(ready.tickets).toEqual([a.ticket]); // presence
    await sa.until((m) => m.t === 'join');

    const secret = new TextEncoder().encode('{"sdp":"v=0 a=fingerprint:sha-256 AA:BB"}');
    const env1 = await seal(a.keys, b.keys.xPub, secret, 'aad');
    await sa.say({ t: 'sig', to: b.dev, env: Buffer.from(env1).toString('base64') });
    const got = await sb.until((m) => m.t === 'sig');
    expect(got.from).toBe(a.dev);
    const plain = await open(b.keys, a.keys.xPub, new Uint8Array(Buffer.from(got.env as string, 'base64')), 'aad');
    expect(new TextDecoder().decode(plain)).toContain('fingerprint');
    // nothing the backend saw contains the plaintext
    expect(backend.log.join('\n')).not.toContain('fingerprint');
    expect(backend.log.join('\n')).not.toContain('sdp');
  });

  it('rejects bad tickets and unauthenticated messages', async () => {
    const backend = new MemorySignalBackend();
    const s1 = connect(backend);
    await s1.say({ t: 'auth', ticket: 'not.a.ticket' });
    expect(s1.closed?.code).toBe(4401);
    const s2 = connect(backend);
    await s2.say({ t: 'sig', to: 'x', env: 'y' });
    expect(s2.closed?.code).toBe(4401);
  });

  it('only delivers messages addressed to the device, and announces leaves', async () => {
    const { a, b } = await setup();
    const backend = new MemorySignalBackend();
    const sa = connect(backend);
    const sb = connect(backend);
    await sa.say({ t: 'auth', ticket: a.ticket });
    await sb.say({ t: 'auth', ticket: b.ticket });
    await sb.until((m) => m.t === 'ready');
    await sa.say({ t: 'sig', to: 'someone-else', env: 'AAAA' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sb.inbox.some((m) => m.t === 'sig')).toBe(false);
    await sb.handlers.onClose();
    await sa.until((m) => m.t === 'leave' && m.dev === b.dev);
  });

  it('closes the socket when the ticket expires', async () => {
    const { a } = await setup();
    const backend = new MemorySignalBackend();
    const real = env.deps.now;
    env.deps.now = () => new Date(real().getTime() + 14.99 * 60_000);
    const s = connect(backend);
    await s.say({ t: 'auth', ticket: a.ticket });
    await s.until((m) => m.t === 'ready');
    await new Promise((r) => setTimeout(r, 700));
    expect(s.closed?.code).toBe(4401);
    env.deps.now = real;
  });

  it('rate limits chatty sockets', async () => {
    const { a } = await setup();
    const s = connect(new MemorySignalBackend());
    await s.say({ t: 'auth', ticket: a.ticket });
    for (let i = 0; i < 70; i++) await s.say({ t: 'ping' });
    expect(s.closed?.code).toBe(4429);
  });
});

describe('TURN credentials (5.2)', () => {
  it('requires membership and returns STUN plus relay with an expiry', async () => {
    const { owner, pid } = await setup();
    env.deps.turn = {
      mint: async () => ({ iceServers: [{ urls: ['turn:turn.example.org:3478'], username: 'u', credential: 'p' }] }),
    };
    const ok = await owner.post('/turn', { projectId: pid });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.json.iceServers)).toContain('stun:');
    expect(JSON.stringify(ok.json.iceServers)).toContain('turn:turn.example.org');
    expect(ok.json.expiresAt).toBeGreaterThan(env.deps.now().getTime());

    const outsider = await register(env, 'otto');
    expect((await outsider.post('/turn', { projectId: pid })).status).toBe(403);
    expect((await new Client(env).post('/turn', { projectId: pid })).status).toBe(401);
  });

  it('falls back to STUN only when the provider fails', async () => {
    const { owner, pid } = await setup();
    env.deps.turn = {
      mint: async () => {
        throw new Error('down');
      },
    };
    const r = await owner.post('/turn', { projectId: pid });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json.iceServers)).not.toContain('turn:');
  });

  it('cloudflare provider calls the documented endpoint with a bearer token and ttl', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ iceServers: { urls: ['turn:t.cloudflare.com:3478'], username: 'x', credential: 'y' } }));
    }) as unknown as typeof fetch;
    const r = await cloudflareTurn('KEYID', 'TOKEN', fake).mint(3600);
    expect(seen?.url).toContain('/turn/keys/KEYID/credentials/generate-ice-servers');
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN');
    expect(JSON.parse(String(seen?.init.body))).toEqual({ ttl: 3600 });
    expect(r.iceServers[0]?.username).toBe('x');
  });

  it('rate limits per user', async () => {
    const { owner, pid } = await setup();
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await owner.post('/turn', { projectId: pid })).status;
    expect(last).toBe(429);
  });
});
