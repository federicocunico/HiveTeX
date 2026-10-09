import { isTextPath } from '@p2platex/sync';

export type Classified =
  | { kind: 'text'; text: string; converted: boolean }
  | { kind: 'binary'; bytes: Uint8Array };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const cp1252 = new TextDecoder('windows-1252');

/**
 * Decodes source text: UTF-8 (BOM stripped) when valid, otherwise Windows-1252 — the usual encoding of old
 * Latin-1 / Windows LaTeX sources. `converted` tells the caller the file was not UTF-8.
 */
export function decodeText(bytes: Uint8Array): { text: string; converted: boolean } {
  try {
    return { text: utf8.decode(bytes), converted: false };
  } catch {
    return { text: cp1252.decode(bytes), converted: true };
  }
}

/** Decides whether a file becomes collaborative text or a binary asset, and decodes text. */
export function classify(path: string, bytes: Uint8Array): Classified {
  if (!isTextPath(path, bytes)) return { kind: 'binary', bytes };
  return { kind: 'text', ...decodeText(bytes) };
}
