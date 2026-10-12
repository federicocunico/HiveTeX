import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 11.5: every action docs/desktop-app.md documents for the page is a labelled native control (keyboard reachable
 * with Tab, operated with Space/Enter), never a clickable non-interactive element.
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const seeds = read('../src/components/BackgroundSeeds.svelte');
const lifecycle = read('../src/components/DesktopLifecycle.svelte');
const doc = read('../../../docs/desktop-app.md');

describe('desktop background controls are keyboard reachable and labelled', () => {
  it('documents only actions the page offers as labelled checkboxes or buttons', () => {
    const checkboxes = ['Enable background syncing', 'Work offline for all projects', 'Ask the router to forward a port (UPnP)',
      'Start HiveTeX when I sign in to this computer', 'Start in the background (no window)'];
    for (const text of checkboxes) {
      expect(doc).toContain(text);
      // <label><input type="checkbox" …/>Text</label>: the text is the accessible name of the checkbox.
      expect(seeds).toMatch(new RegExp(`<label><input type="checkbox"(?:(?!</label>)[\\s\\S])*?/>${text.replace(/[()]/g, '\\$&')}</label>`));
    }
    expect(doc).toContain('Quit HiveTeX');
    expect(seeds).toMatch(/<button type="button"(?:(?!<\/button>)[\s\S])*?>Quit HiveTeX<\/button>/);
    for (const text of ['Pause all synchronization', 'Quit HiveTeX', 'Quit and discard unsaved edits', 'Keep HiveTeX open']) {
      expect(lifecycle).toMatch(new RegExp(`<Button(?:(?!</Button>)[\\s\\S])*?>${text}</Button>`));
    }
  });

  it('has no click handlers on non-interactive elements', () => {
    for (const src of [seeds, lifecycle]) {
      for (const m of src.matchAll(/<(\w+)[^>]*\sonclick=/g)) expect(['button', 'Button']).toContain(m[1]);
    }
  });
});
