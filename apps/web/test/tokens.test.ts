import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');

/** Declarations of the first `{…}` block that follows `marker`. */
function block(marker: string): Map<string, string> {
  const at = css.indexOf(marker);
  if (at < 0) throw new Error(`no block ${marker}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const out = new Map<string, string>();
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

const light = block(':root {');
const darkOs = block(":root:not([data-theme='light'])");
const darkPicked = block(":root[data-theme='dark']");

describe('theme tokens', () => {
  it('defines every dark token on bare :root too', () => {
    for (const name of darkOs.keys()) expect(light.has(name), `${name} missing from :root`).toBe(true);
  });

  it('keeps the OS-dark and picked-dark palettes identical', () => {
    expect([...darkPicked.entries()]).toEqual([...darkOs.entries()]);
  });
});

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const LARGE_OR_UI = 3;
/** [foreground, background, minimum ratio] pairs that carry text or meaning. */
const pairs: Array<[string, string, number]> = [
  ...['--ink', '--muted', '--faint', '--honey-ink'].flatMap((fg) =>
    ['--paper', '--surface', '--sunken'].map((bg): [string, string, number] => [fg, bg, TEXT]),
  ),
  ['--honey-ink', '--honey-soft', TEXT],
  ['--ink', '--honey-soft', TEXT],
  ['--on-honey', '--honey', TEXT],
  ['--ok', '--ok-soft', TEXT],
  ['--warn', '--warn-soft', TEXT],
  ['--bad', '--bad-soft', TEXT],
  ['--ok', '--surface', TEXT],
  ['--warn', '--surface', TEXT],
  ['--bad', '--surface', TEXT],
  ...['--syn-cmd', '--syn-env', '--syn-math', '--syn-comment', '--syn-brace', '--syn-string'].map(
    (fg): [string, string, number] => [fg, '--surface', TEXT],
  ),
  ['--ink', '--active-line', TEXT],
  ['--ink', '--selection', TEXT],
  ...['--p1', '--p2', '--p3', '--p4', '--p5', '--p6', '--p7', '--p8'].flatMap((p): Array<[string, string, number]> => [
    [p, '--surface', LARGE_OR_UI],
    // Avatar initials and cursor labels are small text on the presence color.
    ['--on-presence', p, TEXT],
  ]),
  ['--line-strong', '--surface', 1.5],
];

describe.each([
  ['light', light],
  ['dark', new Map([...light, ...darkOs])],
])('contrast (%s)', (_name, palette) => {
  it.each(pairs)('%s on %s ≥ %d', (fg, bg, min) => {
    const a = palette.get(fg);
    const b = palette.get(bg);
    expect(a, fg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(b, bg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(a as string, b as string)).toBeGreaterThanOrEqual(min);
  });
});
