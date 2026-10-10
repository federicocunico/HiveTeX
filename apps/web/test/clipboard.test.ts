// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../src/lib/clipboard.js';

describe('copyText', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falls back to the copy command when the Clipboard API never answers', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise(() => {}) } });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
    await copyText('/home/a/Documents/HiveTeX/thesis', 50);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('fails clearly when nothing can copy', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
    await expect(copyText('x', 50)).rejects.toThrow('not allowed');
  });
});
