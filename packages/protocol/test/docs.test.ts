import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MsgType, VIEWER_ALLOWED } from '../src/index.js';

const doc = readFileSync(resolve(__dirname, '../../../docs/protocol.md'), 'utf8');

describe('docs/protocol.md matches packages/protocol (6.10)', () => {
  const rows = [...doc.matchAll(/^\|\s*(0x[0-9a-f]{2})\s*\|\s*([A-Z0-9_]+)\s*\|/gim)].map((m) => [m[2] as string, Number.parseInt(m[1] as string, 16)] as const);

  it('lists every message type with the right value, and nothing else', () => {
    expect(Object.fromEntries(rows)).toEqual(MsgType);
  });

  it('names exactly the viewer-allowed types', () => {
    const line = /Types a `viewer` connection may send[^:]*:\s*([^\n]+(?:\n[^\n]+)?)/.exec(doc)?.[1] ?? '';
    const names = [...line.matchAll(/`([A-Z_0-9]+)`/g)].map((m) => m[1] as string);
    const expected = Object.entries(MsgType).filter(([, v]) => VIEWER_ALLOWED.has(v)).map(([k]) => k);
    expect(new Set(names)).toEqual(new Set(expected));
  });

  it('documents the same framing constants', () => {
    expect(doc).toContain('0x80');
    expect(doc).toContain('16 KiB');
    expect(doc).toContain('1 MiB');
  });
});
