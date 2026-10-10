import { safeStorage } from './api.js';

/**
 * Workspace layout of this device: which side panel is open, pane sizes, PDF visibility and zoom, focus mode.
 * Remembered across projects and restarts; never shared.
 */
export const LAYOUT_KEY = 'hivetex.layout';

export const PANELS = ['files', 'outline', 'search', 'changes', 'history', 'people', 'sync', 'backup'] as const;
export type Panel = (typeof PANELS)[number];

export interface Layout {
  /** Open side panel, or null when collapsed. */
  panel: Panel | null;
  /** Side panel width in px. */
  sideWidth: number;
  /** Editor share of the editor+PDF area, 0.2–0.8. */
  split: number;
  pdf: boolean;
  /** PDF zoom factor, 0.5–3. */
  zoom: number;
  focus: boolean;
  /** Problems list under the editor expanded. */
  problems: boolean;
}

export const DEFAULT_LAYOUT: Readonly<Layout> = {
  panel: 'files',
  sideWidth: 260,
  split: 0.5,
  pdf: true,
  zoom: 1.2,
  focus: false,
  problems: true,
};

export const SIDE_MIN = 180;
export const SIDE_MAX = 480;
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

export function parseLayout(raw: string | null): Layout {
  let o: Record<string, unknown> = {};
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (v && typeof v === 'object') o = v as Record<string, unknown>;
  } catch {
    /* corrupt: defaults */
  }
  const d = DEFAULT_LAYOUT;
  return {
    panel: o.panel === null ? null : PANELS.includes(o.panel as Panel) ? (o.panel as Panel) : d.panel,
    sideWidth: Math.round(clamp(o.sideWidth, SIDE_MIN, SIDE_MAX, d.sideWidth)),
    split: clamp(o.split, SPLIT_MIN, SPLIT_MAX, d.split),
    pdf: typeof o.pdf === 'boolean' ? o.pdf : d.pdf,
    zoom: clamp(o.zoom, 0.5, 3, d.zoom),
    // Focus mode is a moment, not a home: a new session starts without it.
    focus: false,
    problems: typeof o.problems === 'boolean' ? o.problems : d.problems,
  };
}

export const layout = $state<Layout>(parseLayout(safeStorage(LAYOUT_KEY)));

function save() {
  safeStorage(LAYOUT_KEY, JSON.stringify(layout));
}

export function setLayout(patch: Partial<Layout>) {
  const next = parseLayout(JSON.stringify({ ...layout, ...patch }));
  // focus is not restored from storage, but must apply now
  Object.assign(layout, next, 'focus' in patch ? { focus: !!patch.focus } : { focus: layout.focus });
  save();
}

/** Opens `panel`, or collapses the side panel when it is already the open one. */
export function togglePanel(panel: Panel) {
  setLayout({ panel: layout.panel === panel ? null : panel });
}

export function resetLayout() {
  Object.assign(layout, DEFAULT_LAYOUT);
  save();
}
