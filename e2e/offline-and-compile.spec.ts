import { expect, test } from '@playwright/test';
import { PROJECT_PW, addFile, createProject, joinProject, newUser, typeInEditor, uniq } from './helpers.js';

test('offline edits on both sides merge automatically after reconnecting (6.8)', async ({ browser }) => {
  const slug = uniq('offline-');
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await newUser(aCtx, 'ann');
  const b = await newUser(bCtx, 'ben');

  // owner creates the project and makes new members editors by default
  await createProject(a.page, slug);
  await a.page.getByTestId('settings-btn').click();
  await a.page.getByLabel('Default role').selectOption('editor');
  await a.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  // wait for the server to confirm before anyone joins (the join reads the default role)
  await expect(a.page.getByTestId('settings-dialog').getByText('Saved', { exact: true })).toBeVisible();
  await a.page.getByRole('button', { name: 'Close' }).click();
  await addFile(a.page, 'main.tex');
  await a.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(a.page, 'Line one.\n\nLine three.');

  await b.page.goto('/#/');
  await joinProject(b.page, slug, PROJECT_PW);
  await expect(b.page.getByTestId('role-pill')).toHaveText('editor');
  await b.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(b.page.locator('.cm-content')).toContainText('Line three.');

  // both go offline and edit different places
  await a.page.getByTestId('pause-sync').click();
  await b.page.getByTestId('pause-sync').click();
  await expect(a.page.getByTestId('peer-count')).toContainText('0 peers');
  await expect(b.page.getByTestId('peer-count')).toContainText('0 peers');

  await a.page.locator('.cm-content').click();
  await a.page.keyboard.press('Control+Home');
  await a.page.keyboard.type('ANN-OFFLINE ');
  await b.page.locator('.cm-content').click();
  await b.page.keyboard.press('Control+End');
  await b.page.keyboard.type(' BEN-OFFLINE');
  await expect(a.page.locator('.cm-content')).not.toContainText('BEN-OFFLINE');

  // reload ann's tab to prove the offline edit was persisted locally before reconnecting
  await a.page.waitForTimeout(600);
  await a.page.reload();
  await a.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(a.page.locator('.cm-content')).toContainText('ANN-OFFLINE');
  await a.page.getByTestId('pause-sync').click(); // after reload we are online again; pause then resume below
  await a.page.getByTestId('pause-sync').click();

  await b.page.getByTestId('pause-sync').click();
  for (const p of [a.page, b.page]) {
    await expect(p.locator('.cm-content')).toContainText('ANN-OFFLINE', { timeout: 30_000 });
    await expect(p.locator('.cm-content')).toContainText('BEN-OFFLINE', { timeout: 30_000 });
  }
  const lines = (p: typeof a.page) => p.evaluate(() => [...document.querySelectorAll('.cm-line')].map((l) => (l.firstChild ? [...l.childNodes].filter((n) => n.nodeType === 3 || !(n as HTMLElement).className?.toString().includes('cm-ySelection')).map((n) => n.textContent).join('') : '')));
  const ta = await lines(a.page);
  const tb = await lines(b.page);
  expect(ta).toEqual(tb);
  // no duplicated files
  await expect(a.page.getByRole('treeitem', { name: /main/ })).toHaveCount(1);

  await aCtx.close();
  await bCtx.close();
});

test('compiles in the browser and shows the PDF with an up-to-date indicator (7.4, 8.5)', async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext();
  const u = await newUser(ctx, 'tex');
  await createProject(u.page, uniq('compile-'));
  await addFile(u.page, 'main.tex');
  await u.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(u.page, '\\documentclass{article}\n\\begin{document}\nHello from p2platex.\n\\end{document}\n');

  await expect(u.page.getByTestId('statusbar')).toContainText('in-browser TeX');
  await expect(u.page.getByTestId('leader')).toContainText('this device');
  // compile happens automatically after typing pauses; wait for the preview
  await expect(u.page.locator('[data-testid=pdf-scroll] canvas').first()).toBeVisible({ timeout: 200_000 });
  await expect(u.page.getByTestId('compiled-by')).toContainText(u.username);
  await expect(u.page.getByTestId('stale-badge')).toBeHidden();

  // editing makes the PDF outdated until the next build lands
  await typeInEditor(u.page, '% a comment');
  await expect(u.page.getByTestId('stale-badge')).toBeVisible();
  await expect(u.page.getByTestId('stale-badge')).toBeHidden({ timeout: 200_000 });
  await ctx.close();
});
