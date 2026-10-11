import { type StoredDeviceKeys, generateDeviceKeys, open, seal, sign, toB64u } from '@hivetex/crypto';
import { signalAuthMessage } from '@hivetex/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { cloudflareTurn } from '../src/signal/turn.js';
import { MemorySignalBackend, createSignalSession, parseLease } from '../src/signal/hub.js';
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
  /** Answers the relay's challenge with a signature from `keys` (the honest client does this automatically). */
  async auth(who: { ticket: string; keys: StoredDeviceKeys }, pid = PID.value) {
    const ch = await this.until((m) => m.t === 'challenge');
    const dev = JSON.parse(Buffer.from(who.ticket.split('.')[1] ?? '', 'base64url').toString()).dev as string;
    const sig = await sign(who.keys, new TextEncoder().encode(signalAuthMessage(pid, dev, ch.nonce as string)));
    await this.say({ t: 'auth', ticket: who.ticket, sig: toB64u(sig) });
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

const PID = { value: '' };

async function setup() {
  const owner = await register(env, 'olga');
  const pr = await owner.post('/projects', { slug: 'signal-proj-1', password: 'project-secret-1' });
  const pid = pr.json.project.id as string;
  PID.value = pid;
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
    await sa.auth(a);
    await sa.until((m) => m.t === 'ready');
    await sb.auth(b);
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
    await s1.say({ t: 'auth', ticket: 'not.a.ticket', sig: 'AAAA' });
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
    await sa.auth(a);
    await sb.auth(b);
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
    await s.auth(a);
    await s.until((m) => m.t === 'ready');
    await new Promise((r) => setTimeout(r, 700));
    expect(s.closed?.code).toBe(4401);
    env.deps.now = real;
  });

  it('rate limits chatty sockets', async () => {
    const { a } = await setup();
    const s = connect(new MemorySignalBackend());
    await s.auth(a);
    for (let i = 0; i < 70; i++) await s.say({ t: 'ping' });
    expect(s.closed?.code).toBe(4429);
  });
});

