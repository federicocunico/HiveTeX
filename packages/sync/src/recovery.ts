import { sha256Hex } from './model.js';
import type { Persistence } from './persistence.js';
import { isBytes } from './bytes.js';

/** Private recovery content is metadata, never an announced/suppliable project blob. */
export interface RecoveryRecord {
  v: 1;
  id: string;
  /** `removed`: an entry a peer deleted physically (no recoverable tombstone), retained before applying it. */
  kind: 'folder' | 'removed';
  fileId?: string;
  path: string;
  reason: string;
  hash: string;
  size: number;
  at: number;
  chunks: number;
}

const RECORD = 'recovery:record:';
const contentKey = (id: string, n: number) => `recovery:content:${id}:${n}`;
const CHUNK = 512 * 1024; // Bound every native metadata IPC call, including its base64 expansion.
const writes = new WeakMap<Persistence, Promise<unknown>>();
const watchers = new WeakMap<Persistence, Set<() => void>>();
/** `recovery:index:<sha256(path, reason)>:<content hash>` → record id: dedupe without listing records (D6). */
const indexKey = async (path: string, reason: string, hash: string) => `recovery:index:${(await sha256Hex(new TextEncoder().encode(JSON.stringify([path, reason])))).slice(0, 32)}:${hash}`;

/** Called after a recovery record of `store` was added (Recovery views refresh on this, not on every edit). */
export function onRecoveryChange(store: Persistence, cb: () => void): () => void {
  const set = watchers.get(store) ?? new Set();
  watchers.set(store, set); set.add(cb);
  return () => { set.delete(cb); };
}
export function notifyRecoveryChange(store: Persistence) {
  for (const cb of [...(watchers.get(store) ?? [])]) cb();
}

export async function listRecovery(store: Persistence): Promise<RecoveryRecord[]> {
  if (!store.listMetaKeys) throw new Error('Recovery listing is unavailable for this storage adapter.');
  const keys = (await store.listMetaKeys(RECORD)).filter((k) => k.startsWith(RECORD));
  const records = await Promise.all(keys.map((k) => store.getMeta(k)));
  return records.filter((r): r is RecoveryRecord => !!r && (r as RecoveryRecord).v === 1).sort((a, b) => b.at - a.at);
}

/** Commit the descriptor only after every private content chunk is durable. Failed captures never authorize deletion. */
export function preserveRecovery(store: Persistence, path: string, bytes: Uint8Array, reason: string, origin: { kind?: RecoveryRecord['kind']; fileId?: string } = {}): Promise<RecoveryRecord> {
  const captured = bytes.slice();
  const run = async () => {
    const hash = await sha256Hex(captured);
    const index = await indexKey(path, reason, hash);
    const knownId = await store.getMeta(index);
    const known = typeof knownId === 'string' ? await store.getMeta(RECORD + knownId) as RecoveryRecord | undefined : undefined;
    if (known?.v === 1 && known.path === path && known.hash === hash && known.reason === reason) return known;
    const id = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('');
    const chunks = Math.ceil(captured.length / CHUNK);
    for (let n = 0; n < chunks; n++) await store.setMeta(contentKey(id, n), captured.slice(n * CHUNK, (n + 1) * CHUNK));
    const record: RecoveryRecord = { v: 1, id, kind: origin.kind ?? 'folder', ...(origin.fileId ? { fileId: origin.fileId } : {}), path, reason, hash, size: captured.length, at: Date.now(), chunks };
    await store.setMeta(RECORD + id, record);
    await store.setMeta(index, id);
    notifyRecoveryChange(store);
    return record;
  };
  const next = (writes.get(store) ?? Promise.resolve()).then(run, run);
  writes.set(store, next.catch(() => {}));
  return next;
}

export async function readRecovery(store: Persistence, id: string): Promise<Uint8Array> {
  const record = await store.getMeta(RECORD + id) as RecoveryRecord | undefined;
  if (!record || record.v !== 1 || record.id !== id || !Number.isSafeInteger(record.size) || record.size < 0 || record.chunks !== Math.ceil(record.size / CHUNK)) throw new Error('Recovery record is missing or unsupported.');
  const bytes = new Uint8Array(record.size);
  for (let n = 0; n < record.chunks; n++) {
    const chunk = await store.getMeta(contentKey(id, n));
    if (!isBytes(chunk) || chunk.length !== Math.min(CHUNK, record.size - n * CHUNK)) throw new Error('Recovery content is incomplete.');
    bytes.set(chunk, n * CHUNK);
  }
  if (await sha256Hex(bytes) !== record.hash) throw new Error('Recovery content failed integrity verification.');
  return bytes;
}
