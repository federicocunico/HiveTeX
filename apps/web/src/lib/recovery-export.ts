import { encodeValue, sha256Hex, type Persistence, type IngressEntry, type ProjectModel, type RawStoreExport } from '@hivetex/sync';
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import * as Y from 'yjs';
import { Sha256Stream } from './sha256-stream.js';

export interface RecoveryExport {
  zip: Uint8Array;
  /** Files whose content could not be read (not in memory and storage is failing, or a binary not on this device). */
  missing: string[];
}

/** Where an archive is written, in order, chunk by chunk (a file, a Blob, memory in tests). */
export interface ArchiveSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Discards everything written: nothing may remain at the destination. */
  abort(): Promise<void>;
}

/** fflate writes no ZIP64: an archive must stay below 4 GiB. The margin covers headers and estimate error. */
export const ZIP_LIMIT = 2 ** 32 - 64 * 2 ** 20;
export class ArchiveTooLargeError extends Error {}
const PIECE = 1024 * 1024;
const gib = (n: number) => `${(n / 2 ** 30).toFixed(1)} GiB`;

/**
 * A zip of the project as this device holds it right now, for when local storage keeps failing. It reads what is
 * in memory first, so edits that were never stored are included, and never stops at the first unreadable file.
 * `getBlob` supplies binary content (it may fail for files this device does not have).
 * Kept for small projects and tests: the archive is assembled in memory. Large exports use `exportRecoveryArchive`.
 */
export async function exportRecoveryZip(model: ProjectModel, getBlob: (hash: string) => Promise<Uint8Array>, getIngress?: () => Promise<IngressEntry[]>, store: Persistence = model.store, priorMissing: string[] = []): Promise<RecoveryExport> {
  const sink = memorySink();
  const { missing } = await exportRecoveryArchive(model, getBlob, getIngress, store, priorMissing, async () => sink);
  return { zip: sink.bytes(), missing };
}

/**
 * Streams the recovery archive into the sink `open` returns (D7): at most one entry piece (1 MiB, or one asset) is in
 * memory beyond what the project already holds; the native database copy is hashed incrementally. An archive whose
 * estimated size exceeds `ZIP_LIMIT` is refused with `ArchiveTooLargeError` before `open` is called, so nothing is
 * written; the store is only read.
 */
