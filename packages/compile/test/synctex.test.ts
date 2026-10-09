import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { forwardSearch, parseSyncTeXGz, reverseSearch } from '../src/index.js';

const gz = new Uint8Array(readFileSync(fileURLToPath(new URL('./fixtures/sample.synctex.gz', import.meta.url))));

describe('SyncTeX navigation (8.7) on a real pdfTeX run', async () => {
  const idx = await parseSyncTeXGz(gz);

  it('indexes input files and pages', () => {
    const files = [...idx.inputs.values()];
    expect(files.some((f) => f.endsWith('/main.tex'))).toBe(true);
    expect(files.some((f) => f.endsWith('sections/body.tex'))).toBe(true);
    expect(idx.pages.size).toBe(2);
  });

  it('forward: finds lines on the right pages', () => {
    const a = forwardSearch(idx, 'main.tex', 3);
    expect(a?.page).toBe(1);
    const b = forwardSearch(idx, 'sections/body.tex', 4);
    expect(b?.page).toBe(2);
    const c = forwardSearch(idx, 'main.tex', 7);
    expect(c?.page).toBe(2); // last paragraph flows after \newpage in the included file
    expect(a && a.y).toBeLessThan(c ? 842 : 0);
  });

  it('reverse: a click inside the located text returns that source line (round trip)', () => {
    for (const [file, line] of [['main.tex', 3], ['sections/body.tex', 2], ['sections/body.tex', 4], ['main.tex', 7]] as const) {
      const pos = forwardSearch(idx, file, line);
      expect(pos, `${file}:${line}`).not.toBeNull();
      const p = pos as NonNullable<typeof pos>;
      const back = reverseSearch(idx, p.page, p.x + Math.min(p.w / 2, 40), p.y + p.h / 2);
      expect(back?.file.endsWith(file), `${file}:${line} -> ${JSON.stringify(back)}`).toBe(true);
      expect(back?.line).toBe(line);
    }
  });

  it('returns null for unknown files and far-away clicks', () => {
    expect(forwardSearch(idx, 'nope.tex', 1)).toBeNull();
    expect(reverseSearch(idx, 1, 5000, 5000)).toBeNull();
    expect(reverseSearch(idx, 99, 10, 10)).toBeNull();
  });

  it('coordinates are plausible PDF points on an A4/Letter page', () => {
    const p = forwardSearch(idx, 'main.tex', 3);
    expect(p?.x).toBeGreaterThan(60);
    expect(p?.x).toBeLessThan(200);
    expect(p?.y).toBeGreaterThan(60);
    expect(p?.y).toBeLessThan(800);
  });
});
