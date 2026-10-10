// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyTheme, clampFont, DEFAULT_PREFS, parsePrefs } from '../src/lib/preferences.svelte.js';

describe('preferences', () => {
  it('falls back to defaults for missing or corrupt storage', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('not json')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('"a string"')).toEqual(DEFAULT_PREFS);
  });

  it('keeps valid values and drops unknown ones', () => {
    expect(parsePrefs(JSON.stringify({ theme: 'dark', editorFontSize: 18, toolbar: false, keymap: 'vim', extra: 1 }))).toEqual({
      theme: 'dark',
      editorFontSize: 18,
      toolbar: false,
      keymap: 'vim',
    });
    expect(parsePrefs(JSON.stringify({ theme: 'sepia', keymap: 'nano', toolbar: 'yes' }))).toEqual(DEFAULT_PREFS);
  });

  it('clamps the editor font size to 11–24', () => {
    expect(clampFont(4)).toBe(11);
    expect(clampFont(99)).toBe(24);
    expect(clampFont(15.6)).toBe(16);
    expect(clampFont('20')).toBe(DEFAULT_PREFS.editorFontSize);
    expect(parsePrefs(JSON.stringify({ editorFontSize: 40 })).editorFontSize).toBe(24);
  });

  it('sets data-theme for light and dark and clears it for system', () => {
    const root = document.createElement('html');
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('light', root);
    expect(root.dataset.theme).toBe('light');
    applyTheme('system', root);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});
