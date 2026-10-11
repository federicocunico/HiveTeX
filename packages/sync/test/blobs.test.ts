import { BLOB_CHUNK_SIZE, MsgType } from '@hivetex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { jsonBytes, utf8 } from '../src/frames.js';
import type { PeerInfo } from '../src/mesh.js';
import { sha256Hex } from '../src/model.js';
import { waitFor } from './helpers.js';
import { Net } from './net.js';

let net: Net;
afterEach(() => net?.destroy());

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const filled = (n: number, v = 7) => new Uint8Array(n).fill(v);
function noise(n: number) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
}

function chunkFrame(hash: string, index: number, total: number, bytes: Uint8Array): Uint8Array {
  const h = utf8(hash);
  const out = new Uint8Array(1 + h.length + 8 + bytes.length);
  out[0] = h.length;
  out.set(h, 1);
  const dv = new DataView(out.buffer);
  dv.setUint32(1 + h.length, index);
  dv.setUint32(1 + h.length + 4, total);
  out.set(bytes, 1 + h.length + 8);
  return out;
}

interface PendingView {
  chunks: Map<number, Uint8Array>;
  bad: Set<string>;
  total: number;
}
interface Internals {
  pending: Map<string, PendingView>;
  peerHas: Map<string, Set<string>>;
  onChunk(from: PeerInfo, p: Uint8Array): void;
  maxBlobBytes: number;
}

describe('blob chunk validation (F12)', () => {
  const setup = async (maxBlobBytes?: number) => {
    net = await Net.create();
    const me = await net.add('me', 'editor');
    const bm = new BlobManager(me.mesh, me.store);
    const x = bm as unknown as Internals;
    if (maxBlobBytes !== undefined) x.maxBlobBytes = maxBlobBytes;
    const hash = 'h'.repeat(64);
    x.pending.set(hash, { hash, total: 0, chunks: new Map(), from: new Map(), waiters: [], bad: new Set(), retained: 0, totalFrom: null, claimants: new Set(), conflict: false, only: null } as never);
    x.peerHas.set('src', new Set([hash]));
    const src = { deviceId: 'src' } as PeerInfo;
    return { x, hash, src, w: x.pending.get(hash) as PendingView };
  };

  it('rejects a chunk above the chunk size before retaining it', async () => {
    const { x, hash, src, w } = await setup();
    x.onChunk(src, chunkFrame(hash, 0, 4, filled(BLOB_CHUNK_SIZE + 1)));
    expect(w.chunks.size).toBe(0);
    expect(w.bad.has('src')).toBe(true);
  });

  it('rejects a short chunk that is not the last, and an index outside the total', async () => {
    const { x, hash, src, w } = await setup();
    x.onChunk(src, chunkFrame(hash, 0, 4, filled(10)));
    expect(w.chunks.size).toBe(0);
    expect(w.bad.has('src')).toBe(true);
    const b = await setup();
    b.x.onChunk(b.src, chunkFrame(b.hash, 4, 4, filled(10)));
    expect(b.w.chunks.size).toBe(0);
    expect(b.w.bad.has('src')).toBe(true);
  });

  it('accepts a full middle chunk and a short last chunk', async () => {
    const { x, hash, src, w } = await setup();
    x.onChunk(src, chunkFrame(hash, 0, 2, filled(BLOB_CHUNK_SIZE)));
    x.onChunk(src, chunkFrame(hash, 1, 2, filled(10)));
    expect(w.chunks.size).toBe(2);
    expect(w.bad.size).toBe(0);
  });

  it('enforces the aggregate size budget before retaining the chunk that crosses it', async () => {
    const { x, hash, src, w } = await setup(BLOB_CHUNK_SIZE * 2 + 100);
    for (let i = 0; i < 3; i++) x.onChunk(src, chunkFrame(hash, i, 3, filled(BLOB_CHUNK_SIZE)));
    expect(w.chunks.size).toBe(2);
    expect([...w.chunks.values()].reduce((n, c) => n + c.length, 0)).toBeLessThanOrEqual(BLOB_CHUNK_SIZE * 2 + 100);
    expect(w.bad.has('src')).toBe(true);
  });

  it('ignores chunks from a peer that never announced the blob, and malformed payloads', async () => {
    const { x, hash, w } = await setup();
    x.onChunk({ deviceId: 'stranger' } as PeerInfo, chunkFrame(hash, 0, 2, filled(BLOB_CHUNK_SIZE)));
    expect(w.chunks.size).toBe(0);
    expect(() => x.onChunk({ deviceId: 'src' } as PeerInfo, new Uint8Array([200, 1, 2]))).not.toThrow();
    expect(() => x.onChunk({ deviceId: 'src' } as PeerInfo, new Uint8Array(0))).not.toThrow();
    expect(w.chunks.size).toBe(0);
  });
});

