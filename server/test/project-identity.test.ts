import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { ProjectPrefix, projectShareId, projectSuffix } from '../src/projects/identity.js';

const tail = () => 'abcdefghijklmnop';

describe('new shared project IDs', () => {
  it('adds fresh random suffixes even to repeated names', () => {
    const a = projectShareId('projecttest');
    const b = projectShareId('projecttest');
    expect(a).toMatch(/^projecttest-[a-z2-7]{16}$/);
    expect(b).not.toBe(a);
  });
  it('defaults, normalizes and accepts a short prefix', () => {
    expect(projectShareId(undefined, tail)).toBe('project-abcdefghijklmnop');
    expect(projectShareId(' -My---Paper- ', tail)).toBe('my-paper-abcdefghijklmnop');
    expect(projectShareId('a', tail)).toBe('a-abcdefghijklmnop');
  });
  it('fits the legacy 48-character limit without interpreting an input suffix', () => {
    expect(projectShareId('a'.repeat(31), tail)).toHaveLength(48);
    expect(projectShareId('a'.repeat(48), tail)).toHaveLength(48);
    expect(projectShareId('paper-abcdefghijklmnop', tail)).toBe('paper-abcdefghijklmnop-abcdefghijklmnop');
    expect(v.parse(ProjectPrefix, 'a'.repeat(30) + '-z')).toBe('a'.repeat(30));
  });
  it('rejects invalid prefixes before allocation', () => {
    for (const s of ['', '---', 'hello world', 'a/b', 'a'.repeat(49), 'é']) expect(v.safeParse(ProjectPrefix, s).success).toBe(false);
  });
  it('encodes all ten bytes without losing entropy', () => {
    expect(projectSuffix(new Uint8Array(10))).toBe('a'.repeat(16));
    expect(projectSuffix(new Uint8Array(10).fill(255))).toBe('7'.repeat(16));
    expect(() => projectSuffix(new Uint8Array(9))).toThrow();
  });
});
