import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Emoji and pictographs are not interface icons: the UI uses the Lucide set from ui/icons.ts. */
const PICTOGRAPHS = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25B2}\u{25B8}\u{25BE}\u{FF0B}\u{21B6}]/u;

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? svelteFiles(p) : p.endsWith('.svelte') ? [p] : [];
  });
}

describe('interface glyphs', () => {
  it('uses no emoji or pictograph glyphs in component markup', () => {
    const offenders: string[] = [];
    const files = svelteFiles(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (PICTOGRAPHS.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
