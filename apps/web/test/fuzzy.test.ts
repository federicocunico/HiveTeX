import { describe, expect, it } from 'vitest';
import { fuzzy, highlightParts } from '../src/lib/fuzzy.js';

describe('fuzzy', () => {
  it('matches substrings and in-order characters, and rejects the rest', () => {
    expect(fuzzy('comp', 'Compile now')?.ranges).toEqual([[0, 4]]);
    expect(fuzzy('cpn', 'Compile now')).not.toBeNull();
    expect(fuzzy('xyz', 'Compile now')).toBeNull();
    expect(fuzzy('', 'anything')?.score).toBe(0);
  });

  it('ranks word starts and prefixes above scattered matches', () => {
    const items = ['Download compiled PDF', 'Compile now', 'Open recent component'];
    const ranked = items.map((t) => ({ t, m: fuzzy('comp', t) })).sort((a, b) => (b.m?.score ?? -1) - (a.m?.score ?? -1));
    expect(ranked[0]?.t).toBe('Compile now');
    // Scattered matches prefer word starts: "gtl" → Go To Line.
    expect((fuzzy('gtl', 'Go to line')?.score ?? 0) > (fuzzy('gtl', 'aggregate list')?.score ?? 0)).toBe(true);
  });

  it('splits text into highlighted parts', () => {
    expect(highlightParts('Compile now', [[0, 4]])).toEqual([
      { text: 'Comp', hit: true },
      { text: 'ile now', hit: false },
    ]);
  });
});
