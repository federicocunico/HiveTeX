import { type ChangeSet, type HistorySnapshot, type Persistence, type StoreOp } from './persistence.js';

/**
 * Persistence over the desktop's native SQLite store (apps/desktop/src-tauri/src/store.rs, D4). One store per scope
 * (server, account, project); the native side owns transactions, durability and blob hash verification. Binary values
 * cross the IPC boundary as base64, in calls bounded like the native side expects.
 */

export type StoreInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** Largest blob piece per call (the native store's MAX_CHUNK). */
export const NATIVE_CHUNK = 4 * 1024 * 1024;
/** Optional streaming store extension used by the desktop editor bridge; chunks never assemble in worker RAM. */
export interface StagedBlobStore {
  stageBlobChunk(upload: string, hash: string, size: number, part: number, bytes: Uint8Array): Promise<void>;
  commitBlobUpload(upload: string): Promise<void>;
  abortBlobUpload(upload: string): Promise<void>;
}

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * JSON with binary values preserved (IndexedDB stores structured clones; journals keep Yjs updates as Uint8Array):
 * `{ "$u8": "<base64>" }` stands for a Uint8Array.
 */
export function encodeValue(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { $u8: toB64(x) } : x));
}
export function decodeValue(s: string): unknown {
  return JSON.parse(s, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 1 && typeof (x as { $u8?: unknown }).$u8 === 'string' ? fromB64((x as { $u8: string }).$u8) : x));
}

/** The scope of a project's store: SHA-256 of (canonical server, account, project), or `local-<id>` for a local project. */
export async function storeScope(server: string, account: string, project: string): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([server.replace(/\/+$/, '').toLowerCase(), account, project]));
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

export class NativePersistence implements Persistence {
  private closed = false;
  private constructor(
    private invoke: StoreInvoke,
    private id: number,
  ) {}

  /** Opens the scope's store; the native side refuses a second open handle for the same scope (one writer). */
  static async open(invoke: StoreInvoke, scope: string): Promise<NativePersistence> {
    return new NativePersistence(invoke, await invoke<number>('store_open', { scope }));
  }

  private call<T>(cmd: string, args: Record<string, unknown> = {}) {
    if (this.closed) return Promise.reject(new Error('store closed'));
    return this.invoke<T>(cmd, { id: this.id, ...args });
  }

  async transact(ops: StoreOp[]) {
    await this.call('store_transact', {
      ops: ops.map((o) =>
        o.op === 'append'
          ? { op: 'append', doc: o.docId, updates: o.updates.map(toB64) }
          : o.op === 'compact'
            ? { op: 'compact', doc: o.docId, state: toB64(o.state) }
            : { op: 'meta', key: o.key, value: o.value === undefined ? null : encodeValue(o.value) },
      ),
    });
  }
  async load(docId: string) {
    return (await this.call<string[]>('store_load', { doc: docId })).map(fromB64);
  }
  append(docId: string, updates: Uint8Array[]) {
    return this.transact([{ op: 'append', docId, updates }]);
  }
  compact(docId: string, state: Uint8Array) {
    return this.transact([{ op: 'compact', docId, state }]);
  }
  listDocs() {
    return this.call<string[]>('store_list_docs');
  }

  /** Small blobs in one call; large ones staged in chunks and published by the native side after verifying the hash. */
  stageBlobChunk(upload: string, hash: string, size: number, part: number, bytes: Uint8Array) {
    return this.call<void>('store_stage_chunk', { upload, hash, size, part, b64: toB64(bytes) });
  }
  commitBlobUpload(upload: string) { return this.call<void>('store_stage_commit', { upload }); }
  abortBlobUpload(upload: string) { return this.call<void>('store_stage_abort', { upload }); }

  async putBlob(hash: string, bytes: Uint8Array) {
    if (bytes.length <= NATIVE_CHUNK) return this.call<void>('store_put_blob', { hash, b64: toB64(bytes) });
    const upload = `${hash.slice(0, 16)}-${Math.random().toString(36).slice(2, 12)}`;
    try {
      for (let off = 0, part = 0; off < bytes.length; off += NATIVE_CHUNK, part++) {
        await this.stageBlobChunk(upload, hash, bytes.length, part, bytes.subarray(off, off + NATIVE_CHUNK));
      }
      await this.commitBlobUpload(upload);
    } catch (e) {
      await this.abortBlobUpload(upload).catch(() => {});
      throw e;
    }
  }
  async getBlob(hash: string) {
    const size = await this.call<number | null>('store_blob_size', { hash });
    if (size === null || size === undefined) return undefined;
    const out = new Uint8Array(size);
    for (let off = 0; off < size; off += NATIVE_CHUNK) {
      const part = await this.call<string | null>('store_read_blob', { hash, offset: off, len: NATIVE_CHUNK });
      if (part === null) return undefined;
      out.set(fromB64(part), off);
    }
    return out;
  }
  /** A renderer reads only its requested range; do not load a 50 MiB asset again for every 1 MiB IPC reply. */
  async readBlobRange(hash: string, offset: number, len: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(len) || len < 0 || len > NATIVE_CHUNK) throw new Error('invalid blob range');
    const total = await this.call<number | null>('store_blob_size', { hash });
    if (total === null || total === undefined) return undefined;
    const part = await this.call<string | null>('store_read_blob', { hash, offset, len });
    if (part === null) throw new Error('blob unavailable');
    return { total, bytes: fromB64(part) };
  }
  listBlobs() {
    return this.call<string[]>('store_list_blobs');
  }
  async putSnapshot(s: HistorySnapshot) {
    await this.call('store_put_snapshot', { sid: s.id, at: s.at, value: encodeValue(s) });
  }
  async listSnapshots() {
    return (await this.call<string[]>('store_list_snapshots')).map((v) => decodeValue(v) as HistorySnapshot);
  }
  async getMeta(key: string) {
    const v = await this.call<string | null>('store_get_meta', { key });
    return v === null || v === undefined ? undefined : decodeValue(v);
  }
  setMeta(key: string, value: unknown) {
    return this.transact([{ op: 'meta', key, value }]);
  }
  listMetaKeys() {
    return this.call<string[]>('store_list_meta');
  }
  async putChangeSet(c: ChangeSet) {
    await this.call('store_put_change', { cid: c.id, endedAt: c.endedAt, value: encodeValue(c) });
  }
  async listChangeSets() {
    return (await this.call<string[]>('store_list_changes')).map((v) => decodeValue(v) as ChangeSet);
  }
  pruneChangeSets(now = Date.now()) {
    return this.call<number>('store_prune_changes', { now });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.invoke('store_close', { id: this.id });
  }
}

