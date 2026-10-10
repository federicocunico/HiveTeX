const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Elements inside `root` that take keyboard focus, in DOM order, skipping hidden ones. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    // checkVisibility is missing on older WebKit and in jsdom; treat those as visible.
    (el) => !el.closest('[hidden], [inert]') && (typeof el.checkVisibility !== 'function' || el.checkVisibility()),
  );
}

/** Keeps Tab and Shift+Tab inside `root`. Call from a keydown handler; returns true when it moved focus. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  if (e.key !== 'Tab') return false;
  const els = focusables(root);
  if (!els.length) {
    e.preventDefault();
    root.focus();
    return true;
  }
  const first = els[0] as HTMLElement;
  const last = els[els.length - 1] as HTMLElement;
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/** Focus the element marked `data-autofocus`, else the first field, else the first control, else `root`. */
export function focusInitial(root: HTMLElement) {
  const target =
    root.querySelector<HTMLElement>('[data-autofocus]') ??
    focusables(root).find((el) => el.matches('input, select, textarea')) ??
    focusables(root).find((el) => !el.matches('[data-dialog-close]')) ??
    root;
  target.focus();
}
