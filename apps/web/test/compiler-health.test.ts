import { describe, expect, it } from 'vitest';
import { type CompilerHealth, healthMessage, setSystemTexAside } from '../src/lib/compiler-health.js';

const h = (o: Partial<CompilerHealth>): CompilerHealth => ({ state: 'ok', compiler: 'texlive', steps: [], log: '', at: 1, ...o });

describe('desktop compiler check', () => {
  it('names the compiler and what the repair did', () => {
    expect(healthMessage(h({}))).toBe('Compiler check passed (TeX Live).');
    expect(healthMessage(h({ state: 'repaired', compiler: 'tinytex (managed)', steps: ['cleared the compiler caches', 'installed the full LaTeX again'] }))).toBe(
      'The compiler did not work and was repaired: cleared the compiler caches; installed the full LaTeX again. It now compiles with full LaTeX.',
    );
    expect(healthMessage(h({ state: 'failed', compiler: 'miktex', steps: ['cleared the compiler caches'] }))).toMatch(/MiKTeX\) does not work and could not be repaired/);
    expect(healthMessage(h({ state: 'offline' }))).toMatch(/offline/);
    expect(healthMessage(h({ state: 'none', compiler: null }))).toBeNull();
    expect(healthMessage(null)).toBeNull();
  });

  it('offers the system TeX again only after the check set it aside', () => {
    expect(setSystemTexAside(h({ state: 'repaired', steps: ['cleared the compiler caches', 'set the system TeX (texlive) aside'] }))).toBe(true);
    expect(setSystemTexAside(h({ state: 'repaired', steps: ['cleared the compiler caches'] }))).toBe(false);
    expect(setSystemTexAside(h({ state: 'failed', steps: ['set the system TeX (texlive) aside', 'kept the system TeX (texlive)'] }))).toBe(false);
  });
});