export async function exportRecoveryArchive(model: ProjectModel, getBlob: (hash: string) => Promise<Uint8Array>, getIngress: (() => Promise<IngressEntry[]>) | undefined, store: Persistence, priorMissing: string[], open: () => Promise<ArchiveSink>): Promise<{ missing: string[]; size: number }> {
  const missing: string[] = [...priorMissing];
  if (model.saveState.failing && !missing.some((item) => item.startsWith('uncommitted operation history'))) missing.push('uncommitted operation history (storage is failing; live document contents are included where available)');
  await Promise.allSettled(model.list().filter((f) => f.kind === 'text').map((f) => model.openText(f.id)));
  // Freeze all readable text and live document states at one synchronous boundary, before asset/storage awaits.
  const captured = model.list(), readableRevision = model.changeSeq;
  const live = new Map(model.loadedDocIds().map((id) => [id, Y.encodeStateAsUpdate(model.getLoadedDoc(id)!)]));
  const texts = new Map<string, Uint8Array>();
  for (const f of captured) if (f.kind === 'text') {
    const doc = model.getLoadedDoc(`f:${f.id}`);
    if (doc) texts.set(f.path, strToU8(doc.getText('t').toString()));
    else missing.push(f.path);
  }
  const paths = new Set(captured.filter((f) => f.kind !== 'dir').map((f) => f.path));
  const taken = (dir: string) => [...paths].some((p) => p === dir || p.startsWith(`${dir}/`));
  let ingress: { dir: string; entries: IngressEntry[]; bases: Array<{ docId: string; file: string; bytes: Uint8Array }> } | null = null;
  if (getIngress) {
    try {
      const entries = await getIngress();
      if (entries.length) {
        let dir = '.hivetex-recovery', n = 0;
        while (taken(dir)) dir = `.hivetex-recovery-${++n}`;
        const bases: Array<{ docId: string; file: string; bytes: Uint8Array }> = [];
        for (const docId of new Set(entries.map((e) => e.docId))) {
          try { bases.push({ docId, file: `${dir}/bases/${bases.length}.yjs`, bytes: Y.encodeStateAsUpdate(await model.getDoc(docId)) }); }
          catch { missing.push(`base snapshot for ${docId}`); }
        }
        ingress = { dir, entries, bases };
        paths.add(dir);
      }
    } catch { missing.push('native pending edit journal'); }
  }
  let archive = '.hivetex-archive', suffix = 0;
  while (taken(archive)) archive = `.hivetex-archive-${++suffix}`;
  let raw: RawStoreExport | null = null;
  try { raw = await store.openRawExport?.() ?? null; } catch { missing.push('complete local storage archive'); }
  const legacyRaw = !raw && !!store.exportRawStore && !missing.includes('complete local storage archive');
  // Refuse before writing anything: known bytes plus a per-entry allowance (deflate never grows stored entries much).
  const sum = (values: Iterable<Uint8Array>) => [...values].reduce((n, b) => n + b.length, 0);
  const estimate = sum(texts.values()) + 2 * sum(live.values()) + sum(ingress?.bases.map((b) => b.bytes) ?? [])
    + captured.reduce((n, f) => n + (f.kind === 'binary' ? f.size ?? 0 : 0), 0) + Math.max(0, raw?.size ?? 0) + 512 * (captured.length + live.size + 16);
  if (estimate > ZIP_LIMIT) {
    await raw?.close().catch(() => {});
    throw new ArchiveTooLargeError(`The full recovery copy would be about ${gib(estimate)}, over the ${gib(ZIP_LIMIT)} limit of the ZIP format. Nothing was written. Download the project files instead, or remove unused assets and history first.`);
  }

  const sink = await open().catch(async (e) => { await raw?.close().catch(() => {}); throw e; });
  const queue: Uint8Array[] = [];
  let zipError: unknown = null, size = 0;
  const zip = new Zip((error, chunk) => { if (error) zipError = error; else if (chunk.length) queue.push(chunk); });
  const drain = async () => {
    if (zipError) throw zipError;
    while (queue.length) {
      const chunk = queue.shift()!;
      size += chunk.length;
      if (size > ZIP_LIMIT) throw new ArchiveTooLargeError(`The full recovery copy grew past the ${gib(ZIP_LIMIT)} ZIP limit while it was written and was discarded.`);
      await sink.write(chunk);
    }
  };
  const small = async (name: string, bytes: Uint8Array) => {
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    for (let at = 0; at < bytes.length; at += PIECE) { entry.push(bytes.subarray(at, at + PIECE)); await drain(); }
    entry.push(new Uint8Array(0), true);
    await drain();
  };
  /** Stored, not deflated (databases and assets): bounded pieces, hashed as they pass. */
  const stored = async (name: string, source: AsyncIterable<Uint8Array> | Uint8Array) => {
    const entry = new ZipPassThrough(name), hash = new Sha256Stream();
    zip.add(entry);
    const pieces = source instanceof Uint8Array ? (function* () { for (let at = 0; at < source.length; at += PIECE) yield source.subarray(at, at + PIECE); })() : source;
    for await (const piece of pieces) { hash.update(piece); entry.push(piece); await drain(); }
    entry.push(new Uint8Array(0), true);
    await drain();
    return hash.hex();
  };
  const manifest: Array<{ file: string; kind: string; id: string; sha256: string }> = [];
  const record = async (kind: string, id: string, value: unknown, rawBytes?: Uint8Array | AsyncIterable<Uint8Array>) => {
    const file = `${archive}/${kind}/${manifest.length}.${rawBytes ? 'bin' : 'json'}`;
    let sha256: string;
    if (rawBytes) sha256 = await stored(file, rawBytes);
    else { const bytes = strToU8(encodeValue(value)); await small(file, bytes); sha256 = await sha256Hex(bytes); }
    manifest.push({ file, kind, id, sha256 });
  };
  try {
    for (const [path, bytes] of texts) await small(path, bytes);
    for (const f of captured) {
      if (f.kind !== 'binary' || !f.hash) continue;
      let bytes: Uint8Array;
      try { bytes = await getBlob(f.hash); } catch { missing.push(f.path); continue; }
      await stored(f.path, bytes);
    }
    if (ingress) {
      for (const base of ingress.bases) await small(base.file, base.bytes);
      await small(`${ingress.dir}/ingress.json`, strToU8(encodeValue({ version: 1, entries: ingress.entries, bases: ingress.bases.map(({ docId, file }) => ({ docId, file })) })));
      await small(`${ingress.dir}/README.txt`, strToU8('Pending and denied edits retained on this device are included in ingress.json as lossless Yjs updates, with their original document bases in bases/. To recover locally, apply a base snapshot to a new Y.Doc, then the entries for its docId. They are recovery data, not part of the shared project. Denied edits must not be automatically published.\n'));
    }
    // The full local archive includes tombstones/orphans, every retained asset and private recovery/operation metadata.
    // Read failures are explicit; readable in-memory edits above remain downloadable even when storage is broken.
    try {
      if (raw || legacyRaw) {
        // A native SQLite copy includes every persisted table, including journals and staging, without huge list replies.
        try { await record('native-store', 'complete.sqlite3', null, raw ? raw.chunks : store.exportRawStore!()); }
        finally { await raw?.close().catch(() => {}); }
        for (const id of new Set([...(await store.listDocs()), ...live.keys()])) {
          let value: unknown;
          try { value = { updates: await store.load(id), ...(live.has(id) ? { live: live.get(id) } : {}) }; } catch { missing.push(`archived document ${id}`); continue; }
          await record('documents', id, value);
        }
        await small(`${archive}/NATIVE-STORE.txt`, strToU8('native-store contains a coherent, integrity-checked SQLite database, including all persisted documents, blobs, snapshots, changes, metadata and pending/denied ingress. Open a copy with a compatible HiveTeX build or SQLite tools. Values use the lossless encodeValue JSON format. documents contains live in-memory Yjs states captured before export, including edits not yet stored. The manifest hashes every entry. Do not open the original user database with older software.\n'));
      } else if (!missing.includes('complete local storage archive')) {
        for (const id of new Set([...(await store.listDocs()), ...model.loadedDocIds()])) {
          let value: unknown;
          try { value = { updates: await store.load(id), ...(live.has(id) ? { live: live.get(id) } : {}) }; } catch { missing.push(`archived document ${id}`); continue; }
          await record('documents', id, value);
        }
        for (const hash of await store.listBlobs()) {
          let bytes: Uint8Array | undefined;
          try { bytes = await store.getBlob(hash); if (!bytes) throw new Error('missing'); } catch { missing.push(`archived asset ${hash}`); continue; }
          await record('assets', hash, null, bytes);
        }
        if (!store.listMetaKeys) throw new Error('metadata listing unavailable');
        for (const key of await store.listMetaKeys()) {
          let value: unknown;
          try { value = await store.getMeta(key); } catch { missing.push(`archived metadata ${key}`); continue; }
          await record('metadata', key, value);
        }
        for (const snapshot of await store.listSnapshots()) await record('snapshots', snapshot.id, snapshot);
        for (const set of await store.listChangeSets()) await record('changes', set.id, set);
      }
    } catch (e) {
      if (e instanceof ArchiveTooLargeError || zipError || isSinkError(e)) throw e;
      missing.push('complete local storage archive');
    }
    await small(`${archive}/manifest.json`, strToU8(JSON.stringify({ v: 1, format: 'hivetex-full-recovery', at: Date.now(), readableRevision, archiveEndRevision: model.changeSeq, changedDuringExport: readableRevision !== model.changeSeq, entries: manifest, missing }, null, 2)));
    if (missing.length) await small(paths.has('RECOVERY-MISSING.txt') ? `${archive}/RECOVERY-MISSING.txt` : 'RECOVERY-MISSING.txt', strToU8(`These files could not be read when this copy was made:\n${missing.join('\n')}\n`));
    zip.end();
    await drain();
    await sink.close();
  } catch (e) {
    zip.terminate();
    await raw?.close().catch(() => {});
    await sink.abort().catch(() => {});
    throw e;
  }
  return { missing, size };
}

