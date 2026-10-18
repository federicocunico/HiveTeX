import { type Page, expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, editorText, joinProject, newUser, typeInEditor, uniq } from './helpers.js';


test('three clients: concurrent edits, independent local builds, read-only viewer and member removal (11.1, web part)', async ({ browser }) => {
  test.setTimeout(240_000);
  let slug = uniq('flow-');
  const [ctxO, ctxE, ctxV] = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const O = await newUser(ctxO, 'olga');
  const E = await newUser(ctxE, 'edie');
  const V = await newUser(ctxV, 'vera');

  // owner creates the project; newcomers start as editors, then the owner demotes vera
  slug = await createProject(O.page, slug);
  await O.page.getByTestId('settings-btn').click();
  await O.page.getByLabel('Default role').selectOption('editor');
  await O.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(O.page.getByText('Saved', { exact: true })).toBeVisible();
  await O.page.getByRole('button', { name: 'Close' }).click();
  await addFile(O.page, 'main.tex');
  await O.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(O.page, '\nowner line');

  for (const u of [E, V]) {
    await u.page.goto('/#/');
    await joinProject(u.page, slug);
    await u.page.getByRole('treeitem', { name: 'main.tex' }).click();
    await expect(u.page.locator('.cm-content')).toContainText('owner line');
  }
  await O.page.getByTestId('settings-btn').click();
  await O.page.locator('[data-testid=members-table] li', { hasText: V.username }).getByLabel(`Role of ${V.username}`).selectOption('viewer');
  await expect(O.page.getByText(`${V.username} is now viewer`)).toBeVisible();
  await O.page.getByRole('button', { name: 'Close' }).click();

  // everyone sees two peers
  for (const u of [O, E, V]) await expect(u.page.getByTestId('peer-count')).toContainText('2 co-authors', { timeout: 30_000 });

  // concurrent edits from owner and editor converge
  const typeAt = async (p: Page, where: 'Control+Home' | 'Control+End', text: string) => {
    await p.locator('.cm-content').click();
    await p.keyboard.press(where);
    await p.keyboard.type(text);
  };
  await Promise.all([typeAt(O.page, 'Control+Home', 'A-from-owner '), typeAt(E.page, 'Control+End', ' B-from-editor')]);
  for (const u of [O, E, V]) {
    await expect(u.page.locator('.cm-content')).toContainText('A-from-owner', { timeout: 20_000 });
    await expect(u.page.locator('.cm-content')).toContainText('B-from-editor', { timeout: 20_000 });
  }

  // viewer is read-only: typing is rejected locally and nothing leaks to the others
  await expect(V.page.getByTestId('role-pill')).toHaveText('viewer', { timeout: 30_000 });
  await V.page.locator('.cm-content').click();
  await V.page.keyboard.type('VIEWER-HACK');
  await expect(V.page.locator('.cm-content')).not.toContainText('VIEWER-HACK');
  await expect(O.page.locator('.cm-content')).not.toContainText('VIEWER-HACK');

  // Every member, including the viewer, builds and displays only their own local result.
  for (const u of [O, E, V]) {
    await expect(u.page.getByTestId('compile-location')).toContainText('this device');
    await expect(u.page.getByTestId('compiled-by')).toContainText(u.username, { timeout: 30_000 });
  }
  await O.page.close();
  const otherPage = E.page;
  await typeInEditor(otherPage, ' after-owner-closed');
  await expect(otherPage.getByTestId('compiled-by')).toContainText(E.username, { timeout: 30_000 });
  await expect(V.page.locator('.cm-content')).toContainText('after-owner-closed');
  await expect(V.page.getByTestId('compiled-by')).toContainText(V.username, { timeout: 30_000 });

  // owner removes the editor; within the grace period the removed member is cut off. The owner tab was closed:
  // reopen it on the same device (this also covers a quick re-join of the same device).
  const reopen = async (ctx: typeof ctxO) => {
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('hivetex.test', '1');
      localStorage.setItem('hivetex.fakeEngine', '1');
      localStorage.setItem('hivetex.epochGraceMs', '4000');
    });
    await page.goto('/#/');
    await page.getByRole('link', { name: new RegExp(slug) }).click();
    await expect(page.getByTestId('workspace')).toBeVisible();
    return page;
  };
  const ownerPage = await reopen(ctxO);
  const removed = otherPage;
  const removedName = E.username;
  // the (re-opened) owner page must be linked to both members before the removal, so it can announce the new epoch
  await expect(ownerPage.getByTestId('peer-count')).toContainText('2 co-authors', { timeout: 60_000 });
  await expect(removed.getByTestId('peer-count')).not.toContainText('No co-authors', { timeout: 30_000 });
  await ownerPage.getByTestId('settings-btn').click();
  await ownerPage.locator('[data-testid=members-table] li', { hasText: removedName }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(ownerPage.getByText(`${removedName} removed`, { exact: false })).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Close' }).click();
  await expect(removed.getByText('you no longer have access')).toBeVisible({ timeout: 60_000 });
  await expect(removed.getByTestId('peer-count')).toContainText('No co-authors', { timeout: 60_000 });
  void editorText;

  await Promise.all([ctxO.close(), ctxE.close(), ctxV.close()]);
});
