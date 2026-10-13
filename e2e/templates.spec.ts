import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { PROJECT_PW, newUser, openNewProject, uniq } from './helpers.js';

test('a project created from the Article template has its files, its main file set, and compiles', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'tpl');
  await openNewProject(page);
  // Blank is preselected; the gallery lists every template.
  await expect(page.getByRole('radio', { name: /Blank/ })).toBeChecked();
  await expect(page.getByRole('group', { name: 'Start from' }).getByRole('radio')).toHaveCount(6);
  await page.getByTestId('template-article').click();
  await expect(page.getByRole('radio', { name: /Article/ })).toBeChecked();
  await page.getByPlaceholder('my-paper-2026').fill(uniq('tpl-'));
  await page.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();

  await expect(page.getByRole('treeitem', { name: /main\.tex/ })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /refs\.bib/ })).toBeVisible();
  // main.tex opens first and is the root document
  await expect(page.locator('.cm-content')).toContainText('\\documentclass[11pt]{article}');
  expect(await page.evaluate(() => (window as unknown as { __p2p: { session: { model: { settings: Map<string, unknown> } } } }).__p2p.session.model.settings.get('main'))).toBe('main.tex');
  await page.getByRole('button', { name: 'Recompile' }).click();
  await expect(page.getByTestId('compiled-by')).toBeVisible();
  await ctx.close();
});

test('Blank creates an empty project, as before', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'blank');
  await openNewProject(page);
  await page.getByPlaceholder('my-paper-2026').fill(uniq('blank-'));
  await page.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByRole('treeitem')).toHaveCount(0);
  await ctx.close();
});

test('the thesis template creates its chapters folder', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'thesis');
  await openNewProject(page);
  await page.getByTestId('template-report').click();
  await page.getByPlaceholder('my-paper-2026').fill(uniq('th-'));
  await page.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('treeitem', { name: /chapters/ })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /introduction\.tex/ })).toBeVisible();
  await ctx.close();
});
