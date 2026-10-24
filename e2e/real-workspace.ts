import { expect, type BrowserContext, type Page } from '@playwright/test';
import { openNewProject, PROJECT_PW, uniq } from './helpers.js';

/** Product captures always use the real WASM compiler and a coherent package fixture. */
export async function realCompilerContext(context: BrowserContext, url: string) {
  await context.addInitScript((url) => {
    localStorage.removeItem('hivetex.fakeEngine');
    localStorage.setItem('texliveUrl', url);
    sessionStorage.removeItem('hivetex.texserver');
    localStorage.setItem('hivetex.prefs', JSON.stringify({ ...JSON.parse(localStorage.getItem('hivetex.prefs') ?? '{}'), compileSchedule: 'manual' }));
  }, url);
}

export async function articleProject(page: Page, prefix = 'research-manuscript-') {
  await openNewProject(page);
  await page.getByTestId('template-article').click();
  await page.getByPlaceholder('my-paper-2026').fill(uniq(prefix));
  await page.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await page.getByRole('treeitem', { name: 'main.tex' }).click();
  return page.getByTestId('project-slug').innerText();
}

export async function compileArticle(page: Page) {
  expect(await page.evaluate(() => localStorage.getItem('hivetex.fakeEngine'))).toBeNull();
  await page.getByTestId('compile-btn').click();
  await expect(page.getByTestId('build-status')).toContainText('PDF up to date', { timeout: 180_000 });
  await expect(page.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();
}
