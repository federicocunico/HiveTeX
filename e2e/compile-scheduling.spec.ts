import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, joinProject, newUser, typeInEditor, uniq } from './helpers.js';
import type { EditorHost } from './editor-geometry.js';

test('device schedules persist, follow another tab, and build edited sources independently', async ({ browser }) => {
  const owner = await browser.newContext(), guest = await browser.newContext();
  try {
    const a = await newUser(owner, 'schedulea'), b = await newUser(guest, 'scheduleb');
    await a.page.goto('/#/account');
    await a.page.getByLabel('Compilation schedule', { exact: true }).selectOption('manual');
    await a.page.reload();
    await expect(a.page.getByLabel('Compilation schedule', { exact: true })).toHaveValue('manual');
    await a.page.goto('/#/');
    const slug = await createProject(a.page, uniq('schedule-'));
    await addFile(a.page, 'main.tex');
    await a.page.getByRole('treeitem', { name: 'main.tex' }).click();
    await typeInEditor(a.page, 'First version');
    await expect(a.page.getByTestId('compile-schedule-state')).toHaveText('Manual');
    await a.page.waitForTimeout(1800);
    await expect(a.page.getByTestId('compiled-by')).toHaveCount(0);
    await a.page.getByTestId('compile-btn').click();
    await expect(a.page.locator('[data-testid=pdf-scroll] canvas').first()).toBeVisible();
    await typeInEditor(a.page, '\nManual edit');
    await expect(a.page.getByTestId('stale-badge')).toBeVisible();
    await a.page.waitForTimeout(1800);
    await expect(a.page.getByTestId('stale-badge')).toBeVisible();
    await a.page.getByTestId('compile-btn').click();
    await expect(a.page.getByTestId('stale-badge')).toHaveCount(0);

    await joinProject(b.page, slug);
    await expect(b.page.getByTestId('compiled-by')).toContainText(b.username);
    await expect(b.page.getByTestId('compile-schedule-state')).toHaveText('After changes');
    await expect(a.page.getByTestId('compile-schedule-state')).toHaveText('Manual');

    // Opening and changing controls preserves the CodeMirror selection.
    const selected = await a.page.evaluate(() => {
      const v = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
      v.dispatch({ selection: { anchor: 0, head: 5 } });
      return v.state.sliceDoc(0, 5);
    });
    await a.page.getByRole('button', { name: 'Compile options', exact: true }).focus();
    await a.page.keyboard.press('Enter');
    const after = a.page.getByRole('menuitem', { name: /^After changes/ });
    await after.focus(); await a.page.keyboard.press('Enter');
    expect(await a.page.evaluate(() => {
      const v = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
      return v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
    })).toBe(selected);
    await typeInEditor(a.page, '\nAutomatic edit');
    await expect(a.page.getByTestId('stale-badge')).toBeVisible();
    await expect(a.page.getByTestId('stale-badge')).toHaveCount(0);

    const settings = await owner.newPage();
    await settings.goto('/#/account');
    await settings.getByLabel('Compilation schedule', { exact: true }).selectOption('periodic');
    const interval = settings.getByLabel('Compile interval (seconds)');
    await interval.fill('5'); await interval.press('Tab');
    await expect(a.page.getByTestId('compile-schedule-state')).toHaveText('Every 5 s');
    await interval.fill('1.5'); await interval.press('Tab');
    await expect(settings.getByRole('alert')).toContainText('5 to 300');
    expect(await settings.evaluate(() => JSON.parse(localStorage.getItem('hivetex.prefs')!).compileIntervalSeconds)).toBe(5);
    await typeInEditor(a.page, '\nPeriodic edit');
    await expect(a.page.getByTestId('stale-badge')).toBeVisible();
    await expect(a.page.getByTestId('stale-badge')).toHaveCount(0, { timeout: 10_000 });
    await expect(b.page.getByTestId('compile-schedule-state')).toHaveText('After changes');
    await settings.getByLabel('Compilation schedule', { exact: true }).selectOption('manual');
    await expect(a.page.getByTestId('compile-schedule-state')).toHaveText('Manual');
    await a.page.reload();
    await expect(a.page.getByTestId('compile-schedule-state')).toHaveText('Manual');
    await expect(a.page.getByTestId('compiled-by')).toHaveCount(0);
    await a.page.keyboard.press('Control+K');
    await a.page.getByRole('combobox', { name: 'Command palette' }).fill('Compilation schedule');
    await a.page.keyboard.press('Enter');
    const dialog = a.page.getByRole('dialog', { name: 'Compilation schedule', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Compilation schedule', { exact: true })).toHaveValue('manual');
    await a.page.keyboard.press('Escape');
    await a.page.getByRole('button', { name: 'Compile options', exact: true }).click();
    await a.page.getByRole('menuitem', { name: 'Schedule and interval…' }).click();
    await expect(dialog).toBeVisible();
    await a.page.keyboard.press('Escape');
  } finally { await owner.close(); await guest.close(); }
});
