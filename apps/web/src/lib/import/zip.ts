import { type AcquireOptions, type BlobManager, type Mesh, type MissingContent, type ProjectModel, acquireProject } from '@hivetex/sync';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { ImportError, safePath } from './filter.js';
import { type ImportFile, LIMITS } from './limits.js';

export type ExportResult = { ok: true; zip: Uint8Array } | { ok: false; missing: MissingContent[] };

/**
 * A zip of the project's complete source tree: every text body and every image, captured together (see
 * `acquireProject`). It waits for content peers still have to send and works offline for a project that is complete on
 * this device; when something cannot be obtained it returns the missing files and no archive, never an archive with
 * empty stand-ins. (A recovery copy for failing storage is separate: see recovery-export.ts.)
 */
export async function exportProjectZip(mesh: Mesh, model: ProjectModel, blobs: BlobManager, opts: AcquireOptions = {}): Promise<ExportResult> {
  const got = await acquireProject(mesh, model, blobs, { timeoutMs: 15_000, assetTimeoutMs: 20_000, ...opts });
  if (!got.complete) return { ok: false, missing: got.missing };
  const files: Record<string, Uint8Array> = {};
  for (const f of got.capture.files) {
    if (f.kind === 'text') files[f.path] = strToU8(f.text ?? '');
    else if (f.kind === 'binary') files[f.path] = got.assets.get(f.hash ?? '') as Uint8Array;
  }
  return { ok: true, zip: zipSync(files, { level: 6 }) };
}

interface CentralEntry {
  name: string;
  link: boolean;
}

/**
 * Walks the zip central directory (the authoritative entry list) to count entries and find symbolic links, which
 * fflate does not expose. Throws for archives without a readable central directory.
 */
export function zipDirectory(bytes: Uint8Array): CentralEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportError('The archive is corrupt or not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new ImportError('ZIP64 archives are not supported');
  if (count > LIMITS.maxEntries) throw new ImportError(`The archive has too many entries (over ${LIMITS.maxEntries})`);
  const out: CentralEntry[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new ImportError('The archive is corrupt');
    const madeBy = dv.getUint16(p + 4, true) >> 8;
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const attrs = dv.getUint32(p + 38, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const mode = attrs >>> 16;
    out.push({ name, link: madeBy === 3 && (mode & 0o170000) === 0o120000 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export interface ArchiveRead {
  files: ImportFile[];
  tooLarge: string[];
}

/** Reads a zip safely: rejects unsafe paths and links, refuses bombs before inflating, skips oversized files. */
export function readZip(bytes: Uint8Array): ArchiveRead {
  for (const e of zipDirectory(bytes)) {
    safePath(e.name);
    if (e.link) throw new ImportError(`Unsafe entry in archive (symbolic link): ${e.name}`);
  }
  let total = 0;
  const tooLarge: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;
        if (f.originalSize > LIMITS.maxFile) {
          tooLarge.push(safePath(f.name));
          return false;
        }
        total += f.originalSize;
        if (total > LIMITS.maxTotal) throw new ImportError('The archive is too large (over 500 MB extracted)');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(`The archive is corrupt: ${e instanceof Error ? e.message : String(e)}`);
  }
  const files = Object.entries(entries).map(([name, data]) => ({ path: safePath(name), bytes: data }));
  return { files, tooLarge };
}