describe('blob sources (F12)', () => {
  async function trio() {
    net = await Net.create();
    const [evil, honest, me] = [await net.add('evil', 'editor'), await net.add('hon', 'editor'), await net.add('me', 'editor')];
    await net.fullMesh();
    const [bh, bm] = [honest, me].map((n) => new BlobManager(n.mesh, n.store)) as [BlobManager, BlobManager];
    return { evil, honest, me, bh, bm };
  }

  it('rejects an oversized chunk with a plausible count, then fetches from an honest source', async () => {
    const { evil, me, bh, bm } = await trio();
    const data = noise(100 * 1024);
    const hash = await sha256Hex(data);
    const total = Math.ceil(data.length / BLOB_CHUNK_SIZE);
    let served = 0;
    evil.mesh.onRaw(MsgType.BLOB_WANT, (from) => {
      served++;
      void evil.mesh.sendTo(from.deviceId, MsgType.BLOB_CHUNK, chunkFrame(hash, 0, total, filled(BLOB_CHUNK_SIZE + 1)), true);
    });
    const got = bm.fetch(hash, 20_000);
    await evil.mesh.sendTo(me.dev, MsgType.BLOB_HAVE, jsonBytes({ hashes: [hash] }), true);
    await waitFor(() => served > 0);
    const w = (bm as unknown as Internals).pending.get(hash);
    await waitFor(() => (w?.bad.size ?? 0) > 0);
    expect(w?.chunks.size).toBe(0);
    await bh.add(data);
    expect(same(await got, data)).toBe(true);
  }, 30_000);

  it('recovers when a source advertises a total that disagrees with an honest peer', async () => {
    const { evil, me, bh, bm } = await trio();
    const data = noise(200 * 1024);
    const hash = await sha256Hex(data);
    // The liar claims 2 chunks of the right size, so every individual chunk looks plausible.
    evil.mesh.onRaw(MsgType.BLOB_WANT, (from, p) => {
      const { from: a, to: b } = JSON.parse(new TextDecoder().decode(p)) as { from: number; to: number };
      for (let i = a; i < Math.min(b, 2); i++) void evil.mesh.sendTo(from.deviceId, MsgType.BLOB_CHUNK, chunkFrame(hash, i, 2, noise(BLOB_CHUNK_SIZE)), true);
    });
    await evil.mesh.sendTo(me.dev, MsgType.BLOB_HAVE, jsonBytes({ hashes: [hash] }), true);
    await waitFor(() => (bm as unknown as Internals).peerHas.size === 1);
    await bh.add(data);
    await waitFor(() => (bm as unknown as Internals).peerHas.size === 2);
    const t0 = Date.now();
    expect(same(await bm.fetch(hash, 20_000), data)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);
});

describe('blob request ranges (F12)', () => {
  it('serves only finite, non-negative integer ranges, clamped to the blob', async () => {
    net = await Net.create();
    const [holder, asker] = [await net.add('holder', 'editor'), await net.add('asker', 'editor')];
    await net.fullMesh();
    const bh = new BlobManager(holder.mesh, holder.store);
    const data = noise(BLOB_CHUNK_SIZE * 2 + 50);
    const hash = await bh.add(data);
    const indices: number[] = [];
    asker.mesh.onRaw(MsgType.BLOB_CHUNK, (_f, p) => {
      const hl = p[0] as number;
      indices.push(new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(1 + hl));
    });
    const want = async (req: unknown) => {
      indices.length = 0;
      await asker.mesh.sendTo(holder.dev, MsgType.BLOB_WANT, jsonBytes(req), true);
      await new Promise((r) => setTimeout(r, 60));
      return [...indices];
    };
    for (const bad of [
      { hash, from: -1, to: 2 },
      { hash, from: 0.5, to: 2 },
      { hash, from: '0', to: 1 },
      { hash, from: 0, to: null },
      { hash, from: 2, to: 1 },
      { hash, from: 1e12, to: 2e12 },
      { hash: 5, from: 0, to: 1 },
      {},
    ]) {
      expect(await want(bad), JSON.stringify(bad)).toEqual([]);
    }
    expect(await want({ hash, from: 1, to: 1e9 })).toEqual([1, 2]);
    expect(await want({ hash, from: 0, to: 1 })).toEqual([0]);
    expect(holder.mesh.peers).toHaveLength(1);
  });
});

describe('reconnect with a binary transfer in flight (9.2)', () => {
  it('a link dropped mid-transfer neither corrupts nor leaks: after reconnecting the exact bytes arrive and the fetch settles', async () => {
    net = await Net.create();
    const [holder, me] = [await net.add('hold', 'editor'), await net.add('me', 'editor')];
    await net.link(holder, me, { latencyMs: 4 });
    const [bh, bm] = [holder, me].map((n) => new BlobManager(n.mesh, n.store)) as [BlobManager, BlobManager];
    const data = noise(BLOB_CHUNK_SIZE * 60);
    const hash = await bh.add(data);
    await waitFor(() => (bm as unknown as Internals).peerHas.size === 1);
    const got = bm.fetch(hash, 30_000);
    // wait until some, but not all, chunks arrived, then cut the link
    const w = (bm as unknown as Internals).pending;
    await waitFor(() => (w.get(hash)?.chunks.size ?? 0) > 0);
    expect(w.get(hash)?.chunks.size).toBeLessThan(60);
    net.isolate(me);
    await waitFor(() => me.mesh.peers.length === 0);
    await net.link(holder, me, { latencyMs: 4 });
    expect(same(await got, data)).toBe(true);
    expect(await sha256Hex(await bm.get(hash) as Uint8Array)).toBe(hash);
    // settled: nothing left pending for the finished fetch
    expect(w.has(hash)).toBe(false);
  }, 40_000);
});
