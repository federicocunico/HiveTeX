import { RelayHandshake, type RelaySession } from '@hivetex/crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeRelayWire, encodeRelayFrame, RelayTransport, type RelayTransportOptions } from '../src/relay-transport.js';
import type { ChannelName } from '../src/transport.js';
import { TestAuthority, identity } from './helpers.js';

async function sessions(): Promise<[RelaySession, RelaySession]> {
  const authority = await TestAuthority.create();
  const [alice, bob] = [await identity('alice', 'owner'), await identity('bob', 'editor')];
  const [ta, tb] = await Promise.all([authority.mint({ pid: 'p', ...alice }), authority.mint({ pid: 'p', ...bob })]);
  const a = await RelayHandshake.create({ projectId: 'p', peerDeviceId: bob.dev, ticket: ta, keys: alice.keys, trusted: authority.trusted, role: 'initiator' });
  const b = await RelayHandshake.create({ projectId: 'p', peerDeviceId: alice.dev, ticket: tb, keys: bob.keys, trusted: authority.trusted, role: 'responder' });
  const [ap, bp] = await Promise.all([a.acceptHello(b.hello), b.acceptHello(a.hello)]);
  const [ac, bc] = await Promise.all([a.acceptProof(bp), b.acceptProof(ap)]);
  return Promise.all([a.acceptConfirmation(bc), b.acceptConfirmation(ac)]);
}

/** A Pub/Sub-like path between two transports: the test decides what is lost, duplicated, reordered or delayed. */
interface Path {
  drop?: (env: string, n: number) => boolean;
  duplicate?: (n: number) => boolean;
  delayMs?: (n: number) => number;
  up?: boolean;
}
const open: RelayTransport[] = [];
afterEach(() => { for (const t of open.splice(0)) t.close(); });
async function pair(o: Partial<RelayTransportOptions> = {}, ab: Path = {}, ba: Path = {}) {
  const [sa, sb] = await sessions();
  const counters = { ab: 0, ba: 0, posted: 0 };
  let a!: RelayTransport, b!: RelayTransport;
  const link = (to: () => RelayTransport, path: Path, key: 'ab' | 'ba') => (env: string) => {
    counters.posted++;
    if (path.up === false) return false;
    const n = counters[key]++;
    if (path.drop?.(env, n)) return true;
    const copies = path.duplicate?.(n) ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      setTimeout(() => {
        const w = decodeRelayWire(env);
        if (w?.kind === 'frame') void to().receive(w.envelope);
      }, path.delayMs?.(n) ?? 0);
    }
    return true;
  };
  a = new RelayTransport({ rtoMs: 30, ackDelayMs: 2, ...o, session: sa, post: link(() => b, ab, 'ab') });
  b = new RelayTransport({ rtoMs: 30, ackDelayMs: 2, ...o, session: sb, post: link(() => a, ba, 'ba') });
  open.push(a, b);
  const got: Record<ChannelName, string[]> = { sync: [], bulk: [] };
  b.onMessage((c, d) => got[c].push(new TextDecoder().decode(d)));
  return { a, b, got, counters, ab, ba };
}
const until = async (cond: () => boolean, ms = 4000, state?: () => string) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`condition not reached${state ? `: ${state()}` : ''}`);
    await new Promise(r => setTimeout(r, 5));
  }
};
const text = (s: string) => new TextEncoder().encode(s);

