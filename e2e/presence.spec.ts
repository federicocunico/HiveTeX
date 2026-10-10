import { type Page, expect, test } from '@playwright/test';
import { addFile, createProject, joinProject, newUser, replaceEditorText, uniq } from './helpers.js';

async function editorRoleByDefault(p: Page) {
  await p.getByTestId('settings-btn').click();
  await p.getByLabel('Default role').selectOption('editor');
  await p.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(p.getByText('Saved', { exact: true })).toBeVisible();
  await p.getByRole('button', { name: 'Close' }).click();
}

test('presence: avatars say where co-authors are, files show who is in them', async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const o = await newUser(ownerCtx, 'pres');
  const slug = uniq('pres-');
  await createProject(o.page, slug);
  await addFile(o.page, 'main.tex');
  await addFile(o.page, 'intro.tex');
  await o.page.getByRole('treeitem', { name: 'intro.tex' }).click();

  const guestCtx = await browser.newContext();
  const g = await newUser(guestCtx, 'presg');
  await joinProject(g.page, slug);
  await g.page.getByRole('treeitem', { name: 'main.tex' }).click();

  // the guest sees where the owner is: in the avatar's name and as a dot on intro.tex
  await expect(g.page.getByRole('button', { name: `Follow ${o.username}, in intro.tex` })).toBeVisible({ timeout: 30_000 });
  await expect(g.page.getByRole('treeitem', { name: /intro\.tex/ }).getByTestId('presence-dot')).toHaveCount(1);
  // and the owner sees the guest in main.tex
  await expect(o.page.getByRole('treeitem', { name: /main\.tex/ }).getByTestId('presence-dot')).toHaveCount(1, { timeout: 30_000 });
  // same file → a dot in the editor header
  await o.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(o.page.getByTestId('here-dot')).toHaveCount(1, { timeout: 30_000 });
  await ownerCtx.close();
  await guestCtx.close();
});

test('follow: the follower goes where the co-author goes, and stops on scroll', async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const o = await newUser(ownerCtx, 'lead');
  const slug = uniq('fol-');
  await createProject(o.page, slug);
  await editorRoleByDefault(o.page);
  await addFile(o.page, 'main.tex');
  await o.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(o.page, Array.from({ length: 80 }, (_, i) => `Line ${i + 1}.`).join('\n'));
  await addFile(o.page, 'method.tex');
  await o.page.getByRole('treeitem', { name: 'main.tex' }).click();

  const guestCtx = await browser.newContext();
  const g = await newUser(guestCtx, 'folw');
  await joinProject(g.page, slug);
  await g.page.getByRole('treeitem', { name: 'method.tex' }).click();
  await g.page.getByRole('button', { name: new RegExp(`^Follow ${o.username}`) }).click();
  await expect(g.page.getByTestId('following')).toContainText(o.username);
  // the guest is taken to the owner's file
  await expect(g.page.locator('.ed-head .path')).toHaveText('main.tex', { timeout: 30_000 });

  // the owner moves to method.tex: the follower moves too
  await o.page.getByRole('treeitem', { name: 'method.tex' }).click();
  await expect(g.page.locator('.ed-head .path')).toHaveText('method.tex', { timeout: 30_000 });

  // scrolling ends following
  await g.page.locator('.cm-scroller').hover();
  await g.page.mouse.wheel(0, 300);
  await expect(g.page.getByTestId('following')).toHaveCount(0);
  await o.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await g.page.waitForTimeout(1500);
  await expect(g.page.locator('.ed-head .path')).toHaveText('method.tex');
  await ownerCtx.close();
  await guestCtx.close();
});
