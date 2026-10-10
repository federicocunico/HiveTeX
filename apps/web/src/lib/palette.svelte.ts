/** Whether the command palette or the shortcut reference is open, and the text the palette opens with. */
export const palette = $state({ open: false, initial: '', shortcuts: false });

export function openPalette(initial = '') {
  palette.shortcuts = false;
  palette.initial = initial;
  palette.open = true;
}

export function closePalette() {
  palette.open = false;
}

export function openShortcuts() {
  palette.open = false;
  palette.shortcuts = true;
}

export function closeShortcuts() {
  palette.shortcuts = false;
}