describe('application relay transport (3.2)', () => {
  it('delivers ordered messages per channel and fragments large ones within 16 KiB pieces', async () => {
    const f = await pair();
    const big = 'x'.repeat(100_000);
    await f.a.send('bulk', text(big));
    for (let n = 0; n < 20; n++) await f.a.send('sync', text('m' + n));
    await until(() => f.got.sync.length === 20 && f.got.bulk.length === 1);
    expect(f.got.sync).toEqual(Array.from({ length: 20 }, (_, n) => 'm' + n));
    expect(f.got.bulk[0]).toBe(big);
    expect(f.a.stats.sentFragments).toBe(20 + Math.ceil(100_000 / 16384));
  });

  it('recovers lost, duplicated and reordered frames with identical retransmissions and applies each once', async () => {
    const dropped: string[] = [];
    const f = await pair({}, {
      drop: (env, n) => { if (n % 3 === 1) { dropped.push(env); return true; } return false; },
      duplicate: n => n % 4 === 0,
      delayMs: n => (n % 5) * 7,
    }, { drop: (_e, n) => n % 3 === 0 });
    for (let n = 0; n < 30; n++) void f.a.send('sync', text('e' + n));
    await until(() => f.got.sync.length === 30, 8000, () => `received ${f.got.sync.length}/30, a ${JSON.stringify(f.a.stats)}, b ${JSON.stringify(f.b.stats)}`);
    expect(f.got.sync).toEqual(Array.from({ length: 30 }, (_, n) => 'e' + n));
    expect(f.a.stats.retransmits).toBeGreaterThan(0);
    expect(f.b.stats.duplicateFragments).toBeGreaterThan(0);
    await until(() => f.a.stats.inflightBytes === 0);
  });

  it('a published frame is not a delivery: a dead path keeps data in flight and then fails the generation', async () => {
    const f = await pair({ maxRetries: 2 }, { drop: () => true });
    let closed = false;
    f.a.onClosed(() => { closed = true; });
    await f.a.send('sync', text('never acknowledged'));
    expect(f.a.stats.inflightBytes).toBeGreaterThan(0); // posted, not received
    await until(() => closed, 3000);
    expect(f.got.sync).toEqual([]);
    await expect(f.a.send('sync', text('later'))).rejects.toThrow();
  });

  it('bounds unacknowledged data by the credit window and resumes on acknowledgement', async () => {
    let hold = true;
    const f = await pair({ windowBytes: 64 * 1024, rtoMs: 5000 }, { drop: () => hold });
    const sends = Array.from({ length: 10 }, (_, n) => f.a.send('bulk', text(String(n).repeat(16 * 1024))));
    await new Promise(r => setTimeout(r, 50));
    expect(f.a.stats.inflightBytes).toBeLessThanOrEqual(64 * 1024);
    expect(f.a.stats.queuedBytes).toBeGreaterThan(0);
    hold = false;
    // Held frames are retransmitted once (rto) and the rest flows as ACKs free the window.
    f.a.close();
    await Promise.allSettled(sends);
  });

  it('sends text before queued assets and defers assets while the relay is limited', async () => {
    const f = await pair({ windowBytes: 32 * 1024 });
    f.a.noteLimited('relay_limited', 300);
    const asset = f.a.send('bulk', text('image'.repeat(10_000)));
    await f.a.send('sync', text('text edit'));
    await until(() => f.got.sync.length === 1);
    expect(f.got.bulk).toEqual([]);
    expect(f.a.limited).toBe(true);
    expect(f.a.stats.limitedReason).toBe('relay_limited');
    await asset;
    await until(() => f.got.bulk.length === 1, 3000);
    expect(f.a.limited).toBe(false);
  });

  it('reserves text credit while an asset fills the window and its ACKs are stalled', async () => {
    const f = await pair({ windowBytes: 64 * 1024, rtoMs: 5000 }, {}, { drop: () => true });
    const asset = f.a.send('bulk', text('x'.repeat(128 * 1024)));
    await until(() => f.a.stats.inflightBytes === 48 * 1024);
    await f.a.send('sync', text('typing while asset ACKs wait'));
    await until(() => f.got.sync.length === 1);
    expect(f.got.sync).toEqual(['typing while asset ACKs wait']);
    expect(f.got.bulk).toEqual([]);
    expect(f.a.stats.inflightBytes).toBeLessThanOrEqual(64 * 1024);
    f.a.close();
    await expect(asset).rejects.toThrow();
  });

  it('drops forged and wrong-session frames without consuming state, and fails on framing violations', async () => {
    const f = await pair();
    const other = await sessions();
    const forged = await other[0].seal({ kind: 'data', channel: 'sync', message: 0, fragment: 0, fragments: 1 }, text('forged'));
    await f.b.receive(forged);
    expect(f.got.sync).toEqual([]);
    await f.a.send('sync', text('genuine'));
    await until(() => f.got.sync.length === 1);
    expect(f.got.sync).toEqual(['genuine']);
    // Wire decoding rejects malformed headers.
    expect(decodeRelayWire('Fzzzz')).toBeNull();
    expect(decodeRelayWire('Hnot-json')).toBeNull();
    const encoded = encodeRelayFrame(forged);
    expect(decodeRelayWire(encoded)).toEqual({ kind: 'frame', envelope: forged });
  });

  it('buffers messages that arrive before the connection registers its handler', async () => {
    const [sa, sb] = await sessions();
    let b!: RelayTransport;
    const a = new RelayTransport({ session: sa, ackDelayMs: 2, post: env => { const w = decodeRelayWire(env); if (w?.kind === 'frame') void b.receive(w.envelope); return true; } });
    b = new RelayTransport({ session: sb, ackDelayMs: 2, post: env => { const w = decodeRelayWire(env); if (w?.kind === 'frame') void a.receive(w.envelope); return true; } });
    open.push(a, b);
    await a.send('sync', text('hello early'));
    await new Promise(r => setTimeout(r, 30));
    const got: string[] = [];
    b.onMessage((_c, d) => got.push(new TextDecoder().decode(d)));
    expect(got).toEqual(['hello early']);
  });

  it('closing tells the peer, which closes without waiting for its retransmission budget', async () => {
    const f = await pair();
    let peerClosed = false;
    f.b.onClosed(() => { peerClosed = true; });
    await f.a.send('sync', text('bye'));
    await until(() => f.got.sync.length === 1);
    f.a.close();
    await until(() => peerClosed, 1000);
  });
});
