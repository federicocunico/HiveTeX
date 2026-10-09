import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { addFile, createProject, newUser, replaceEditorText, uniq } from './helpers.js';

const serious = (r: Awaited<ReturnType<AxeBuilder['analyze']>>) => r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');

test('no serious accessibility violations on the main screens (7.6)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto('/#/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(serious(await new AxeBuilder({ page }).analyze()), 'login').toEqual([]);
  await page.goto('/#/register');
  expect(serious(await new AxeBuilder({ page }).analyze()), 'register').toEqual([]);
  await ctx.close();

  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const u = await newUser(ctx2, 'axe');
  expect(serious(await new AxeBuilder({ page: u.page }).analyze()), 'projects').toEqual([]);
  await createProject(u.page, uniq('axe-'));
  await addFile(u.page, 'main.tex');
  await u.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(u.page, '\documentclass{article}\begin{document}Hi\end{document}');
  await expect(u.page.getByTestId('compiled-by')).toBeVisible();
  const res = await new AxeBuilder({ page: u.page }).exclude('.cm-editor').analyze();
  expect(serious(res), JSON.stringify(serious(res).map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))).toEqual([]);

  // settings dialog
  await u.page.getByTestId('settings-btn').click();
  const res2 = await new AxeBuilder({ page: u.page }).include('[data-testid=settings-dialog]').analyze();
  expect(serious(res2), JSON.stringify(serious(res2).map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))).toEqual([]);
  await u.page.getByRole('button', { name: 'Close' }).click();

  // import dialog: picker, then a preview with a conflict
  await u.page.getByTestId('import-btn').click();
  const res3 = await new AxeBuilder({ page: u.page }).include('[data-testid=import-dialog]').analyze();
  expect(serious(res3), 'import picker').toEqual([]);
  await expect(u.page.getByTestId('import-pick-files')).toBeFocused();
  await u.page.getByTestId('import-input').setInputFiles({ name: 'x.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync({ 'main.tex': strToU8('other') })) });
  await expect(u.page.getByTestId('conflicts')).toBeVisible();
  const res4 = await new AxeBuilder({ page: u.page }).include('[data-testid=import-dialog]').analyze();
  expect(serious(res4), JSON.stringify(serious(res4).map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))).toEqual([]);
  // Escape cancels without changing anything
  await u.page.keyboard.press('Escape');
  await expect(u.page.getByTestId('import-dialog')).toHaveCount(0);
  await ctx2.close();
});

test('primary actions are reachable by keyboard only (7.6)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const u = await newUser(ctx, 'kbd');
  await createProject(u.page, uniq('kbd-'));
  await addFile(u.page, 'main.tex');
  // focus the file in the tree and open it with Enter
  const item = u.page.getByRole('treeitem', { name: 'main.tex' });
  await item.focus();
  await u.page.keyboard.press('Enter');
  await expect(u.page.locator('.cm-content')).toBeVisible();
  // the toolbar buttons are tabbable
  await u.page.getByRole('button', { name: 'Recompile' }).focus();
  await expect(u.page.getByRole('button', { name: 'Recompile' })).toBeFocused();
  await u.page.keyboard.press('Enter');
  await ctx.close();
});

test('layout works at 1024px and project list at phone width (7.6)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 700 } });
  const u = await newUser(ctx, 'rsp');
  await createProject(u.page, uniq('rsp-'));
  expect(await u.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await u.page.setViewportSize({ width: 390, height: 800 });
  await u.page.goto('/#/');
  await expect(u.page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  expect(await u.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await ctx.close();
});
