// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyTheme, clampFont, DEFAULT_PREFS, parsePrefs, prefs, setPref, onPreferencesChange, PREFS_KEY } from '../src/lib/preferences.svelte.js';

describe('preferences', () => {
  it('falls back to defaults for missing or corrupt storage', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('not json')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('"a string"')).toEqual(DEFAULT_PREFS);
  });

  it('keeps valid values and drops unknown ones', () => {
    expect(parsePrefs(JSON.stringify({ theme: 'dark', editorFontSize: 18, toolbar: false, keymap: 'vim', extra: 1 }))).toEqual({
      ...DEFAULT_PREFS,
      theme: 'dark',
      editorFontSize: 18,
      toolbar: false,
      keymap: 'vim',
    });
    expect(parsePrefs(JSON.stringify({ theme: 'sepia', keymap: 'nano', toolbar: 'yes' }))).toEqual(DEFAULT_PREFS);
  });

  it('validates device schedules without interpreting the old compile mode', () => {
    for (const compileSchedule of ['after-changes', 'periodic', 'manual']) {
      expect(parsePrefs(JSON.stringify({ compileSchedule })).compileSchedule).toBe(compileSchedule);
    }
    for (const compileSchedule of ['local', 'shared', '', null, 1]) {
      expect(parsePrefs(JSON.stringify({ compileSchedule, compileMode: 'shared' })).compileSchedule).toBe('after-changes');
    }
    for (const compileIntervalSeconds of [0, -1, 4, 301, 5.5, '30', null]) {
      expect(parsePrefs(JSON.stringify({ compileIntervalSeconds })).compileIntervalSeconds).toBe(30);
    }
    for (const compileIntervalSeconds of [5, 30, 300]) {
      expect(parsePrefs(JSON.stringify({ compileIntervalSeconds })).compileIntervalSeconds).toBe(compileIntervalSeconds);
    }
  });

  it('persists validated schedules, preserves a valid interval on invalid entry, and follows other tabs', () => {
    let changes = 0;
    const off = onPreferencesChange(() => changes++);
    setPref('compileSchedule', 'manual');
    setPref('compileIntervalSeconds', 45);
    setPref('compileIntervalSeconds', 1.5);
    expect(prefs.compileIntervalSeconds).toBe(45);
    expect(parsePrefs(localStorage.getItem(PREFS_KEY))).toMatchObject({ compileSchedule: 'manual', compileIntervalSeconds: 45 });
    window.dispatchEvent(new StorageEvent('storage', { key: PREFS_KEY, newValue: JSON.stringify({ compileSchedule: 'periodic', compileIntervalSeconds: 5 }) }));
    expect(prefs.compileSchedule).toBe('periodic');
    expect(prefs.compileIntervalSeconds).toBe(5);
    expect(changes).toBe(3);
    off();
    window.dispatchEvent(new StorageEvent('storage', { key: PREFS_KEY, newValue: null }));
    expect(prefs.compileSchedule).toBe('after-changes');
    localStorage.removeItem(PREFS_KEY);
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
