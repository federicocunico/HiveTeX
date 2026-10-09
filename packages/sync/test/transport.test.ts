import { BUFFER_HIGH_WATER, FRAGMENT_SIZE } from '@p2platex/protocol';
import { describe, expect, it } from 'vitest';
import { DataChannelTransport, fakeChannelPair } from '../src/transport.js';

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
