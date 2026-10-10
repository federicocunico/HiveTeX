// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { availableCommands, commandForKey, editorCommandForKey, registerCommands, runCommand } from '../src/lib/commands.svelte.js';

const key = (o: Partial<KeyboardEventInit>) => new KeyboardEvent('keydown', o);

describe('command registry', () => {
  it('registers, overrides by id, and unregisters', () => {
    let ran = '';
    const offA = registerCommands([{ id: 't-a', title: 'A', group: 'View', run: () => (ran = 'a') }]);
    const offB = registerCommands([{ id: 't-a', title: 'A2', group: 'View', run: () => (ran = 'b') }]);
    expect(availableCommands().filter((c) => c.id === 't-a')).toHaveLength(1);
    expect(runCommand('t-a')).toBe(true);
    expect(ran).toBe('b');
    offB();
    offA();
    expect(availableCommands().some((c) => c.id === 't-a')).toBe(false);
    expect(runCommand('t-a')).toBe(false);
  });

  it('hides commands whose condition is false (e.g. editing for viewers)', () => {
    let canWrite = false;
    const off = registerCommands([{ id: 't-rename', title: 'Rename', group: 'Files', when: () => canWrite, run: () => {} }]);
    expect(availableCommands().some((c) => c.id === 't-rename')).toBe(false);
    expect(runCommand('t-rename')).toBe(false);
    canWrite = true;
    expect(availableCommands().some((c) => c.id === 't-rename')).toBe(true);
    off();
  });

  it('finds page-wide commands by key, and leaves editor-only ones to the editor', () => {
    const off = registerCommands([
      { id: 't-compile', title: 'Compile', group: 'Compile', keys: ['Mod+Enter', 'Mod+S'], run: () => {} },
      { id: 't-sync', title: 'Forward search', group: 'Navigate', keys: ['Mod+Alt+J'], editor: true, run: () => {} },
    ]);
    const ctrlS = key({ key: 's', code: 'KeyS', ctrlKey: true });
    const ctrlAltJ = key({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true });
    expect(commandForKey(ctrlS)?.id).toBe('t-compile');
    expect(commandForKey(ctrlAltJ)).toBeUndefined();
    expect(editorCommandForKey(ctrlAltJ)?.id).toBe('t-sync');
    expect(editorCommandForKey(key({ key: 'Enter', ctrlKey: true }))?.id).toBe('t-compile');
    // Plain typing is never a command.
    expect(editorCommandForKey(key({ key: 's' }))).toBeUndefined();
    off();
  });
});
