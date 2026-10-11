import { BUFFER_HIGH_WATER, FRAGMENT_SIZE } from '@hivetex/protocol';
import { describe, expect, it } from 'vitest';
import { type DataChannelLike, DataChannelTransport, FragmentedChannel, MAX_QUEUED_BYTES, fakeChannelPair } from '../src/transport.js';
import { Net, waitFor } from '../src/testkit.js';

function transportPair() {
  const [s1, s2] = fakeChannelPair(64 * 1024);
  const [b1, b2] = fakeChannelPair(64 * 1024);
  const a = new DataChannelTransport(s1, b1, 'fpA', 'fpB');
  const b = new DataChannelTransport(s2, b2, 'fpB', 'fpA');
  return { a, b };
}

describe('data channel transport (6.1)', () => {
  it('transfers 20 MB without exceeding the buffer high-water mark', async () => {
    const { a, b } = transportPair();
    const size = 20 * 1024 * 1024;
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i += 4099) payload[i] = (i / 4099) & 255;

    const got = new Promise<Uint8Array>((resolve) =>
      b.onMessage((ch, d) => {
        if (ch === 'bulk') resolve(d);
      }),
    );
    await a.send('bulk', payload);
    const received = await got;
    expect(received.length).toBe(size);
    expect(received[4099 * 10]).toBe(10);
    expect(a.peakBuffered).toBeLessThanOrEqual(BUFFER_HIGH_WATER + FRAGMENT_SIZE + 1);
    // The whole 20 MiB message sits in the outbound queue while it drains, and must fit the per-channel budget.
    expect(a.peakQueued).toBe(size);
    expect(a.peakQueued).toBeLessThanOrEqual(MAX_QUEUED_BYTES);
  }, 60_000);

  it('keeps message boundaries and order across both channels', async () => {
    const { a, b } = transportPair();
    const seen: string[] = [];
    b.onMessage((ch, d) => seen.push(`${ch}:${d.length}`));
    await Promise.all([
      a.send('sync', new Uint8Array(10)),
      a.send('sync', new Uint8Array(FRAGMENT_SIZE * 3 + 5)),
      a.send('sync', new Uint8Array(3)),
      a.send('bulk', new Uint8Array(7)),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.filter((s) => s.startsWith('sync'))).toEqual(['sync:10', `sync:${FRAGMENT_SIZE * 3 + 5}`, 'sync:3']);
    expect(seen).toContain('bulk:7');
  });

  it('reports close to both ends', async () => {
    const { a, b } = transportPair();
    let closed = 0;
    a.onClose(() => closed++);
    b.onClose(() => closed++);
    a.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(2);
  });
});

