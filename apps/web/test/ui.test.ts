// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import IconButton from '../src/ui/IconButton.svelte';
import { Settings } from '../src/ui/icons.js';
import { keyLabel, matchesKey } from '../src/ui/keys.js';
import DialogHarness from './fixtures/DialogHarness.svelte';
import DialogStackHarness from './fixtures/DialogStackHarness.svelte';
import SplitterHarness from './fixtures/SplitterHarness.svelte';

const flush = async () => {
  await tick();
  await new Promise((r) => setTimeout(r, 0));
};

describe('Dialog', () => {
  it('moves focus in, traps Tab, closes on Escape and returns focus to the opener', async () => {
    render(DialogHarness);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    await fireEvent.click(opener);
    await flush();

    const dialog = screen.getByRole('dialog', { name: 'Share project' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const field = screen.getByLabelText('First');
    expect(document.activeElement).toBe(field);

    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last.
    const done = screen.getByRole('button', { name: 'Done' });
    done.focus();
    await fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(done);
    const first = document.activeElement as HTMLElement;
    await fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(done);
    expect(first).toBeTruthy();

    await fireEvent.keyDown(dialog, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on Escape even when focus fell to the page (a focused button became disabled during an action)', async () => {
    render(DialogHarness);
    await fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await flush();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('with dialogs stacked, Escape closes the topmost one only, once', async () => {
    const closes: string[] = [];
    render(DialogStackHarness, { props: { closes } });
    await flush();
    // focus inside the top dialog: its own handler closes it, the page-level fallback does not close another
    const yes = screen.getByRole('button', { name: 'Yes' });
    yes.focus();
    await fireEvent.keyDown(yes, { key: 'Escape' });
    await flush();
    expect(closes).toEqual(['inner']);
    // focus lost to the page: the remaining (now topmost) dialog closes
    (document.activeElement as HTMLElement | null)?.blur();
    await fireEvent.keyDown(document.body, { key: 'Escape' });
    await flush();
    expect(closes).toEqual(['inner', 'outer']);
  });
});

describe('Splitter', () => {
  it('moves by a fixed step with the arrow keys and reports its position', async () => {
    render(SplitterHarness);
    const sep = screen.getByRole('separator', { name: 'Resize editor and PDF' });
    expect(sep.getAttribute('aria-valuenow')).toBe('300');
    expect(sep.getAttribute('tabindex')).toBe('0');
    await fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(sep.getAttribute('aria-valuenow')).toBe('276');
    await fireEvent.keyDown(sep, { key: 'ArrowRight' });
    await fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(sep.getAttribute('aria-valuenow')).toBe('324');
    await fireEvent.keyDown(sep, { key: 'Home' });
    expect(sep.getAttribute('aria-valuenow')).toBe('200');
    await fireEvent.keyDown(sep, { key: 'End' });
    expect(sep.getAttribute('aria-valuenow')).toBe('600');
  });
});

describe('IconButton', () => {
  it('exposes its label as the accessible name and tooltip', () => {
    render(IconButton, { icon: Settings, label: 'Project settings' });
    const b = screen.getByRole('button', { name: 'Project settings' });
    expect(b.dataset.tip).toBe('Project settings');
    expect(b.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('keys', () => {
  it('formats combos per platform', () => {
    expect(keyLabel('Mod+Shift+Enter', false)).toBe('Ctrl+Shift+Enter');
    expect(keyLabel('Mod+K', true)).toBe('⌘K');
  });

  it('matches events, including Alt-shifted letters by physical key', () => {
    const ev = (o: Partial<KeyboardEventInit>) => new KeyboardEvent('keydown', o);
    expect(matchesKey(ev({ key: 'k', ctrlKey: true }), 'Mod+K', false)).toBe(true);
    expect(matchesKey(ev({ key: 'k', metaKey: true }), 'Mod+K', true)).toBe(true);
    expect(matchesKey(ev({ key: 'k', ctrlKey: true, shiftKey: true }), 'Mod+K', false)).toBe(false);
    expect(matchesKey(ev({ key: 'π', code: 'KeyP', metaKey: true, altKey: true }), 'Mod+Alt+P', true)).toBe(true);
    expect(matchesKey(ev({ key: 'Enter', ctrlKey: true }), 'Mod+Enter', false)).toBe(true);
  });
});