/** A failed write to the destination ends the export (it is not reported as unreadable storage). */
class SinkError extends Error {}
const isSinkError = (e: unknown) => e instanceof SinkError;
const guarded = (sink: ArchiveSink): ArchiveSink => ({
  write: (chunk) => sink.write(chunk).catch((e) => { throw new SinkError(e instanceof Error ? e.message : String(e)); }),
  close: () => sink.close(),
  abort: () => sink.abort(),
});

/** Collects the archive in memory (tests and the small-project compatibility path). */
export function memorySink(): ArchiveSink & { bytes(): Uint8Array } {
  let parts: Uint8Array[] = [];
  return guarded2({
    write: async (chunk) => { parts.push(chunk); },
    close: async () => {},
    abort: async () => { parts = []; },
  }, () => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  });
}
function guarded2<T>(sink: ArchiveSink, bytes: () => T) { return Object.assign(guarded(sink), { bytes }); }

/** Browser fallback: Blob parts, merged as they grow so the browser can page them out of the JS heap. */
export function blobSink(type = 'application/zip'): ArchiveSink & { blob(): Blob } {
  let parts: BlobPart[] = [], pending: Uint8Array[] = [], bytes = 0;
  const merge = () => { if (pending.length) { parts = [new Blob([...parts, ...pending as BlobPart[]], { type })]; pending = []; bytes = 0; } };
  return Object.assign(guarded({
    write: async (chunk) => { pending.push(chunk); bytes += chunk.length; if (bytes >= 16 * PIECE) merge(); },
    close: async () => merge(),
    abort: async () => { parts = []; pending = []; },
  }), { blob: () => { merge(); return new Blob(parts, { type }); } });
}

