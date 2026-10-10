import { BLOB_CHUNK_SIZE, MAX_BLOB_BYTES, MsgType } from '@hivetex/protocol';
import { jsonBytes, parseJson, utf8 } from './frames.js';
import type { Mesh, PeerInfo } from './mesh.js';
import { sha256Hex } from './model.js';
import type { Persistence } from './persistence.js';

export class BlobError extends Error {}

interface Pending {
  hash: string;
  total: number;
  chunks: Map<number, Uint8Array>;
  /** Which device supplied each chunk (for attribution when the final hash does not match). */
  from: Map<number, string>;
  waiters: Array<() => void>;
  /** Peers that announced an impossible transfer for this blob (ignored for the rest of this fetch). */
  bad: Set<string>;
}

/** Most chunks a legitimate blob can have; larger announced totals are refused before allocating anything. */
const MAX_CHUNKS = Math.ceil(MAX_BLOB_BYTES / BLOB_CHUNK_SIZE);

function encodeChunk(hash: string, index: number, total: number, bytes: Uint8Array): Uint8Array {
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

function decodeChunk(p: Uint8Array) {
  const hl = p[0] as number;
  const hash = new TextDecoder().decode(p.subarray(1, 1 + hl));
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return {
    hash,
    index: dv.getUint32(1 + hl),
    total: dv.getUint32(1 + hl + 4),
    bytes: p.subarray(1 + hl + 8),
  };
}

/**
 * Content-addressed binary transfer: announce what we hold, fetch missing blobs in chunks from any
 * peers that hold them (in parallel), verify the SHA-256 before committing.
 */
export class BlobManager {
  private peerHas = new Map<string, Set<string>>();
  private pending = new Map<string, Pending>();
  private none = new Map<string, Set<string>>();
  private inflight = new Map<string, Promise<Uint8Array>>();
  /** Test hook: corrupt outgoing chunks from this node. */
  corruptOutgoing = false;
  /** Test hook: announce this chunk count instead of the real one (a lying peer). */
  lieAboutTotal: number | null = null;
  requestTimeoutMs = 4000;

  constructor(
    private mesh: Mesh,
    private store: Persistence,
  ) {
    mesh.onRaw(MsgType.BLOB_HAVE, (from, p) => {
      const { hashes } = parseJson<{ hashes: string[] }>(p);
      const set = this.peerHas.get(from.deviceId) ?? new Set();
      for (const h of hashes) set.add(h);
      this.peerHas.set(from.deviceId, set);
      for (const w of this.pending.values()) for (const f of w.waiters.splice(0)) f();
    });
    mesh.onRaw(MsgType.BLOB_WANT, (from, p) => void this.serve(from, parseJson(p)));
    mesh.onRaw(MsgType.BLOB_NONE, (from, p) => {
      const { hash } = parseJson<{ hash: string }>(p);
      const s = this.none.get(hash) ?? new Set();
      s.add(from.deviceId);
      this.none.set(hash, s);
      this.peerHas.get(from.deviceId)?.delete(hash);
      for (const f of this.pending.get(hash)?.waiters.splice(0) ?? []) f();
    });
    mesh.onRaw(MsgType.BLOB_CHUNK, (from, p) => this.onChunk(from, p));
    mesh.onPeerJoin((peer) => void this.announceTo(peer));
    mesh.onPeerLeave((peer) => this.peerHas.delete(peer.deviceId));
  }

  private async announceTo(peer: PeerInfo) {
    const hashes = await this.store.listBlobs();
    if (hashes.length) await this.mesh.sendTo(peer.deviceId, MsgType.BLOB_HAVE, jsonBytes({ hashes }), true);
  }

  async has(hash: string) {
    return (await this.store.getBlob(hash)) !== undefined;
  }

  async get(hash: string) {
    return this.store.getBlob(hash);
  }

  /** Stores bytes locally, announces them, returns the content hash. */
  async add(bytes: Uint8Array): Promise<string> {
    const hash = await sha256Hex(bytes);
    if (!(await this.has(hash))) await this.store.putBlob(hash, bytes);
    this.mesh.broadcast(MsgType.BLOB_HAVE, jsonBytes({ hashes: [hash] }), true);
    return hash;
  }

  private async serve(from: PeerInfo, req: { hash: string; from: number; to: number }) {
    const data = await this.store.getBlob(req.hash);
    if (!data) return void this.mesh.sendTo(from.deviceId, MsgType.BLOB_NONE, jsonBytes({ hash: req.hash }), true);
    const total = Math.max(1, Math.ceil(data.length / BLOB_CHUNK_SIZE));
    for (let i = req.from; i < Math.min(req.to, total); i++) {
      let chunk = data.subarray(i * BLOB_CHUNK_SIZE, (i + 1) * BLOB_CHUNK_SIZE);
      if (this.corruptOutgoing) {
        chunk = chunk.slice();
        chunk[0] = (chunk[0] as number) ^ 0xff;
      }
      await this.mesh.sendTo(from.deviceId, MsgType.BLOB_CHUNK, encodeChunk(req.hash, i, this.lieAboutTotal ?? total, chunk), true);
    }
  }

  private onChunk(from: PeerInfo, payload: Uint8Array) {
    const c = decodeChunk(payload);
    const w = this.pending.get(c.hash);
    if (!w) return;
    if (c.total === 0 || c.total > MAX_CHUNKS) {
      w.bad.add(from.deviceId);
      for (const f of w.waiters.splice(0)) f();
      return;
    }
    if (w.total === 0) w.total = c.total;
    if (c.total !== w.total || c.index >= w.total) return;
    if (!w.chunks.has(c.index)) {
      w.chunks.set(c.index, c.bytes.slice());
      w.from.set(c.index, from.deviceId);
    }
    for (const f of w.waiters.splice(0)) f();
  }

  private candidates(hash: string, exclude: Set<string>): string[] {
    const online = new Set(this.mesh.peers.map((p) => p.deviceId));
    return [...this.peerHas]
      .filter(([dev, set]) => online.has(dev) && set.has(hash) && !exclude.has(dev) && !this.none.get(hash)?.has(dev))
      .map(([dev]) => dev);
  }

  /** Returns the blob, from local storage or fetched from peers. Rejects if unavailable/corrupt everywhere. */
  fetch(hash: string, timeoutMs = 15_000): Promise<Uint8Array> {
    const existing = this.inflight.get(hash);
    if (existing) return existing;
    const p = this.doFetch(hash, timeoutMs).finally(() => {
      this.inflight.delete(hash);
      this.pending.delete(hash);
      this.none.delete(hash);
    });
    this.inflight.set(hash, p);
    return p;
  }

  private async doFetch(hash: string, timeoutMs: number): Promise<Uint8Array> {
    const local = await this.store.getBlob(hash);
    if (local) return local;
    const deadline = Date.now() + timeoutMs;
    const banned = new Set<string>();
    const w: Pending = { hash, total: 0, chunks: new Map(), from: new Map(), waiters: [], bad: new Set() };
    this.pending.set(hash, w);
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        w.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });

    let singleSource: string | null = null; // used after a hash mismatch to isolate a bad peer
    const requestedAt = new Map<number, number>();
    let lastProbe = 0;

    while (Date.now() < deadline) {
      for (const d of w.bad) banned.add(d);
      if (singleSource && banned.has(singleSource)) singleSource = null;
      const peers = singleSource ? [singleSource] : this.candidates(hash, banned);
      if (peers.length === 0) {
        await wait(100);
        continue;
      }
      // Learn the chunk count from the first peer.
      if (w.total === 0) {
        if (Date.now() - lastProbe > 500) {
          lastProbe = Date.now();
          await this.mesh.sendTo(peers[0] as string, MsgType.BLOB_WANT, jsonBytes({ hash, from: 0, to: 1 }), true);
        }
        await wait(200);
        continue;
      }
      const missing: number[] = [];
      for (let i = 0; i < w.total; i++) if (!w.chunks.has(i)) missing.push(i);
      if (missing.length === 0) {
        const data = new Uint8Array(Array.from(w.chunks.values()).reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (let i = 0; i < w.total; i++) {
          const c = w.chunks.get(i) as Uint8Array;
          data.set(c, o);
          o += c.length;
        }
        if ((await sha256Hex(data)) === hash) {
          await this.store.putBlob(hash, data);
          this.mesh.broadcast(MsgType.BLOB_HAVE, jsonBytes({ hashes: [hash] }), true);
          return data;
        }
        // Corrupt: isolate the culprit by retrying each contributor alone, banning those that fail alone.
        const contributors = [...new Set(w.from.values())];
        w.chunks.clear();
        w.from.clear();
        requestedAt.clear();
        if (singleSource) {
          banned.add(singleSource);
          singleSource = contributors.find((c) => !banned.has(c)) ?? null;
        } else if (contributors.length <= 1) {
          if (contributors[0]) banned.add(contributors[0]);
        } else {
          singleSource = contributors[0] ?? null;
        }
        continue;
      }
      // Request only chunks not requested recently, split into contiguous blocks over the peers.
      const now = Date.now();
      const stale = missing.filter((i) => (requestedAt.get(i) ?? 0) + this.requestTimeoutMs < now);
      if (stale.length) {
        const per = Math.ceil(stale.length / peers.length);
        for (let k = 0; k < peers.length; k++) {
          const slice = stale.slice(k * per, (k + 1) * per);
          if (slice.length === 0) continue;
          let start = slice[0] as number;
          let prev = start;
          for (let j = 1; j <= slice.length; j++) {
            const cur = slice[j];
            if (cur === prev + 1) {
              prev = cur;
              continue;
            }
            await this.mesh.sendTo(peers[k] as string, MsgType.BLOB_WANT, jsonBytes({ hash, from: start, to: prev + 1 }), true);
            start = cur as number;
            prev = start;
          }
          for (const i of slice) requestedAt.set(i, now);
        }
      }
      await wait(250);
    }
    throw new BlobError(`blob ${hash.slice(0, 8)} unavailable`);
  }
}
