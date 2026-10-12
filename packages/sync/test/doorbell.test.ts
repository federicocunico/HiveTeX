import { randomBytes } from 'node:crypto';
import { RING_TYP, type TrustedKey } from '@hivetex/protocol';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { Doorbell, ntfyChannel, type PushChannel, type PushState } from '../src/doorbell.js';

const TOPIC = 'htabcdefghijklmnopqrstuvwxyz';
const OTHER = 'ht234567abcdefghijklmnopqrst';
async function signer(kid = 'k1') {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const trusted: TrustedKey[] = [{ kid, jwk: { ...(await exportJWK(publicKey)), alg: 'EdDSA' } }];
  const sign = (o: { topic?: string; ep?: number; iat?: number; ttl?: number; n?: string; typ?: string } = {}) => {
    const iat = o.iat ?? Math.floor(Date.now() / 1000);
    return new SignJWT({ v: 1, topic: o.topic ?? TOPIC, ep: o.ep ?? 1, n: o.n ?? randomBytes(16).toString('base64url') })
      .setProtectedHeader({ alg: 'EdDSA', kid, typ: o.typ ?? RING_TYP })
      .setIssuedAt(iat)
      .setExpirationTime(iat + (o.ttl ?? 60))
      .sign(privateKey);
  };
  return { trusted, sign };
}

