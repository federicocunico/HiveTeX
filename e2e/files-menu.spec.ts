import { expect, test } from '@playwright/test';
import { addFile, createProject, joinProject, newUser, uniq } from './helpers.js';

test('Files context menu: rename through the menu, keyboard access, and the web folder action', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page: p } = await newUser(ctx, 'fm');
  await createProject(p, uniq('fm-'));
  await addFile(p, 'intro.tex');
  const row = p.getByRole('treeitem', { name: 'intro.tex' });

  // right-click a .tex file: file actions, then (web) "Use a folder…"
  await row.click({ button: 'right' });
  const menu = p.getByTestId('files-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Open', 'Set as main document', 'Rename or move', 'Delete', 'Download', 'Use a folder…']);
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Rename or move' }).click();
  const input = p.getByRole('textbox', { name: 'New path for intro.tex' });
  await input.fill('sections/intro.tex');
  await input.press('Enter');
  await expect(p.getByRole('treeitem', { name: 'sections' })).toBeVisible();
  await expect(p.getByRole('treeitem', { name: 'intro.tex' })).toBeVisible();

  // keyboard: Shift+F10 on a focused row opens the menu on its first item; Escape returns focus to the row
  const moved = p.getByRole('treeitem', { name: 'intro.tex' });
  await moved.focus();
  await p.keyboard.press('Shift+F10');
  await expect(menu.getByRole('menuitem', { name: 'Open' })).toBeFocused();
  await p.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Set as main document' })).toBeFocused();
  await p.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(moved).toBeFocused();

  // Delete from the menu asks for confirmation on the row
  await moved.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(p.getByTestId('confirm-delete')).toBeFocused();
  await p.getByTestId('confirm-delete').click();
  await expect(p.getByRole('treeitem', { name: 'intro.tex' })).toHaveCount(0);

  // the empty area: create actions
  await p.getByTestId('file-tree').click({ button: 'right', position: { x: 60, y: 160 } });
  await expect(menu.getByRole('menuitem')).toHaveText(['New file', 'New folder', 'Upload files', 'Use a folder…']);
  await p.keyboard.press('Escape');
  await ctx.close();
});

test('Files context menu for a viewer offers only what does not change the project', async ({ browser }) => {
  const [oc, vc] = [await browser.newContext(), await browser.newContext()];
  const { page: o } = await newUser(oc, 'fmo');
  const { page: v } = await newUser(vc, 'fmv');
  let slug = uniq('fmv-');
  slug = await createProject(o, slug);
  await addFile(o, 'main.tex');
  await v.goto('/#/');
  await joinProject(v, slug);
  const row = v.getByRole('treeitem', { name: 'main.tex' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click({ button: 'right' });
  await expect(v.getByTestId('files-menu').getByRole('menuitem')).toHaveText(['Open', 'Download', 'Use a folder…']);
  await oc.close();
  await vc.close();
});
