/** True on macOS and iOS, where Mod means Cmd. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

const MAC: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩' };
const PC: Record<string, string> = { Mod: 'Ctrl' };

/** "Mod+Shift+Enter" → ["Ctrl", "Shift", "Enter"] (or ["⌘", "⇧", "↩"] on a Mac). */
export function keyParts(combo: string, mac = isMac): string[] {
  return combo.split('+').map((k) => (mac ? MAC[k] : PC[k]) ?? (k.length === 1 ? k.toUpperCase() : k));
}

/** Readable text for a combo, e.g. "Ctrl+Shift+Enter". */
export function keyLabel(combo: string, mac = isMac): string {
  return keyParts(combo, mac).join(mac ? '' : '+');
}

/** Whether a keyboard event matches a combo such as "Mod+Shift+P" or "Mod+/". */
export function matchesKey(e: KeyboardEvent, combo: string, mac = isMac): boolean {
  const parts = combo.split('+');
  const key = parts[parts.length - 1] ?? '';
  const want = new Set(parts.slice(0, -1));
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (want.has('Mod') !== mod) return false;
  if (want.has('Shift') !== e.shiftKey) return false;
  if (want.has('Alt') !== e.altKey) return false;
  // With Mod on a PC, Ctrl is already the modifier; on a Mac a stray Ctrl must not match.
  if (mac && want.has('Ctrl') !== e.ctrlKey) return false;
  if (!mac && !want.has('Mod') && want.has('Ctrl') !== e.ctrlKey) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const target = key.length === 1 ? key.toLowerCase() : key;
  if (k === target) return true;
  // Shifted or Alt-modified keys change e.key (e.g. Alt+P is "π" on a Mac); fall back to the physical key.
  if (target.length === 1 && /[a-z]/.test(target)) return e.code === `Key${target.toUpperCase()}`;
  if (target === '/') return e.code === 'Slash';
  return false;
}
