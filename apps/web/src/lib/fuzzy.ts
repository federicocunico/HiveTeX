/**
 * Small fuzzy matcher for the command palette: every query character must appear in order. Consecutive runs, word
 * starts and an early first match score higher. Returns the matched ranges for highlighting, or null.
 */
export interface FuzzyMatch {
  score: number;
  /** [start, end) ranges in `text` that matched. */
  ranges: Array<[number, number]>;
}

const isWordStart = (text: string, i: number) => i === 0 || /[\s/._\-:]/.test(text[i - 1] as string) || (/[a-z]/.test(text[i - 1] as string) && /[A-Z]/.test(text[i] as string));

export function fuzzy(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  const t = text.toLowerCase();

  // A plain substring beats any scattered match.
  const sub = t.indexOf(q);
  if (sub >= 0) return { score: 1000 - sub * 2 + (isWordStart(text, sub) ? 200 : 0) - text.length / 100, ranges: [[sub, sub + q.length]] };

  let score = 0;
  let ti = 0;
  let run = 0;
  const ranges: Array<[number, number]> = [];
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    if (at === ti && ranges.length) {
      run++;
      (ranges[ranges.length - 1] as [number, number])[1] = at + 1;
    } else {
      run = 0;
      ranges.push([at, at + 1]);
    }
    score += 10 + run * 8 + (isWordStart(text, at) ? 25 : 0) - Math.min(at - ti, 20);
    ti = at + 1;
  }
  return { score: score - text.length / 100, ranges };
}

/** Splits `text` into parts for rendering, marking the matched ones. */
export function highlightParts(text: string, ranges: Array<[number, number]>): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let i = 0;
  for (const [a, b] of ranges) {
    if (a > i) out.push({ text: text.slice(i, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    i = b;
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false });
  return out;
}
