import { BLOB_CHUNK_SIZE, MAX_BLOB_BYTES, MsgType } from '@hivetex/protocol';
import { jsonBytes, parseJson, utf8 } from './frames.js';
import type { Mesh, PeerInfo } from './mesh.js';
import * as Y from 'yjs';
import { type ProjectModel, sha256Hex } from './model.js';
import type { Persistence } from './persistence.js';

const BLOB_HASH = /^[0-9a-f]{64}$/;

/**
 * Blobs the project refers to: live files and the earlier versions, deletions and resolutions the file table keeps, plus
 * History snapshots. Anything else in the store (PDF, log and SyncTeX files a 0.8.0 build leader stored as shared assets)
 * is never offered to peers.
 */
export async function referencedBlobs(model: ProjectModel, store: Persistence): Promise<Set<string>> {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') { if (BLOB_HASH.test(v)) out.add(v); }
    else if (Array.isArray(v)) for (const x of v) visit(x);
    else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) visit(x);
  };
  // Every shared root structure, so a file table kept in another map (deleted entries) still counts.
  for (const type of model.root.share.values()) if (type instanceof Y.Map || type instanceof Y.Array) visit(type.toJSON());
  for (const s of await store.listSnapshots()) for (const f of s.files) if (f.hash) out.add(f.hash);
  return out;
}

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
  /** Bytes currently held in `chunks`. */
  retained: number;
  /** The peer whose chunk fixed `total`; its claim is dropped if that peer turns out to be bad. */
  totalFrom: string | null;
  /** Every peer that claimed a total for this fetch (suspects when two claims disagree). */
  claimants: Set<string>;
  /** Two peers disagreed about the chunk count; the fetch loop isolates them one at a time. */
  conflict: boolean;
  /** When set, chunks are accepted from this peer only (isolating a suspect). */
  only: string | null;
}

/** Hash announcements accepted per message and remembered per peer. */
const MAX_HASHES = 100_000;
const MAX_HASH_LENGTH = 128;

