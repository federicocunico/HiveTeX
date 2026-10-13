import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, newUser, replaceEditorText, uniq } from './helpers.js';

test('compiler state: shown in the status bar, missing packages explained, Account > Compiler on the web (5.2)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const u = await newUser(ctx, 'cstate');
  const page = u.page;
  await createProject(page, uniq('cstate-'));
  await addFile(page, 'main.tex');
  await page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(page.getByTestId('compiler-state')).toContainText('in-browser compiler');

  await replaceEditorText(page, '\\documentclass{article}\n\\usepackage{nosuchpkg}\n\\begin{document}\nx\n\\end{document}\n');
  await expect(page.getByTestId('missing-package')).toContainText('could not load "nosuchpkg"');
  await expect(page.getByTestId('missing-package')).toContainText('desktop app');

  await page.goto('/#/account');
  await expect(page.getByTestId('compiler-panel')).toBeVisible();
  await expect(page.getByTestId('pair-desktop')).toBeVisible();
  await ctx.close();
});

test('compiler state: "no compiler here" when the browser cannot compile and nothing else can', async ({ browser }) => {
  const ctx = await browser.newContext();
  const u = await newUser(ctx, 'cnone');
  const page = u.page;
  // after newUser's init script: no stand-in engine, and an unreachable TeX file server
  await page.addInitScript(() => {
    localStorage.removeItem('hivetex.fakeEngine');
    localStorage.setItem('texliveUrl', 'http://127.0.0.1:9/');
  });
  await page.reload();
  await createProject(page, uniq('cnone-'));
  await expect(page.getByTestId('compiler-state')).toContainText('no compiler here');
  await expect(page.getByText('In-browser compilation needs a TeX package server')).toBeVisible();
  await ctx.close();
});
