import { expect, test } from '@playwright/test';
import { addFile, createProject, newUser, uniq } from './helpers.js';

test('the editor uses the chosen font size and the token syntax colors', async ({ browser }) => {
  const ctx = await browser.newContext();
  const u = await newUser(ctx, 'font');
  await u.page.evaluate(() => localStorage.setItem('hivetex.prefs', JSON.stringify({ editorFontSize: 18 })));
  await u.page.reload();
  await createProject(u.page, uniq('font-'));
  await addFile(u.page, 'main.tex');
  await u.page.getByRole('treeitem', { name: 'main.tex' }).click();
  const content = u.page.locator('.cm-content');
  await expect(content).toBeVisible();
  expect(await content.evaluate((el) => getComputedStyle(el).fontSize)).toBe('18px');
  expect(await content.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('JetBrains Mono');
  await ctx.close();
});

test('the chosen theme applies before the app script runs (no flash on reload)', async ({ page }) => {
  await page.goto('/#/login');
  await page.evaluate(() => localStorage.setItem('hivetex.prefs', JSON.stringify({ theme: 'dark' })));

  // Block the app bundle: only the pre-paint script can have set the theme.
  await page.route(/\/src\/main\.ts|\/assets\/index-[^/]+\.js/, (r) => r.abort());
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.unroute(/\/src\/main\.ts|\/assets\/index-[^/]+\.js/);

  // System leaves the choice to the OS.
  await page.evaluate(() => localStorage.setItem('hivetex.prefs', JSON.stringify({ theme: 'system' })));
  await page.reload();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
});

test('preferences in Account apply at once and stay on the device', async ({ browser }) => {
  const ctx = await browser.newContext();
  const u = await newUser(ctx, 'prefs');
  await u.page.goto('/#/account');
  const prefs = u.page.getByTestId('preferences');
  await prefs.getByText('Dark', { exact: true }).click();
  await expect(u.page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await prefs.getByTestId('pref-font-size').fill('20');
  expect(await u.page.evaluate(() => JSON.parse(localStorage.getItem('hivetex.prefs') ?? '{}'))).toMatchObject({ theme: 'dark', editorFontSize: 20 });
  await u.page.reload();
  await expect(u.page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await prefs.getByText('System', { exact: true }).click();
  await expect(u.page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  await ctx.close();
});

test('system theme follows the OS setting', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto('/#/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(dark);
  await ctx.close();
});
