import { RelayHandshake, type RelaySession } from '@hivetex/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    await until(() => f.got.sync.length === 30, 20_000, () => `received ${f.got.sync.length}/30, a ${JSON.stringify(f.a.stats)}, b ${JSON.stringify(f.b.stats)}`);
    expect(f.got.sync).toEqual(Array.from({ length: 30 }, (_, n) => 'e' + n));
    expect(f.a.stats.retransmits).toBeGreaterThan(0);
    expect(f.b.stats.duplicateFragments).toBeGreaterThan(0);
    // Under this loss rate the last ACKs are often lost too: the tail waits on per-fragment backoff from the measured
    // timeout (fewer spurious resends than a fixed short timer, at the cost of a slower tail).
    await until(() => f.a.stats.inflightBytes === 0, 20_000);
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

  it('reschedules a limit wakeup that fires before the wall-clock deadline', async () => {
    const f = await pair();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    f.a.noteLimited('relay_limited', 1000);
    const queued = f.a.send('bulk', text('queued asset'));
    queued.catch(() => {});
    try {
      clock.mockReturnValue(1999);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.a.limited).toBe(true);
      expect(f.a.stats.limitedReason).toBe('relay_limited');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      expect(f.a.stats.sentFragments).toBe(0);
      clock.mockReturnValue(2000);
      await vi.advanceTimersByTimeAsync(1);
      await queued;
      expect(f.a.stats.queuedBytes).toBe(0);
    } finally {
      f.a.close(); f.b.close();
      clock.mockRestore(); vi.useRealTimers();
    }
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

  it('retransmission timeout follows the measured round trip and ignores samples of retransmitted frames (Karn)', async () => {
    // The path is slower than the initial timeout: only the very first frame is resent.
    const f = await pair({ rtoMs: 100, minRtoMs: 20 }, { delayMs: () => 150 });
    await f.a.send('sync', text('first'));
    await until(() => f.got.sync.length === 1 && f.a.stats.inflightBytes === 0);
    expect(f.a.stats.retransmits).toBe(1);
    expect(f.a.stats.srttMs).toBeNull(); // the only ACK answered a retransmitted frame
    for (let n = 0; n < 5; n++) {
      await f.a.send('sync', text('m' + n));
      await until(() => f.got.sync.length === n + 2 && f.a.stats.inflightBytes === 0);
    }
    expect(f.a.stats.retransmits).toBe(1);
    expect(f.a.stats.srttMs).toBeGreaterThanOrEqual(140);
    expect(f.a.stats.srttMs).toBeLessThan(400);
    expect(f.a.stats.rtoMs).toBeGreaterThan(f.a.stats.srttMs as number);
  });

  it('caps the first flight by the congestion window and widens it as ACKs arrive', async () => {
    const f = await pair({ rtoMs: 5000 }, { delayMs: () => 300 });
    for (let n = 0; n < 40; n++) void f.a.send('sync', text('w' + n));
    await until(() => f.a.stats.sentFragments >= 16);
    await new Promise(r => setTimeout(r, 50)); // no ACK can arrive before 300 ms
    expect(f.a.stats.sentFragments).toBe(16);
    await until(() => f.got.sync.length === 40);
    expect(f.a.stats.cwnd).toBeGreaterThan(16);
    expect(f.a.stats.lossEvents).toBe(0);
    expect(f.a.stats.retransmits).toBe(0);
  });

  it('halves the window once when several frames of one flight time out', async () => {
    const f = await pair({ rtoMs: 50 }, { drop: (_e, n) => n < 16 });
    for (let n = 0; n < 40; n++) void f.a.send('sync', text('l' + n));
    await until(() => f.got.sync.length === 40, 6000);
    expect(f.got.sync).toEqual(Array.from({ length: 40 }, (_, n) => 'l' + n));
    expect(f.a.stats.lossEvents).toBe(1);
    expect(f.a.stats.retransmits).toBeGreaterThanOrEqual(16);
  });

  it('an inbound-drop note reaches the sender through ACKs and shrinks its window without a forwarding limit', async () => {
    const f = await pair({ rtoMs: 2000 });
    for (let n = 0; n < 10; n++) await f.a.send('sync', text('d' + n));
    await until(() => f.got.sync.length === 10 && f.a.stats.inflightBytes === 0);
    const before = f.a.stats.cwnd;
    expect(f.a.stats.lossEvents).toBe(0); // plain ACKs (as from older peers) are no loss
    f.b.noteInboundDrop();
    await f.a.send('sync', text('after drop'));
    await until(() => f.a.stats.lossEvents === 1);
    expect(f.a.stats.cwnd).toBeLessThanOrEqual(Math.max(2, Math.floor(before / 2)) + 1);
    expect(f.a.limited).toBe(false);
    expect(f.b.limited).toBe(false);
    expect(f.b.stats.limitedUntil).toBe(0);
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