const safeJson = (b: Uint8Array): unknown => {
  try {
    return parseJson<unknown>(b);
  } catch {
    return null;
  }
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHash = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_HASH_LENGTH;

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
  if (p.length < 1) return null;
  const hl = p[0] as number;
  if (hl === 0 || p.length < 1 + hl + 8) return null;
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
  /** When a chunk of each blob being fetched last arrived (a transfer's own progress clock). */
  private chunkAt = new Map<string, number>();
  private announceCbs = new Set<(deviceId: string, hashes: string[]) => void>();
  /** Largest blob accepted from peers (injectable so tests can use small budgets). */
  maxBlobBytes = MAX_BLOB_BYTES;

  /** Hashes this device announced: peers ask only for those, so serving them needs no reference check. */
  private announced = new Set<string>();

  /** `referenced` (see referencedBlobs) limits what is announced and served; without it every stored blob is offered. */
  constructor(
    private mesh: Mesh,
    private store: Persistence,
    private o: { referenced?: () => Promise<Set<string>> } = {},
  ) {
    mesh.onRaw(MsgType.BLOB_HAVE, (from, p) => {
      const msg = safeJson(p);
      if (!isObject(msg) || !Array.isArray(msg.hashes)) return;
      const set = this.peerHas.get(from.deviceId) ?? new Set();
      const fresh: string[] = [];
      for (const h of msg.hashes.slice(0, MAX_HASHES)) {
        if (!isHash(h) || set.size >= MAX_HASHES) continue;
        if (!set.has(h)) fresh.push(h);
        set.add(h);
      }
      this.peerHas.set(from.deviceId, set);
      if (fresh.length) for (const cb of this.announceCbs) cb(from.deviceId, fresh);
      for (const w of this.pending.values()) for (const f of w.waiters.splice(0)) f();
    });
    mesh.onRaw(MsgType.BLOB_WANT, (from, p) => {
      const req = safeJson(p);
      if (!isObject(req) || !isHash(req.hash)) return;
      const { from: first, to: end } = req;
      // Finite, non-negative integers only: anything else would index outside the blob or loop on garbage.
      if (typeof first !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(first) || !Number.isSafeInteger(end) || first < 0) return;
      void this.serve(from, { hash: req.hash, from: first, to: end }).catch(() => {});
    });
    mesh.onRaw(MsgType.BLOB_NONE, (from, p) => {
      const msg = safeJson(p);
      if (!isObject(msg) || !isHash(msg.hash)) return;
      const hash = msg.hash;
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

  private storedCbs = new Set<() => void>();
  /** Fires when a connected peer announces blobs it did not announce before (a fetch that failed may now succeed). */
  onAnnounced(cb: (deviceId: string, hashes: string[]) => void) {
    this.announceCbs.add(cb);
    return () => this.announceCbs.delete(cb);
  }
  /** Connected peers that announced the blob (and did not say they lack it). */
  sourcesOf(hash: string): string[] {
    return this.candidates(hash, new Set());
  }
  /** When a chunk of the blob last arrived, or 0. */
  chunkProgress(hash: string): number {
    return this.chunkAt.get(hash) ?? 0;
  }
  /** Fires when a blob has been fetched and stored. */
  onStored(cb: () => void) {
    this.storedCbs.add(cb);
    return () => this.storedCbs.delete(cb);
  }

  /** Hashes held on this device. */
  async held(): Promise<Set<string>> {
    return new Set(await this.store.listBlobs());
  }

  /**
   * Fetches the given blobs from peers with bounded concurrency; a blob nobody has right now is skipped (counted as
   * failed) so one missing file does not hold up the rest.
   */
  async fetchMissing(hashes: string[], concurrency = 2, timeoutMs = 20_000): Promise<{ fetched: number; failed: number; failedHashes: string[] }> {
    const queue = [...new Set(hashes)];
    let fetched = 0;
    const failedHashes: string[] = [];
    const worker = async () => {
      for (let h = queue.shift(); h; h = queue.shift()) {
        try {
          await this.fetch(h, timeoutMs);
          fetched++;
        } catch {
          failedHashes.push(h);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return { fetched, failed: failedHashes.length, failedHashes };
  }

  private async announceTo(peer: PeerInfo) {
    let hashes = await this.store.listBlobs();
    if (this.o.referenced && hashes.length) {
      const referenced = await this.o.referenced();
      hashes = hashes.filter((h) => referenced.has(h));
    }
    for (const h of hashes) this.announced.add(h);
    if (hashes.length) await this.mesh.sendTo(peer.deviceId, MsgType.BLOB_HAVE, jsonBytes({ hashes }), true);
  }

  /** Whether a stored blob may go to peers: one this device announced, or one the project refers to. */
  private async offered(hash: string): Promise<boolean> {
    if (!this.o.referenced || this.announced.has(hash)) return true;
    return (await this.o.referenced()).has(hash);
  }

  async has(hash: string) {
    return (await this.store.getBlob(hash)) !== undefined;
  }

  async get(hash: string) {
    return this.store.getBlob(hash);
  }

  /** Stores bytes locally, announces them, returns the content hash. */
  async add(bytes: Uint8Array, canPublish: () => boolean = () => true): Promise<string> {
    if (!canPublish()) throw new BlobError('denied');
    const hash = await sha256Hex(bytes);
    if (!(await this.has(hash))) await this.store.putBlob(hash, bytes);
    await this.announceStored(hash, canPublish);
    return hash;
  }

  /** Announce a hash only after the authoritative store has verified and committed its bytes. */
  async announceStored(hash: string, canPublish: () => boolean = () => true) {
    if (!canPublish() || !(await this.store.listBlobs()).includes(hash) || !canPublish()) throw new BlobError('denied');
    this.announced.add(hash);
    this.mesh.broadcast(MsgType.BLOB_HAVE, jsonBytes({ hashes: [hash] }), true);
  }

  private async serve(from: PeerInfo, req: { hash: string; from: number; to: number }) {
    const held = await this.store.getBlob(req.hash);
    const data = held && (await this.offered(req.hash)) ? held : undefined;
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

  /** A chunk is only taken from a peer that announced the blob, is not known bad, and is the isolated suspect if one is set. */
  private eligible(dev: string, w: Pending): boolean {
    if (w.bad.has(dev) || (w.only !== null && w.only !== dev)) return false;
    return this.peerHas.get(dev)?.has(w.hash) === true && !this.none.get(w.hash)?.has(dev);
  }

  private onChunk(from: PeerInfo, payload: Uint8Array) {
    const c = decodeChunk(payload);
    if (!c) return;
    const w = this.pending.get(c.hash);
    if (!w || !this.eligible(from.deviceId, w)) return;
    const wake = () => {
      for (const f of w.waiters.splice(0)) f();
    };
    const reject = () => {
      w.bad.add(from.deviceId);
      wake();
    };
    const maxChunks = Math.ceil(this.maxBlobBytes / BLOB_CHUNK_SIZE);
    const last = c.index === c.total - 1;
    // Every check below runs before the bytes are copied.
    if (c.total === 0 || c.total > maxChunks || c.index >= c.total) return reject();
    if (c.bytes.length > BLOB_CHUNK_SIZE || (!last && c.bytes.length !== BLOB_CHUNK_SIZE)) return reject();
    if (last && c.total > 1 && c.bytes.length === 0) return reject();
    w.claimants.add(from.deviceId);
    if (w.total !== 0 && c.total !== w.total) {
      w.conflict = true;
      return wake();
    }
    if (w.chunks.has(c.index)) return;
    if (w.retained + c.bytes.length > this.maxBlobBytes) return reject();
    if (w.total === 0) {
      w.total = c.total;
      w.totalFrom = from.deviceId;
    }
    this.chunkAt.set(c.hash, Date.now());
    w.chunks.set(c.index, c.bytes.slice());
    w.from.set(c.index, from.deviceId);
    w.retained += c.bytes.length;
    wake();
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
      this.chunkAt.delete(hash);
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
    const w: Pending = {
      hash,
      total: 0,
      chunks: new Map(),
      from: new Map(),
      waiters: [],
      bad: new Set(),
      retained: 0,
      totalFrom: null,
      claimants: new Set(),
      conflict: false,
      only: null,
    };
    const resetTransfer = () => {
      w.chunks.clear();
      w.from.clear();
      w.retained = 0;
      w.total = 0;
      w.totalFrom = null;
    };
    /** Forgets what a now-banned peer contributed, including the chunk count it fixed. */
    const dropFrom = (dev: string) => {
      for (const [i, d] of [...w.from]) {
        if (d !== dev) continue;
        w.retained -= w.chunks.get(i)?.length ?? 0;
        w.chunks.delete(i);
        w.from.delete(i);
      }
      if (w.totalFrom === dev) w.total = 0;
    };
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
      for (const d of w.bad) {
        if (!banned.has(d)) dropFrom(d);
        banned.add(d);
      }
      if (singleSource && banned.has(singleSource)) singleSource = null;
      if (w.conflict) {
        // Two peers disagree about the chunk count and we cannot tell who is right: retry each suspect alone.
        w.conflict = false;
        const suspects = [...w.claimants].filter((d) => !banned.has(d));
        resetTransfer();
        requestedAt.clear();
        if (singleSource) banned.add(singleSource);
        singleSource = singleSource ? null : (suspects[0] ?? null);
        w.claimants.clear();
      }
      w.only = singleSource;
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
          this.announced.add(hash);
          this.mesh.broadcast(MsgType.BLOB_HAVE, jsonBytes({ hashes: [hash] }), true);
          for (const cb of this.storedCbs) cb();
          return data;
        }
        // Corrupt: isolate the culprit by retrying each contributor alone, banning those that fail alone.
        const contributors = [...new Set(w.from.values())];
        resetTransfer();
        w.claimants.clear();
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
