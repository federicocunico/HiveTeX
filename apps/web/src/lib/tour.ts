import { safeStorage } from './api.js';

/** The first-run workspace tour, shown once per device; replayable from Help. */
export const TOUR_KEY = 'hivetex.tour';

export interface TourStep {
  /** CSS selector of the element the step points at; missing targets are skipped. */
  target: string;
  title: string;
  text: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    target: '.editor-area',
    title: 'Write here',
    text: 'This is the LaTeX source. The toolbar above inserts headings, lists, math, figures and citations for you, so you do not need to remember the commands.',
  },
  {
    target: 'nav[aria-label="Panels"]',
    title: 'Everything else is in this rail',
    text: 'Files, the document outline, search, recent changes, history, the people in this project and your GitHub backup. Click an icon to open its panel, and again to hide it.',
  },
  {
    target: '[data-testid="compile-btn"]',
    title: 'Compile to see the PDF',
    text: 'Recompile (or Ctrl+Enter) builds the PDF on this device. Problems show under the editor in plain words.',
  },
  {
    target: '[data-testid="share-btn"]',
    title: 'Invite your co-authors',
    text: 'Share gives you an invitation with the project ID. Send the password separately. Everyone edits the same document live, even offline.',
  },
];

/** Whether to start the tour automatically on this device. Test runs opt in explicitly with "new". */
export function tourWanted(): boolean {
  const v = safeStorage(TOUR_KEY);
  if (v === 'done') return false;
  if (safeStorage('hivetex.test') === '1') return v === 'new';
  return true;
}

export function markTourDone() {
  safeStorage(TOUR_KEY, 'done');
}