/** A file the member chose with the File System Access API (`showSaveFilePicker`). */
export async function fileHandleSink(handle: { createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }): Promise<ArchiveSink> {
  const out = await handle.createWritable();
  return guarded({ write: (chunk) => out.write(chunk as BlobPart), close: () => out.close(), abort: () => out.abort() });
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
/** Desktop: a file picked in the native save dialog, appended in bounded calls (store_cmd.rs). `null`: cancelled. */
export async function nativeFileSink(invoke: Invoke, name: string): Promise<ArchiveSink | null> {
  const token = await invoke<string | null>('recovery_save_begin', { name });
  if (!token) return null;
  return guarded({
    write: async (chunk) => { for (let at = 0; at < chunk.length; at += PIECE) await invoke('recovery_save_append', { token, b64: toB64(chunk.subarray(at, at + PIECE)) }); },
    close: () => invoke('recovery_save_finish', { token }),
    abort: () => invoke('recovery_save_abort', { token }),
  });
}

/**
 * Writes an archive to the best destination available, never assembling it in memory where avoidable: the native
 * save dialog on desktop, a chosen file in browsers with `showSaveFilePicker`, Blob parts and a download otherwise.
 * Resolves `false` when the member cancelled the save dialog.
 */
export async function saveArchive(name: string, write: (open: () => Promise<ArchiveSink>) => Promise<unknown>, o: { invoke?: Invoke } = {}): Promise<boolean> {
  class Cancelled extends Error {}
  try {
    if (o.invoke) {
      const invoke = o.invoke;
      await write(async () => (await nativeFileSink(invoke, name)) ?? Promise.reject(new Cancelled()));
      return true;
    }
    const picker = (globalThis as { showSaveFilePicker?: (o: unknown) => Promise<Parameters<typeof fileHandleSink>[0]> }).showSaveFilePicker;
    if (picker) {
      await write(async () => fileHandleSink(await picker({ suggestedName: name, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] }).catch(() => Promise.reject(new Cancelled()))));
      return true;
    }
    const sink = blobSink();
    await write(async () => sink);
    const url = URL.createObjectURL(sink.blob());
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch (e) {
    if (e instanceof Cancelled) return false;
    throw e;
  }
}