/** An in-memory push service: every published message reaches the current subscribers of its topic. */
function memoryPush() {
  const subs = new Set<{ topics: string[]; cb: (t: string, m: string) => void }>();
  let state: PushState = 'subscribed';
  const published: Array<[string, string]> = [];
  const channel: PushChannel = {
    subscribe(topics, onMessage, onState) {
      const s = { topics, cb: onMessage };
      subs.add(s);
      onState(state);
      return () => { subs.delete(s); };
    },
    async publish(topic, message) {
      published.push([topic, message]);
      for (const s of subs) if (s.topics.includes(topic)) s.cb(topic, message);
    },
  };
  return { channel, published, deliver: (t: string, m: string) => { for (const s of subs) if (s.topics.includes(t)) s.cb(t, m); }, subscriptions: () => subs.size, setState: (s: PushState) => { state = s; } };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const bells: Doorbell[] = [];
afterEach(() => { for (const b of bells.splice(0)) b.close(); });

describe('doorbell verification and wake budget (3B.2)', () => {
  it('wakes once for a valid ring and ignores forged, expired, replayed, wrong-topic and old-epoch rings', async () => {
    const { trusted, sign } = await signer();
    const forger = await signer();
    const push = memoryPush();
    let now = Date.now();
    const bell = new Doorbell({ channel: () => push.channel, trusted: () => trusted, now: () => now, minWakeIntervalMs: 0 });
    bells.push(bell);
    const woke: number[] = [];
    bell.register('p', { url: 'https://push', topic: TOPIC }, 2, (c) => woke.push(c.ep));
    await tick();
    expect(push.subscriptions()).toBe(1);
    const good = await sign({ ep: 2 });
    push.deliver(TOPIC, good);
    await tick();
    expect(woke).toEqual([2]);
    push.deliver(TOPIC, good); // replay
    push.deliver(TOPIC, await forger.sign({ ep: 2 })); // not signed by the control plane
    push.deliver(TOPIC, await sign({ ep: 1 })); // older epoch (a removed member's knowledge)
    push.deliver(TOPIC, await sign({ topic: OTHER, ep: 2 })); // token for another topic
    push.deliver(TOPIC, await sign({ ep: 2, typ: 'hivetex-ticket' }));
    push.deliver(TOPIC, 'not even a token');
    push.deliver(TOPIC, await sign({ ep: 2, iat: Math.floor(now / 1000) - 600 })); // expired
    await tick(30);
    expect(woke).toEqual([2]);
    expect(bell.stats.dropped).toBe(7);
    now += 1;
  });

  it('enforces the per-project wake interval and hourly budget', async () => {
    const { trusted, sign } = await signer();
    const push = memoryPush();
    let now = Date.now();
    const bell = new Doorbell({ channel: () => push.channel, trusted: () => trusted, now: () => now, minWakeIntervalMs: 10_000, maxWakesPerHour: 3 });
    bells.push(bell);
    let wakes = 0;
    bell.register('p', { url: 'https://push', topic: TOPIC }, 1, () => { wakes++; });
    await tick();
    for (let i = 0; i < 2; i++) { push.deliver(TOPIC, await sign()); await tick(); }
    expect(wakes).toBe(1); // second ring within 10 s
    for (let i = 0; i < 4; i++) { now += 11_000; push.deliver(TOPIC, await sign({ iat: Math.floor(now / 1000) })); await tick(); }
    expect(wakes).toBe(3); // hourly budget
  });

  it('multiplexes all projects onto one subscription per push service and follows topic changes', async () => {
    const { trusted, sign } = await signer();
    const push = memoryPush();
    const channels: string[] = [];
    const bell = new Doorbell({ channel: (url) => { channels.push(url); return push.channel; }, trusted: () => trusted, minWakeIntervalMs: 0 });
    bells.push(bell);
    const got: string[] = [];
    bell.register('a', { url: 'https://push', topic: TOPIC }, 1, () => got.push('a'));
    const offB = bell.register('b', { url: 'https://push', topic: OTHER }, 1, () => got.push('b'));
    await tick();
    expect(push.subscriptions()).toBe(1);
    push.deliver(OTHER, await sign({ topic: OTHER }));
    // Verification is asynchronous (signature check): wait for it rather than for a fixed tick.
    await expect.poll(() => got, { timeout: 5000 }).toEqual(['b']);
    offB();
    await tick();
    push.deliver(OTHER, await sign({ topic: OTHER }));
    await tick();
    expect(got).toEqual(['b']);
    // Epoch change: the project moves to a new topic, the old one is no longer subscribed.
    bell.register('a', { url: 'https://push', topic: OTHER }, 2, () => got.push('a2'));
    await tick();
    push.deliver(TOPIC, await sign({ ep: 2 }));
    push.deliver(OTHER, await sign({ topic: OTHER, ep: 2 }));
    await tick();
    expect(got).toEqual(['b', 'a2']);
    await bell.ring({ url: 'https://push', topic: OTHER }, 'token');
    expect(push.published.at(-1)).toEqual([OTHER, 'token']);
  });

  it('reports the push state so callers can stay reachable without it', async () => {
    const { trusted } = await signer();
    const push = memoryPush();
    push.setState('unavailable');
    const bell = new Doorbell({ channel: () => push.channel, trusted: () => trusted });
    bells.push(bell);
    expect(bell.state('p')).toBe('off');
    bell.register('p', { url: 'https://push', topic: TOPIC }, 1, () => {});
    await tick();
    expect(bell.state('p')).toBe('unavailable');
  });
});

describe('ntfy channel', () => {
  const stream = (lines: unknown[], hold = true) => {
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; for (const l of lines) c.enqueue(new TextEncoder().encode(`${JSON.stringify(l)}\n`)); if (!hold) c.close(); } });
    return { body, push: (l: unknown) => ctl.enqueue(new TextEncoder().encode(`${JSON.stringify(l)}\n`)), end: () => ctl.close() };
  };
  it('streams messages of its topics, publishes without caching and reconnects with backoff', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const streams: Array<ReturnType<typeof stream>> = [];
    let failNext = 1;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (init?.method === 'POST') return new Response('{}');
      if (failNext-- > 0) return new Response('busy', { status: 503 });
      const s = stream([{ event: 'open' }]);
      streams.push(s);
      return new Response(s.body);
    }) as unknown as typeof fetch;
    const ch = ntfyChannel('https://push.test/', { fetch: fetchFn, random: () => 0.5, maxBackoffMs: 20 });
    const got: string[] = [];
    const states: PushState[] = [];
    const close = ch.subscribe([TOPIC, OTHER], (t, m) => got.push(`${t}:${m}`), (s) => states.push(s));
    await new Promise((r) => setTimeout(r, 1200));
    expect(calls[0]?.url).toBe(`https://push.test/${TOPIC},${OTHER}/json`);
    expect(states).toContain('subscribed');
    streams[0]?.push({ event: 'message', topic: TOPIC, message: 'ring' });
    streams[0]?.push({ event: 'message', topic: 'htsomeoneelse234567abcdefgh', message: 'x' });
    streams[0]?.push({ event: 'keepalive' });
    await tick(20);
    expect(got).toEqual([`${TOPIC}:ring`]);
    streams[0]?.end(); // the service drops the stream: reconnect
    await new Promise((r) => setTimeout(r, 1300));
    expect(streams.length).toBe(2);
    await ch.publish(TOPIC, 'tok');
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post?.url).toBe(`https://push.test/${TOPIC}`);
    expect((post?.init?.headers as Record<string, string>).Cache).toBe('no');
    close();
    expect(states.at(-1)).toBe('off');
  });

  it('becomes unavailable after repeated failures and keeps retrying', async () => {
    let n = 0;
    const fetchFn = (async () => { n++; throw new Error('offline'); }) as unknown as typeof fetch;
    const states: PushState[] = [];
    const close = ntfyChannel('https://push.test', { fetch: fetchFn, random: () => 0.5, maxBackoffMs: 5, unavailableAfter: 3 }).subscribe([TOPIC], () => {}, (s) => states.push(s));
    await new Promise((r) => setTimeout(r, 2500));
    close();
    expect(states).toContain('unavailable');
    expect(n).toBeGreaterThanOrEqual(4);
  });
});