describe('signaling key-possession proof (security)', () => {
  it('a member with a copied ticket but without the device key cannot appear or make the device disappear', async () => {
    const { a, b } = await setup();
    const backend = new MemorySignalBackend();
    const victim = connect(backend);
    await victim.auth(a);
    await victim.until((m) => m.t === 'ready');
    const watcher = connect(backend);
    await watcher.auth(b);
    await watcher.until((m) => m.t === 'ready');

    // b learned a's ticket from presence and tries to connect as a, signing with b's own key
    const thief = connect(backend);
    await thief.auth({ ticket: a.ticket, keys: b.keys });
    expect(thief.closed?.code).toBe(4401);
    // a ticket without any signature is refused too (old clients)
    const old = connect(backend);
    await old.say({ t: 'auth', ticket: a.ticket });
    expect(old.closed?.code).toBe(4401);
    await old.handlers.onClose();
    await thief.handlers.onClose();
    await new Promise((r) => setTimeout(r, 20));
    // no fake leave: a is still present for everyone
    expect(watcher.inbox.some((m) => m.t === 'leave' && m.dev === JSON.parse(Buffer.from(a.ticket.split('.')[1] ?? '', 'base64url').toString()).dev)).toBe(false);
    expect(Object.keys(await backend.getPresence(PID.value))).toHaveLength(2);
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

describe('signaling session ids (reconnect race)', () => {
  it("an old session closing after the device's new session joined keeps the new presence and announces no leave", async () => {
    const { a, b, pid } = await setup();
    const backend = new MemorySignalBackend();
    const watcher = connect(backend);
    await watcher.auth(b);
    await watcher.until((m) => m.t === 'ready');
    const old = connect(backend);
    await old.auth(a);
    const firstJoin = await watcher.until((m) => m.t === 'join' && m.dev === a.dev);
    // quick reload: the new session joins before the old socket's close is processed
    const fresh = connect(backend);
    await fresh.auth(a);
    await watcher.until((m) => m.t === 'join' && m.dev === a.dev && m.sid !== firstJoin.sid);
    await old.handlers.onClose();
    await new Promise((r) => setTimeout(r, 20));
    expect(watcher.inbox.some((m) => m.t === 'leave')).toBe(false);
    const presence = await backend.getPresence(pid);
    expect(Object.keys(presence)).toContain(a.dev);
    expect(presence[a.dev]).toContain(a.ticket);
    // a third device sees the reloaded device as present
    const late = connect(backend);
    await late.auth(b);
    const ready = await late.until((m) => m.t === 'ready');
    expect(ready.tickets).toContain(a.ticket);
    // the new session leaving is a real departure
    await fresh.handlers.onClose();
    await watcher.until((m) => m.t === 'leave' && m.dev === a.dev);
  });

  it('compare-and-delete only removes the entry of the given session', async () => {
    const backend = new MemorySignalBackend();
    await backend.setPresence('p', 'd', 's2|tok', 90);
    expect(await backend.removePresence('p', 'd', 's1')).toBe(false);
    expect(await backend.getPresence('p')).toEqual({ d: 's2|tok' });
    expect(await backend.removePresence('p', 'd', 's2')).toBe(true);
    expect(await backend.getPresence('p')).toEqual({});
  });
});

/** A backend whose clock the test advances, so presence leases really expire (the default backend ignores TTLs). */
function leasedBackend() {
  const clock = { ms: 1_000_000 };
  return { clock, backend: new MemorySignalBackend({ now: () => clock.ms }) };
}

describe('per-device presence leases (F08)', () => {
  it('an idle device without heartbeat expires from discovery after the lease', async () => {
    const { a, b } = await setup();
    const { clock, backend } = leasedBackend();
    const sa = connect(backend);
    await sa.auth(a);
    await sa.until((m) => m.t === 'ready');
    clock.ms += 91_000;
    const sb = connect(backend);
    await sb.auth(b);
    const ready = await sb.until((m) => m.t === 'ready');
    expect(ready.tickets).toEqual([]);
  });

  for (const [idle, late] of [['a', 'b'], ['b', 'a']] as const) {
    it(`a heartbeating idle device stays discoverable for a late joiner (idle ${idle}, late ${late})`, async () => {
      const t = await setup();
      const { clock, backend } = leasedBackend();
      const sIdle = connect(backend);
      await sIdle.auth(t[idle]);
      await sIdle.until((m) => m.t === 'ready');
      for (let i = 0; i < 6; i++) {
        clock.ms += 30_000; // 180 s idle in total, beyond the 90 s lease
        await sIdle.say({ t: 'ping' });
      }
      const sLate = connect(backend);
      await sLate.auth(t[late]);
      const ready = await sLate.until((m) => m.t === 'ready');
      expect(ready.tickets).toEqual([t[idle].ticket]);
      // additive: the session id of every listed device, keyed by device
      expect(Object.keys(ready.sessions as object)).toEqual([t[idle].dev]);
      expect(typeof (ready.sessions as Record<string, string>)[t[idle].dev]).toBe('string');
    });
  }

  it('a heartbeat after the lease expired restores the entry of the same session', async () => {
    const { a, b } = await setup();
    const { clock, backend } = leasedBackend();
    const sa = connect(backend);
    await sa.auth(a);
    await sa.until((m) => m.t === 'ready');
    clock.ms += 200_000; // e.g. a throttled background tab
    expect(await backend.getPresence(PID.value)).toEqual({});
    await sa.say({ t: 'ping' });
    const sb = connect(backend);
    await sb.auth(b);
    expect((await sb.until((m) => m.t === 'ready')).tickets).toEqual([a.ticket]);
  });

  it("an old session's heartbeat cannot reclaim or renew the entry of the device's newer session", async () => {
    const { a, b } = await setup();
    const { clock, backend } = leasedBackend();
    const old = connect(backend);
    await old.auth(a);
    await old.until((m) => m.t === 'ready');
    const fresh = connect(backend);
    await fresh.auth(a);
    await fresh.until((m) => m.t === 'ready');
    const entry = (await backend.getPresence(PID.value))[a.dev];
    clock.ms += 60_000;
    await old.say({ t: 'ping' });
    expect((await backend.getPresence(PID.value))[a.dev]).toBe(entry); // still the new session's entry
    // the old session closing late neither removes the new entry nor announces a leave
    await old.handlers.onClose();
    expect((await backend.getPresence(PID.value))[a.dev]).toBe(entry);
    const sb = connect(backend);
    await sb.auth(b);
    expect((await sb.until((m) => m.t === 'ready')).tickets).toEqual([a.ticket]);
  });

  it('an old session closing after its lease was taken over by a newer one removes nothing, and renew is compare-and-set', async () => {
    const { clock, backend } = leasedBackend();
    await backend.setPresence('p', 'd', 's2|tok', 90);
    expect(await backend.renewPresence('p', 'd', 's1', 90)).toBe(false);
    clock.ms += 80_000;
    expect(await backend.renewPresence('p', 'd', 's2', 90)).toBe(true);
    clock.ms += 80_000;
    expect(await backend.getPresence('p')).toEqual({ d: 's2|tok' }); // renewed: still alive
    clock.ms += 20_000;
    expect(await backend.renewPresence('p', 'd', 's2', 90)).toBe(false); // expired: not resurrected by renew
    expect(await backend.removePresence('p', 'd', 's2')).toBe(false);
    expect(await backend.getPresence('p')).toEqual({});
  });

  it('expires each device lease on its own, not the whole project at once', async () => {
    const { clock, backend } = leasedBackend();
    await backend.setPresence('p', 'x', 's1|t1', 90);
    clock.ms += 60_000;
    await backend.setPresence('p', 'y', 's2|t2', 90);
    clock.ms += 40_000; // x is 100 s old, y 40 s
    expect(await backend.getPresence('p')).toEqual({ y: 's2|t2' });
  });
});

describe('redis lease encoding', () => {
  it('reads leased and legacy presence values', () => {
    expect(parseLease('1700000000000;sid|a.b.c')).toEqual({ exp: 1700000000000, value: 'sid|a.b.c' });
    expect(parseLease('sid|a.b.c')).toEqual({ exp: null, value: 'sid|a.b.c' }); // written before leases existed
    expect(parseLease('a.b.c')).toEqual({ exp: null, value: 'a.b.c' });
  });
});
