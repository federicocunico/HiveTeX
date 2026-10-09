import { Gunzip } from 'fflate';
import { ImportError, safePath } from './filter.js';
import type { ArchiveRead } from './zip.js';
import { LIMITS } from './limits.js';

/**
 * Decompresses gzip incrementally so a decompression bomb is stopped as soon as the output passes `max`,
 * instead of after the whole thing has been allocated.
 */
export function gunzipLimited(data: Uint8Array, max = LIMITS.maxTotal + 1024 * 1024): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const g = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > max) throw new ImportError('The archive is too large (over 500 MB extracted)');
    chunks.push(chunk);
  });
  const STEP = 16 * 1024;
  try {
    for (let i = 0; i < data.length; i += STEP) g.push(data.subarray(i, i + STEP), i + STEP >= data.length);
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(`The archive is corrupt: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const dec = new TextDecoder();

function str(b: Uint8Array, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const end = s.indexOf(0);
  return dec.decode(end < 0 ? s : s.subarray(0, end));
}

function octal(b: Uint8Array, off: number, len: number): number {
  // GNU base-256 encoding for large values
  if ((b[off] as number) & 0x80) {
    let v = 0;
    for (let i = 1; i < len; i++) v = v * 256 + (b[off + i] as number);
    return v;
  }
  const s = str(b, off, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

function checksumOk(h: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
  return sum === octal(h, 148, 8);
}

function paxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = dec.decode(data);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = Number.parseInt(text.slice(i, sp), 10);
    if (!(len > 0)) break;
    const rec = text.slice(sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function isTar(b: Uint8Array): boolean {
  return b.length >= 512 && str(b, 257, 5) === 'ustar';
}

/**
 * Reads a (possibly gzipped) tar archive. Only regular files and directories are accepted; links, devices and
 * FIFOs make the whole archive unsafe. Supports ustar prefixes, PAX `path` records and GNU long names.
 */
export function readTar(input: Uint8Array): ArchiveRead {
  const b = input[0] === 0x1f && input[1] === 0x8b ? gunzipLimited(input) : input;
  const files: ArchiveRead['files'] = [];
  const tooLarge: string[] = [];
  let off = 0;
  let total = 0;
  let count = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= b.length) {
    const h = b.subarray(off, off + 512);
    if (h.every((x) => x === 0)) return { files, tooLarge };
    if (!checksumOk(h)) throw new ImportError('The archive is corrupt (bad tar header)');
    const type = String.fromCharCode(h[156] as number);
    const size = octal(h, 124, 12);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > b.length) throw new ImportError('The archive is corrupt (truncated)');
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      paxPath = paxRecords(b.subarray(dataStart, dataEnd)).path ?? null;
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = str(b, dataStart, size);
      continue;
    }
    const prefix = str(h, 345, 155);
    const rawName = paxPath ?? longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    paxPath = null;
    longName = null;
    if (++count > LIMITS.maxEntries) throw new ImportError(`The archive has too many entries (over ${LIMITS.maxEntries})`);
    const path = safePath(rawName);
    if (type === '5') continue;
    if (type !== '0' && type !== '\0' && type !== '7') {
      const what = type === '2' ? 'symbolic link' : type === '1' ? 'hard link' : `type ${type}`;
      throw new ImportError(`Unsafe entry in archive (${what}): ${rawName}`);
    }
    if (size > LIMITS.maxFile) {
      tooLarge.push(path);
      continue;
    }
    total += size;
    if (total > LIMITS.maxTotal) throw new ImportError('The archive is too large (over 500 MB extracted)');
    files.push({ path, bytes: b.slice(dataStart, dataEnd) });
  }
  if (off < b.length) throw new ImportError('The archive is corrupt (truncated)');
  if (count === 0) throw new ImportError('The archive is empty');
  return { files, tooLarge };
}
