import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { addFile, createProject, joinProject, newUser, replaceEditorText, uniq } from './helpers.js';

type Cmd = { id: string; title: string; keys: string[]; editor: boolean; available: boolean };
const commands = (p: Page) => p.evaluate(() => (window as unknown as { __commands: () => Cmd[] }).__commands());

async function openPalette(p: Page) {
  await p.keyboard.press('Control+K');
  await expect(p.getByTestId('palette')).toBeVisible();
}

test('palette: run an action, open a file, go to a line; accessible', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page: p } = await newUser(ctx, 'pal');
  await createProject(p, uniq('pal-'));
  await addFile(p, 'main.tex');
  await addFile(p, 'appendix.tex');
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(p, 'one\ntwo\nthree\nfour\nfive');

  // Open with the shortcut, from the editor
  await openPalette(p);
  const axe = await new AxeBuilder({ page: p }).include('[data-testid=palette]').analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  await p.keyboard.type('comp');
  await expect(p.getByTestId('palette').getByRole('option').first()).toContainText('Compile now');
  await p.keyboard.press('Enter');
  await expect(p.getByTestId('palette')).toHaveCount(0);
  await expect(p.getByTestId('compiled-by')).toBeVisible({ timeout: 30_000 });

  // Open a file by part of its name
  await openPalette(p);
  await p.keyboard.type('appen');
  await expect(p.getByTestId('palette').getByRole('option', { name: /appendix\.tex/ })).toBeVisible();
  await p.keyboard.press('Enter');
  await expect(p.locator('.ed-head .path')).toHaveText('appendix.tex');

  // Go to a line in the open file
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await openPalette(p);
  await p.keyboard.type(':4');
  await expect(p.getByTestId('palette').getByRole('option')).toHaveText(['Go to line 4']);
  await p.keyboard.press('Enter');
  await expect(p.getByTestId('cursor-pos')).toContainText('Ln 4');

  // Escape closes and gives focus back
  await openPalette(p);
  await p.keyboard.press('Escape');
  await expect(p.getByTestId('palette')).toHaveCount(0);
  await ctx.close();
});

test('registry: unique ids, no colliding shortcuts, and no editing actions for viewers', async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const o = await newUser(ownerCtx, 'reg');
  const slug = uniq('reg-');
  await createProject(o.page, slug);
  await addFile(o.page, 'main.tex');
  await o.page.getByRole('treeitem', { name: 'main.tex' }).click();
  const all = await commands(o.page);
  const ids = all.map((c) => c.id);
  expect(new Set(ids).size).toBe(ids.length);
  const keys = all.filter((c) => c.available).flatMap((c) => c.keys.map((k) => `${c.editor ? 'editor:' : ''}${k}`));
  expect(new Set(keys).size, keys.join(' ')).toBe(keys.length);
  expect(all.find((c) => c.id === 'rename-file')?.available).toBe(true);

  const guestCtx = await browser.newContext();
  const g = await newUser(guestCtx, 'regv');
  await joinProject(g.page, slug);
  await expect(g.page.getByTestId('role-pill')).toHaveText('viewer');
  const forViewer = await commands(g.page);
  for (const id of ['rename-file', 'new-file', 'new-folder', 'import']) expect(forViewer.find((c) => c.id === id)?.available, id).toBe(false);
  await openPalette(g.page);
  await g.page.keyboard.type('rename');
  await expect(g.page.getByTestId('palette').getByRole('option', { name: /Rename/ })).toHaveCount(0);
  await ownerCtx.close();
  await guestCtx.close();
});

test('editor keys: Vim on request (normal mode, mode in the status bar); nothing extra loads by default', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page: p } = await newUser(ctx, 'vim');
  const keymapRequests: string[] = [];
  p.on('request', (r) => /codemirror-(vim|emacs)/.test(r.url()) && keymapRequests.push(r.url()));
  await createProject(p, uniq('vim-'));
  await addFile(p, 'main.tex');
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(p, 'alpha beta');
  expect(keymapRequests).toEqual([]);
  await expect(p.getByTestId('keymap-mode')).toHaveCount(0);

  await openPalette(p);
  await p.keyboard.type('editor keys vim');
  await p.keyboard.press('Enter');
  await expect(p.getByTestId('keymap-mode')).toHaveText('-- NORMAL --');
  expect(keymapRequests.length).toBeGreaterThan(0);
  // In normal mode, typing "x" deletes a character instead of inserting it.
  await p.locator('.cm-content').click();
  await p.keyboard.press('0');
  await p.keyboard.press('x');
  await expect(p.locator('.cm-content')).toContainText('lpha beta');
  await p.keyboard.press('i');
  await expect(p.getByTestId('keymap-mode')).toHaveText('-- INSERT --');
  await p.keyboard.press('Escape');

  await openPalette(p);
  await p.keyboard.type('editor keys default');
  await p.keyboard.press('Enter');
  await expect(p.getByTestId('keymap-mode')).toHaveCount(0);
  await ctx.close();
});

test('shortcuts: Ctrl+S and Ctrl+Enter compile without side effects; panels and PDF toggle; the reference lists them', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page: p } = await newUser(ctx, 'keys');
  await createProject(p, uniq('keys-'));
  await addFile(p, 'main.tex');
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(p, 'line one\nline two');
  const lines = () => p.locator('.cm-content .cm-line').count();
  const before = await lines();

  // Ctrl+Enter in the editor compiles and inserts no newline
  await p.locator('.cm-content').click();
  await p.keyboard.press('Control+Enter');
  await expect(p.getByTestId('compiled-by')).toBeVisible({ timeout: 30_000 });
  expect(await lines()).toBe(before);

  // Ctrl+S: no browser save (no download), a compile instead
  let downloaded = false;
  p.on('download', () => (downloaded = true));
  await p.keyboard.type(' edited');
  await p.keyboard.press('Control+S');
  await expect(p.getByTestId('stale-badge')).toBeHidden({ timeout: 30_000 });
  expect(downloaded).toBe(false);

  // Side panel and PDF
  await p.keyboard.press('Control+Shift+E');
  await expect(p.getByLabel('Side panel')).toHaveCount(0);
  await p.keyboard.press('Control+Shift+E');
  await expect(p.getByTestId('file-tree')).toBeVisible();
  await p.keyboard.press('Control+Alt+P');
  await expect(p.getByTestId('pdf-pane')).toHaveCount(0);
  await p.keyboard.press('Control+Alt+P');
  await expect(p.getByTestId('pdf-pane')).toBeVisible();

  // Ctrl+/ stays a comment toggle in the editor
  await p.locator('.cm-content').click();
  await p.keyboard.press('Control+/');
  await expect(p.locator('.cm-content')).toContainText('%');
  await expect(p.getByTestId('shortcuts-dialog')).toHaveCount(0);

  // Ctrl+Shift+/ opens the reference
  await p.keyboard.press('Control+Shift+Slash');
  const ref = p.getByTestId('shortcuts-dialog');
  await expect(ref).toBeVisible();
  for (const title of ['Compile now', 'Show or hide the PDF', 'Focus mode', 'Search in project', 'Keyboard shortcuts', 'Toggle comment']) await expect(ref).toContainText(title);
  await p.keyboard.press('Escape');
  await expect(ref).toHaveCount(0);
  await ctx.close();
});
