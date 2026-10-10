// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, LAYOUT_KEY, layout, parseLayout, resetLayout, setLayout, togglePanel } from '../src/lib/layout.svelte.js';

describe('workspace layout', () => {
  beforeEach(() => {
    localStorage.clear();
    resetLayout();
  });

  it('parses stored values, clamping sizes and ignoring unknown panels', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{oops')).toEqual(DEFAULT_LAYOUT);
    const l = parseLayout(JSON.stringify({ panel: 'nope', sideWidth: 9999, split: 0.05, zoom: 7, pdf: false, focus: true }));
    expect(l.panel).toBe('files');
    expect(l.sideWidth).toBe(480);
    expect(l.split).toBe(0.2);
    expect(l.zoom).toBe(3);
    expect(l.pdf).toBe(false);
    expect(l.focus).toBe(false); // focus mode is never restored
    expect(parseLayout(JSON.stringify({ panel: null })).panel).toBeNull();
  });

  it('persists changes for the next project', () => {
    setLayout({ split: 0.35, sideWidth: 300, panel: 'changes' });
    const stored = parseLayout(localStorage.getItem(LAYOUT_KEY));
    expect(stored).toMatchObject({ split: 0.35, sideWidth: 300, panel: 'changes' });
  });

  it('toggles a panel closed when it is already open', () => {
    togglePanel('history');
    expect(layout.panel).toBe('history');
    togglePanel('history');
    expect(layout.panel).toBeNull();
    togglePanel('files');
    expect(layout.panel).toBe('files');
  });

  it('keeps focus mode for the session but resets everything with reset', () => {
    setLayout({ focus: true, pdf: false });
    expect(layout.focus).toBe(true);
    setLayout({ zoom: 1.5 });
    expect(layout.focus).toBe(true);
    resetLayout();
    expect({ ...layout }).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(localStorage.getItem(LAYOUT_KEY))).toEqual(DEFAULT_LAYOUT);
  });
});
