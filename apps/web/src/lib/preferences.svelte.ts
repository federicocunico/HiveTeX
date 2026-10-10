import { safeStorage } from './api.js';

/**
 * Interface preferences of this device: theme, editor text size, formatting toolbar and editor keymap. Stored only
 * in localStorage (never sent to the server or to peers). public/theme-init.js reads `theme` before the first paint.
 */
export const PREFS_KEY = 'hivetex.prefs';

export type Theme = 'system' | 'light' | 'dark';
export type Keymap = 'default' | 'vim' | 'emacs';

export interface Prefs {
  theme: Theme;
  /** Editor font size in px, 11–24. */
  editorFontSize: number;
  /** Formatting toolbar above the editor. */
  toolbar: boolean;
  keymap: Keymap;
}

export const DEFAULT_PREFS: Readonly<Prefs> = { theme: 'system', editorFontSize: 14, toolbar: true, keymap: 'default' };
export const FONT_MIN = 11;
export const FONT_MAX = 24;

const THEMES: Theme[] = ['system', 'light', 'dark'];
const KEYMAPS: Keymap[] = ['default', 'vim', 'emacs'];

export function clampFont(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : DEFAULT_PREFS.editorFontSize;
  return Math.max(FONT_MIN, Math.min(FONT_MAX, v));
}

/** Reads stored preferences, ignoring anything unknown or out of range. */
export function parsePrefs(raw: string | null): Prefs {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === 'object') o = v as Record<string, unknown>;
  } catch {
    /* corrupt: defaults */
  }
  return {
    theme: THEMES.includes(o.theme as Theme) ? (o.theme as Theme) : DEFAULT_PREFS.theme,
    editorFontSize: o.editorFontSize === undefined ? DEFAULT_PREFS.editorFontSize : clampFont(o.editorFontSize),
    toolbar: typeof o.toolbar === 'boolean' ? o.toolbar : DEFAULT_PREFS.toolbar,
    keymap: KEYMAPS.includes(o.keymap as Keymap) ? (o.keymap as Keymap) : DEFAULT_PREFS.keymap,
  };
}

/** Sets or clears `data-theme` on the root element; `system` leaves the choice to `prefers-color-scheme`. */
export function applyTheme(theme: Theme, root: HTMLElement | undefined = globalThis.document?.documentElement) {
  if (!root) return;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export const prefs = $state<Prefs>(parsePrefs(safeStorage(PREFS_KEY)));

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  const next = parsePrefs(JSON.stringify({ ...prefs, [key]: value }));
  prefs[key] = next[key];
  safeStorage(PREFS_KEY, JSON.stringify(next));
  if (key === 'theme') applyTheme(next.theme);
}

if (typeof window !== 'undefined') {
  applyTheme(prefs.theme);
  // Another tab changed a preference: follow it.
  window.addEventListener('storage', (e) => {
    if (e.key !== PREFS_KEY) return;
    const next = parsePrefs(e.newValue);
    Object.assign(prefs, next);
    applyTheme(next.theme);
  });
}
