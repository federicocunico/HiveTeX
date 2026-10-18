import type { ChangeSet, HistorySnapshot, Persistence } from './persistence.js';
import { isBytes } from './bytes.js';

/**
 * Store migration (D4, 5.3-5.4): copies everything a project store holds (raw Yjs updates per document, blobs, history
 * snapshots, change sets and every metadata key, completeness markers and offline-merge journals included) into another
 * store, in bounded batches, without creating new authored state. `storeDigest` canonically summarizes a store so source
 * and target can be compared after reopening the target.
 */

export interface CopyCounts {
  docs: number;
  updates: number;
  blobs: number;
  snapshots: number;
  changes: number;
  meta: number;
}

export interface CopyOptions {
  /** Updates of one document are appended in batches of at most this many bytes (default 4 MiB). */
  batchBytes?: number;
  /** Items already copied by an interrupted run (resume): skipped. */
  done?: { docs?: Set<string>; blobs?: Set<string> };
  /** Called after each document or blob so a caller can checkpoint progress. */
  onItem?: (kind: 'doc' | 'blob', id: string) => void | Promise<void>;
  /** Metadata keys that belong to the migration itself and are never copied. */
  skipMeta?: (key: string) => boolean;
}

const enc = new TextEncoder();
async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', data as unknown as BufferSource));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}
/** Canonical JSON: sorted keys, bytes as hex (so digests do not depend on insertion order or encoding). */
function canonical(v: unknown): string {
  if (isBytes(v)) return JSON.stringify({ $u8: Array.from(v, (x) => x.toString(16).padStart(2, '0')).join('') });
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Copies `src` into `dst`. The target only ever receives what the source holds; nothing is re-encoded or merged. */
export async function copyStore(src: Persistence, dst: Persistence, o: CopyOptions = {}): Promise<CopyCounts> {
  if (!src.listMetaKeys) throw new Error('source store cannot list its metadata');
  const limit = o.batchBytes ?? 4 * 1024 * 1024;
  const counts: CopyCounts = { docs: 0, updates: 0, blobs: 0, snapshots: 0, changes: 0, meta: 0 };
  for (const docId of (await src.listDocs()).sort()) {
    if (o.done?.docs?.has(docId)) continue;
    const updates = await src.load(docId);
    // A resumed copy restarts this document from scratch: its partial target state is replaced, never duplicated.
    const batches: Uint8Array[][] = [];
    let cur: Uint8Array[] = [];
    let bytes = 0;
    for (const u of updates) {
      if (cur.length && bytes + u.length > limit) {
        batches.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(u);
      bytes += u.length;
    }
    if (cur.length) batches.push(cur);
    const [first, ...rest] = batches;
    if (first && first.length === 1) await dst.compact(docId, first[0] as Uint8Array);
    else if (first) {
      // compact() replaces the document; then the rest of the first batch and the following batches are appended.
      await dst.compact(docId, first[0] as Uint8Array);
      await dst.append(docId, first.slice(1));
    }
    for (const b of rest) await dst.append(docId, b);
    counts.docs++;
    counts.updates += updates.length;
    await o.onItem?.('doc', docId);
  }
  for (const hash of (await src.listBlobs()).sort()) {
    if (o.done?.blobs?.has(hash)) continue;
    const bytes = await src.getBlob(hash);
    if (bytes) {
      await dst.putBlob(hash, bytes);
      counts.blobs++;
    }
    await o.onItem?.('blob', hash);
  }
  const existingSnaps = new Set((await dst.listSnapshots()).map((s) => s.id));
  for (const s of await src.listSnapshots()) {
    if (!existingSnaps.has(s.id)) await dst.putSnapshot(s);
    counts.snapshots++;
  }
  for (const c of await src.listChangeSets()) {
    await dst.putChangeSet(c);
    counts.changes++;
  }
  for (const key of (await src.listMetaKeys()).sort()) {
    if (o.skipMeta?.(key)) continue;
    await dst.setMeta(key, await src.getMeta(key));
    counts.meta++;
  }
  return counts;
}

export interface StoreDigest {
  /** SHA-256 over every part below. */
  sha256: string;
  counts: CopyCounts;
  /** Per-part digests, to locate a difference. */
  parts: { docs: string; blobs: string; snapshots: string; changes: string; meta: string };
}

/** A canonical digest of a store's whole content (document state per doc, blob bytes, history, change sets, metadata). */
export async function storeDigest(p: Persistence, o: { skipMeta?: (key: string) => boolean } = {}): Promise<StoreDigest> {
  if (!p.listMetaKeys) throw new Error('store cannot list its metadata');
  const docs: string[] = [];
  let updates = 0;
  for (const docId of (await p.listDocs()).sort()) {
    const u = await p.load(docId);
    updates += u.length;
    // Raw update sequences are compared as stored: a migration copies them, it does not re-encode them.
    docs.push(`${docId}:${(await Promise.all(u.map(sha256Hex))).join(',')}`);
  }
  const blobs: string[] = [];
  for (const h of (await p.listBlobs()).sort()) {
    const b = await p.getBlob(h);
    blobs.push(`${h}:${b ? await sha256Hex(b) : 'missing'}`);
  }
  const snaps = (await p.listSnapshots()).map((s: HistorySnapshot) => canonical(s)).sort();
  const changes = (await p.listChangeSets()).map((c: ChangeSet) => canonical(c)).sort();
  const keys = (await p.listMetaKeys()).filter((k) => !o.skipMeta?.(k)).sort();
  const meta: string[] = [];
  for (const k of keys) meta.push(`${k}=${canonical(await p.getMeta(k))}`);
  const part = (xs: string[]) => sha256Hex(enc.encode(xs.join('\n')));
  const parts = { docs: await part(docs), blobs: await part(blobs), snapshots: await part(snaps), changes: await part(changes), meta: await part(meta) };
  return {
    sha256: await sha256Hex(enc.encode(Object.values(parts).join('|'))),
    counts: { docs: docs.length, updates, blobs: blobs.length, snapshots: snaps.length, changes: changes.length, meta: meta.length },
    parts,
  };
}
