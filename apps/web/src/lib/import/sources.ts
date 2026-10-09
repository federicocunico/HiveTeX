import { classify } from './classify.js';
import { type Engine, type MainDetection, detectEngine, detectMain } from './detect.js';
import { ImportError, type SkipReason, commonRoot, safePath, skipReason } from './filter.js';
import { type ImportFile, LIMITS } from './limits.js';
import { isTar, readTar } from './tar.js';
import { readZip } from './zip.js';

export type PreparedFile =
  | { path: string; kind: 'text'; text: string; converted: boolean }
  | { path: string; kind: 'binary'; bytes: Uint8Array };

export interface Skipped {
  path: string;
  reason: SkipReason;
}

/** Everything read from one import input, validated and decoded, ready to be planned against a project. */
export interface ImportBundle {
  /** Display name (archive or folder name). */
  name: string;
  files: PreparedFile[];
  skipped: Skipped[];
  detection: MainDetection;
  /** Engine suggested by the detected main file, if any. */
  engine: Engine | null;
}

/** A file not yet read (from a file picker, a dropped folder, or a desktop folder). */
export interface LooseItem {
  path: string;
  size: number;
  read(): Promise<Uint8Array>;
}

export type Progress = (done: number, total: number) => void;

export const ARCHIVE_ACCEPT = '.zip,.tar,.tar.gz,.tgz';
export const SUPPORTED_FORMATS = 'zip, tar, tar.gz / tgz, folders and individual files';

export type InputKind = 'zip' | 'tar' | 'unsupported-archive' | 'file';

/** Classifies a picked file by name and magic bytes. */
export function inputKind(name: string, head: Uint8Array): InputKind {
  const n = name.toLowerCase();
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5)) return 'zip';
  if ((head[0] === 0x1f && head[1] === 0x8b) || isTar(head)) return /\.(tgz|tar\.gz|tar|gz)$/.test(n) || isTar(head) ? 'tar' : 'file';
  if (/\.(rar|7z|xz|bz2|zst|tar\.xz|tar\.bz2|cab|iso)$/.test(n)) return 'unsupported-archive';
  if (/\.(zip|tgz|tar)$/.test(n)) return 'unsupported-archive'; // claims to be an archive but is not readable as one
  return 'file';
}

export function isArchiveName(name: string): boolean {
  return /\.(zip|tar|tgz|tar\.gz|rar|7z)$/i.test(name);
}

interface PrepareOptions {
  /** Strip a top-level folder shared by every file (archives and imported folders). */
  stripRoot: boolean;
  /** Folder in the project to place files under. */
  prefix?: string;
}

/** Filters, normalizes and decodes raw files into a bundle. */
export function prepare(name: string, raw: ImportFile[], tooLarge: string[], opts: PrepareOptions): ImportBundle {
  const skipped: Skipped[] = tooLarge.map((path) => ({ path, reason: 'too-large' }));
  let kept: ImportFile[] = [];
  for (const f of raw) {
    const path = safePath(f.path);
    if (!path) continue;
    const reason = skipReason(path);
    if (reason) skipped.push({ path, reason });
    else kept.push({ path, bytes: f.bytes });
  }
  const root = opts.stripRoot ? commonRoot(kept.map((f) => f.path)) : null;
  if (root) kept = kept.map((f) => ({ path: f.path.slice(root.length + 1), bytes: f.bytes }));
  const prefix = opts.prefix ? `${safePath(opts.prefix)}/` : '';
  const files: PreparedFile[] = kept.map((f) => {
    const path = prefix + f.path;
    const c = classify(path, f.bytes);
    return c.kind === 'text' ? { path, kind: 'text', text: c.text, converted: c.converted } : { path, kind: 'binary', bytes: c.bytes };
  });
  const texts = files.flatMap((f) => (f.kind === 'text' ? [{ path: f.path, text: f.text }] : []));
  const detection = detectMain(texts);
  const mainText = texts.find((t) => t.path === detection.main)?.text;
  return { name, files, skipped, detection, engine: mainText ? detectEngine(mainText) : null };
}

/** Reads a zip or tar(.gz) archive into a bundle. */
export function readArchive(name: string, bytes: Uint8Array, prefix?: string): ImportBundle {
  const kind = inputKind(name, bytes.subarray(0, 512));
  if (kind === 'unsupported-archive' || kind === 'file') throw new ImportError(`Unsupported archive format. Supported: ${SUPPORTED_FORMATS}.`);
  const r = kind === 'zip' ? readZip(bytes) : readTar(bytes);
  return prepare(name, r.files, r.tooLarge, { stripRoot: true, ...(prefix ? { prefix } : {}) });
}

/** Reads loose files/folders, refusing over-limit inputs before reading anything. */
export async function readLoose(name: string, items: LooseItem[], opts: PrepareOptions, onProgress?: Progress): Promise<ImportBundle> {
  if (items.length > LIMITS.maxEntries) throw new ImportError(`Too many files (over ${LIMITS.maxEntries})`);
  const tooLarge: string[] = [];
  const ok: LooseItem[] = [];
  let total = 0;
  for (const it of items) {
    if (it.size > LIMITS.maxFile) tooLarge.push(safePath(it.path));
    else {
      total += it.size;
      ok.push(it);
    }
  }
  if (total > LIMITS.maxTotal) throw new ImportError('The selection is too large (over 500 MB)');
  const raw: ImportFile[] = [];
  let done = 0;
  for (const it of ok) {
    // Skipped entries (e.g. .git/) are never read.
    if (!skipReason(safePath(it.path))) raw.push({ path: it.path, bytes: await it.read() });
    else raw.push({ path: it.path, bytes: new Uint8Array() });
    onProgress?.(++done, ok.length);
  }
  return prepare(name, raw, tooLarge, opts);
}

/** Items from `<input type=file>` (with or without `webkitdirectory`). */
export function itemsFromFiles(files: File[]): LooseItem[] {
  return files.map((f) => ({
    path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
    size: f.size,
    read: async () => new Uint8Array(await f.arrayBuffer()),
  }));
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?(ok: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (es: FsEntry[]) => void, err: (e: unknown) => void): void };
}

async function walk(entry: FsEntry, out: LooseItem[]) {
  if (out.length > LIMITS.maxEntries) throw new ImportError(`Too many files (over ${LIMITS.maxEntries})`);
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, err) => entry.file?.(ok, err));
    out.push({ path: entry.fullPath.replace(/^\/+/, ''), size: file.size, read: async () => new Uint8Array(await file.arrayBuffer()) });
  } else if (entry.isDirectory && entry.createReader) {
    // Tool folders can be huge (node_modules, .git): don't even walk them.
    if (skipReason(`${entry.fullPath.replace(/^\/+/, '')}/`)) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
      if (batch.length === 0) break;
      for (const e of batch) await walk(e, out);
    }
  }
}

/**
 * Items from a drag-and-drop, walking dropped folders. Must be called synchronously inside the drop handler
 * (entries are only valid during the event); returns null when the browser lacks directory support.
 */
export function itemsFromDrop(dt: DataTransfer): Promise<{ items: LooseItem[]; hasFolder: boolean }> | null {
  const list = [...dt.items].filter((i) => i.kind === 'file');
  const entries = list.map((i) => (i as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null);
  if (entries.some((e) => e === null)) return null;
  return (async () => {
    const out: LooseItem[] = [];
    for (const e of entries as FsEntry[]) await walk(e, out);
    return { items: out, hasFolder: (entries as FsEntry[]).some((e) => e.isDirectory) };
  })();
}
