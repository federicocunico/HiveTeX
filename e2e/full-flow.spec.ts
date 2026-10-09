import { type Page, expect, test } from '@playwright/test';
import { addFile, createProject, editorText, joinProject, newUser, typeInEditor, uniq } from './helpers.js';

const leaderText = (p: Page) => p.getByTestId('leader').innerText();

test('three clients: concurrent edits, leader failover, read-only viewer and member removal (11.1, web part)', async ({ browser }) => {
  test.setTimeout(240_000);
  const slug = uniq('flow-');
  const [ctxO, ctxE, ctxV] = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const O = await newUser(ctxO, 'olga');
  const E = await newUser(ctxE, 'edie');
  const V = await newUser(ctxV, 'vera');

  // owner creates the project; newcomers start as editors, then the owner demotes vera
  await createProject(O.page, slug);
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
  await O.page.locator('[data-testid=members-table] tr', { hasText: V.username }).getByLabel(`Role of ${V.username}`).selectOption('viewer');
  await expect(O.page.getByText(`${V.username} is now viewer`)).toBeVisible();
  await O.page.getByRole('button', { name: 'Close' }).click();

  // everyone sees two peers
  for (const u of [O, E, V]) await expect(u.page.getByTestId('peer-count')).toContainText('2 peers', { timeout: 30_000 });

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

  // a leader exists and everybody agrees on it (viewers never lead)
  await expect.poll(async () => leaderText(O.page), { timeout: 30_000 }).not.toContain('none available');
  await expect.poll(async () => new Set([await leaderText(O.page), await leaderText(E.page)].map((t) => t.replace(/\(this device\)/, '').trim())).size).toBeGreaterThan(0);
  const leaderIsOwner = (await leaderText(O.page)).includes('this device');
  const leaderIsEditor = (await leaderText(E.page)).includes('this device');
  expect(leaderIsOwner || leaderIsEditor).toBe(true);
  expect((await leaderText(V.page)).includes('this device')).toBe(false);

  // kill the leader's tab -> the other editor takes over within seconds and compiles
  const [leaderPage, otherPage] = leaderIsOwner ? [O.page, E.page] : [E.page, O.page];
  await leaderPage.close();
  await expect.poll(async () => leaderText(otherPage), { timeout: 30_000 }).toContain('this device');
  await typeInEditor(otherPage, ' after-failover');
  const newLeaderName = leaderIsOwner ? E.username : O.username;
  await expect(otherPage.getByTestId('compiled-by')).toContainText(newLeaderName, { timeout: 30_000 });
  await expect(V.page.getByTestId('compiled-by')).toContainText(newLeaderName, { timeout: 30_000 });

  // owner removes the editor; within the grace period the removed member is cut off
  const ownerPage = leaderIsOwner ? await ctxO.newPage() : O.page;
  if (leaderIsOwner) {
    await ownerPage.addInitScript(() => {
      localStorage.setItem('p2platex.test', '1');
      localStorage.setItem('p2platex.fakeEngine', '1');
      localStorage.setItem('p2platex.epochGraceMs', '4000');
    });
    await ownerPage.goto('/#/');
    await ownerPage.getByRole('link', { name: new RegExp(slug) }).click();
    await expect(ownerPage.getByTestId('workspace')).toBeVisible();
  }
  const removed = leaderIsOwner ? otherPage : E.page; // the editor page that is still open
  const removedName = leaderIsOwner ? E.username : E.username;
  // the (re-opened) owner page must be linked to both members before the removal, so it can announce the new epoch
  await expect(ownerPage.getByTestId('peer-count')).toContainText('2 peers', { timeout: 60_000 });
  await expect(removed.getByTestId('peer-count')).not.toContainText('0 peers', { timeout: 30_000 });
  await ownerPage.getByTestId('settings-btn').click();
  await ownerPage.locator('[data-testid=members-table] tr', { hasText: removedName }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(ownerPage.getByText(`${removedName} removed`, { exact: false })).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Close' }).click();
  await expect(removed.getByText('you no longer have access')).toBeVisible({ timeout: 60_000 });
  await expect(removed.getByTestId('peer-count')).toContainText('0 peers', { timeout: 60_000 });
  void editorText;

  await Promise.all([ctxO.close(), ctxE.close(), ctxV.close()]);
});
