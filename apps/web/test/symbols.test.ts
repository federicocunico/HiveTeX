import { describe, expect, it } from 'vitest';
import { symbol } from '../src/lib/latex-insert.js';
import { SYMBOL_CATEGORIES, SYMBOLS, searchSymbols } from '../src/lib/symbols.js';

describe('symbol palette data', () => {
  it('has at least 200 symbols across the main categories, with unique commands', () => {
    expect(SYMBOLS.length).toBeGreaterThanOrEqual(200);
    for (const c of ['Greek', 'Relations', 'Operators', 'Arrows']) expect(SYMBOL_CATEGORIES).toContain(c);
    const cmds = SYMBOLS.map((s) => `${s.category}:${s.command}`);
    expect(new Set(cmds).size).toBe(cmds.length);
  });

  it('finds symbols by name and by command', () => {
    expect(searchSymbols('less or equal').map((s) => s.command)).toContain('\\leq');
    expect(searchSymbols('\\lam')[0]?.command).toBe('\\lambda');
    expect(searchSymbols('alpha', 'Arrows')).toEqual([]);
  });

  it('puts the cursor inside an argument', () => {
    expect(symbol('\\sqrt{}', true)).toEqual({ text: '\\sqrt{}', anchor: 6 });
    expect(symbol('\\hat{}', false)).toEqual({ text: '$\\hat{}$', anchor: 6 });
  });
});
