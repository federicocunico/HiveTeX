/**
 * One floating tooltip for every element with `data-tip`. It shows on hover and on keyboard focus, and lives on
 * <body> so overflow-hidden panels never clip it. It is visual only: the element's accessible name comes from its
 * label or aria-label, so the tooltip is aria-hidden to avoid announcing it twice.
 * `data-tip-side="right"` places it to the right (rail buttons); the default is below.
 */
let tip: HTMLDivElement | null = null;
let current: HTMLElement | null = null;
let showTimer = 0;

function ensure(): HTMLDivElement {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'hx-tooltip';
  tip.setAttribute('aria-hidden', 'true');
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}

function place(el: HTMLElement) {
  const t = ensure();
  const text = el.dataset.tip;
  if (!text) return;
  t.textContent = text;
  t.hidden = false;
  const r = el.getBoundingClientRect();
  const tr = t.getBoundingClientRect();
  const side = el.dataset.tipSide ?? 'bottom';
  let x: number;
  let y: number;
  if (side === 'right') {
    x = r.right + 8;
    y = r.top + r.height / 2 - tr.height / 2;
  } else if (side === 'top') {
    x = r.left + r.width / 2 - tr.width / 2;
    y = r.top - tr.height - 6;
  } else {
    x = r.left + r.width / 2 - tr.width / 2;
    y = r.bottom + 6;
  }
  x = Math.max(4, Math.min(x, window.innerWidth - tr.width - 4));
  y = Math.max(4, Math.min(y, window.innerHeight - tr.height - 4));
  t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function show(el: HTMLElement, delay: number) {
  current = el;
  clearTimeout(showTimer);
  showTimer = window.setTimeout(() => current === el && el.isConnected && place(el), delay);
}

function hide() {
  current = null;
  clearTimeout(showTimer);
  if (tip) tip.hidden = true;
}

export function installTooltips() {
  if (typeof document === 'undefined' || tip) return;
  ensure();
  document.addEventListener('pointerover', (e) => {
    const el = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null;
    if (el && el !== current) show(el, 350);
    else if (!el && current) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null;
    // Only for keyboard focus: a click focuses too, and the pointer handler already covers it.
    if (el?.matches(':focus-visible')) show(el, 0);
    else hide();
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  window.addEventListener('scroll', hide, true);
}