/** A channel whose buffer sits above the high-water mark and never fires `bufferedamountlow`. */
class StalledChannel implements DataChannelLike {
  readyState: DataChannelLike['readyState'] = 'open';
  bufferedAmount = BUFFER_HIGH_WATER * 2;
  bufferedAmountLowThreshold = 0;
  binaryType = 'arraybuffer';
  sent = 0;
  onmessage: DataChannelLike['onmessage'] = null;
  onclose: DataChannelLike['onclose'] = null;
  onerror: (() => void) | null = null;
  onbufferedamountlow: DataChannelLike['onbufferedamountlow'] = null;
  send() {
    this.sent++;
  }
  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

const settleWithin = <T>(ps: Promise<T>[], ms = 200) =>
  Promise.race([Promise.allSettled(ps), new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);

describe('transport cancellation (F11)', () => {
  const stalled = () => {
    const sync = new StalledChannel();
    const bulk = new StalledChannel();
    return { sync, bulk, t: new DataChannelTransport(sync, bulk, 'a', 'b') };
  };

  it('settles the draining send and every queued send when the channel closes above the high-water mark', async () => {
    const { sync, t } = stalled();
    const sends = [t.send('sync', new Uint8Array(10)), t.send('sync', new Uint8Array(FRAGMENT_SIZE * 2)), t.send('sync', new Uint8Array(3))];
    await new Promise((r) => setTimeout(r, 5));
    sync.close();
    const res = await settleWithin(sends);
    expect(res).not.toBe('hung');
    expect((res as PromiseSettledResult<void>[]).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(sync.sent).toBe(0);
  });

  it('rejects pending and later sends on a channel error and on local close', async () => {
    const a = stalled();
    const pendingA = a.t.send('sync', new Uint8Array(10));
    await new Promise((r) => setTimeout(r, 5));
    a.sync.onerror?.();
    expect(await settleWithin([pendingA])).not.toBe('hung');
    await expect(a.t.send('sync', new Uint8Array(1))).rejects.toThrow();

    const b = stalled();
    const pendingB = [b.t.send('bulk', new Uint8Array(10)), b.t.send('bulk', new Uint8Array(10))];
    await new Promise((r) => setTimeout(r, 5));
    b.t.close();
    const res = await settleWithin(pendingB);
    expect(res).not.toBe('hung');
    expect((res as PromiseSettledResult<void>[]).every((r) => r.status === 'rejected')).toBe(true);
  });

  it('does not hang a send when the owner aborts the channel', async () => {
    const dc = new StalledChannel();
    const ch = new FragmentedChannel(dc, () => {});
    const p = ch.send(new Uint8Array(5));
    const q = ch.send(new Uint8Array(5));
    await new Promise((r) => setTimeout(r, 5));
    ch.abort(new Error('aborted'));
    const res = await settleWithin([p, q]);
    expect(res).not.toBe('hung');
    expect((res as PromiseSettledResult<void>[]).every((r) => r.status === 'rejected')).toBe(true);
  });
});

const frame = (kind: number, n: number) => {
  const f = new Uint8Array(n + 1);
  f[0] = kind;
  return f;
};

describe('bounded fragment assembly (F12)', () => {
  const rx = (opts: ConstructorParameters<typeof FragmentedChannel>[2] = {}) => {
    const dc = new StalledChannel();
    const out: number[] = [];
    const violations: string[] = [];
    const ch = new FragmentedChannel(dc, (d) => out.push(d.length), { ...opts, onViolation: (r) => violations.push(r) });
    const feed = (f: Uint8Array) => dc.onmessage?.({ data: f });
    return { ch, feed, out, violations };
  };

  it('delivers well-formed single and fragmented messages', () => {
    const { feed, out, violations } = rx();
    feed(frame(0, 5));
    feed(frame(1, 10));
    feed(frame(2, 10));
    feed(frame(3, 4));
    expect(out).toEqual([5, 24]);
    expect(violations).toEqual([]);
  });

  it('rejects a raw frame above the fragment size', () => {
    const { feed, out, violations } = rx();
    feed(frame(0, FRAGMENT_SIZE + 1));
    expect(out).toEqual([]);
    expect(violations).toHaveLength(1);
  });

  it('rejects invalid fragment sequences and unknown kinds', () => {
    for (const seq of [[2], [3], [9], [1, 1], [1, 0], []]) {
      const { feed, violations } = rx();
      for (const k of seq) feed(frame(k, 4));
      if (seq.length === 0) {
        feed(new Uint8Array(0));
      }
      expect(violations, JSON.stringify(seq)).toHaveLength(1);
    }
  });

  it('terminates a stream that exceeds the assembled-byte budget and releases what it held', () => {
    const { ch, feed, out, violations } = rx({ maxMessageBytes: 100 });
    feed(frame(1, 60));
    expect(ch.assembledBytes).toBe(60);
    feed(frame(2, 60));
    expect(violations).toHaveLength(1);
    expect(ch.assembledBytes).toBe(0);
    feed(frame(3, 1));
    expect(out).toEqual([]);
  });

  it('terminates an incomplete stream after the assembly timeout', async () => {
    const { ch, feed, violations } = rx({ assemblyTimeoutMs: 20 });
    feed(frame(1, 10));
    expect(ch.assembledBytes).toBe(10);
    await new Promise((r) => setTimeout(r, 60));
    expect(violations).toHaveLength(1);
    expect(ch.assembledBytes).toBe(0);
  });

  it('keeps a slow but progressing stream alive', async () => {
    const { feed, out, violations } = rx({ assemblyTimeoutMs: 40 });
    feed(frame(1, 10));
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 20));
      feed(frame(2, 10));
    }
    feed(frame(3, 1));
    expect(violations).toEqual([]);
    expect(out).toEqual([51]);
  });

  it('bounds the outbound queue and accounts bytes back after delivery', async () => {
    const dc = new StalledChannel();
    const ch = new FragmentedChannel(dc, () => {}, { maxQueuedBytes: 100 });
    const first = ch.send(new Uint8Array(60));
    const second = ch.send(new Uint8Array(60));
    await expect(second).rejects.toThrow(/queue/);
    expect(ch.queuedBytes).toBe(60);
    dc.bufferedAmount = 0;
    dc.onbufferedamountlow?.();
    await first;
    expect(ch.queuedBytes).toBe(0);
    await ch.send(new Uint8Array(60));
  });

  it('releases queue accounting and partial assembly when the channel is aborted', async () => {
    const dc = new StalledChannel();
    const ch = new FragmentedChannel(dc, () => {}, { maxQueuedBytes: 100 });
    const p = ch.send(new Uint8Array(60)).catch(() => {});
    dc.onmessage?.({ data: frame(1, 10) });
    ch.abort();
    await p;
    expect(ch.queuedBytes).toBe(0);
    expect(ch.assembledBytes).toBe(0);
  });

  it('closes only the offending peer: other peers keep exchanging edits', async () => {
    const net = await Net.create();
    const [a, b, c] = [await net.add('alice', 'editor'), await net.add('bob', 'editor'), await net.add('carol', 'editor')];
    await net.link(a, b);
    const [s1, s2] = fakeChannelPair();
    const [b1, b2] = fakeChannelPair();
    const [pa] = await Promise.all([
      a.mesh.addTransport(new DataChannelTransport(s1, b1, 'fpA', 'fpC')),
      c.mesh.addTransport(new DataChannelTransport(s2, b2, 'fpC', 'fpA')),
    ]);
    expect(a.mesh.peers).toHaveLength(2);
    // Carol's side now misbehaves at the channel level: a continuation fragment with no start.
    s2.send(frame(3, 8));
    await waitFor(() => pa.conn.closed);
    await waitFor(() => a.mesh.peers.length === 1);
    const id = await a.model.createTextNow('main.tex', 'still syncing');
    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await b.model.openText(id)).toString() === 'still syncing');
    net.destroy();
  });
});
