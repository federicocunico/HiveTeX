import { expect, test } from '@playwright/test';
import { PW, addFile, createProject, editorText, joinProject, newUser, signOut, typeInEditor, uniq, waitForMail } from './helpers.js';

test('account flow: register, verify, sign out, reset password, sign in (3.8)', async ({ browser }) => {
  const context = await browser.newContext();
  const { page, username } = await newUser(context, 'acct');

  // verification link from the dev mailbox
  const verify = await waitForMail(page, `${username}@example.com`, /Verify/);
  const token = /token=([\w-]+)/.exec(verify.text)?.[1];
  await page.goto(`/#/verify?token=${token}`);
  await expect(page.getByText('Email verified')).toBeVisible();

  await page.goto('/#/');
  await signOut(page);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // forgot -> neutral message -> reset link -> new password -> sign in
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible();
  await page.getByLabel('Email').fill(`${username}@example.com`);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('If the address exists')).toBeVisible();
  const reset = await waitForMail(page, `${username}@example.com`, /Reset/);
  const rtoken = /token=([\w-]+)/.exec(reset.text)?.[1];
  await page.goto(`/#/reset?token=${rtoken}`);
  const newPw = 'a brand new passphrase!';
  await page.locator('input[type=password]').nth(0).fill(newPw);
  await page.locator('input[type=password]').nth(1).fill(newPw);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText('Password updated')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Username or email').fill(username);
  await page.getByLabel('Password').fill(newPw);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await context.close();
  void PW;
});

test('collaboration: join as viewer, promote to editor, live sync and presence (4.6, 7.1, 7.3)', async ({ browser }) => {
  let slug = uniq('collab-');
  const ownerCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const owner = await newUser(ownerCtx, 'olga');
  const guest = await newUser(guestCtx, 'gus');

  slug = await createProject(owner.page, slug);
  await addFile(owner.page, 'main.tex');
  await owner.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(owner.page, '\\section{Hello} from the owner');

  await guest.page.goto('/#/');
  await joinProject(guest.page, slug);
  await expect(guest.page.getByTestId('role-pill')).toHaveText('viewer');
  await guest.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(guest.page.locator('.cm-content')).toContainText('from the owner');

  // viewer cannot type
  await expect(guest.page.getByTestId('editor')).toHaveAttribute('data-readonly', 'true');
  await guest.page.locator('.cm-content').click();
  await guest.page.keyboard.type('HACK');
  await expect(guest.page.locator('.cm-content')).not.toContainText('HACK');

  // peers see each other
  await expect(owner.page.getByTestId('peer-count')).toContainText('1 co-author online');
  await expect(guest.page.getByTestId('peer-count')).toContainText(owner.username);

  // owner promotes the guest
  await owner.page.getByTestId('settings-btn').click();
  const row = owner.page.locator('[data-testid=members-table] li', { hasText: guest.username });
  await row.getByLabel(`Role of ${guest.username}`).selectOption('editor');
  await owner.page.getByRole('button', { name: 'Close' }).click();

  // guest's ticket refreshes on its own schedule; reload to pick up the new role immediately
  await guest.page.reload();
  await expect(guest.page.getByTestId('role-pill')).toHaveText('editor');
  await guest.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(guest.page, ' and the guest');
  await expect(owner.page.locator('.cm-content')).toContainText('and the guest');

  // remote cursor labelled with the username shows up for the other side
  await expect(owner.page.locator('.cm-ySelectionInfo', { hasText: guest.username }).first()).toBeAttached();

  // file ops propagate: guest uploads an image-like file, owner sees it in the tree
  await guest.page.getByTestId('upload-input').setInputFiles({ name: 'figure.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 1, 2, 3]) });
  await expect(owner.page.getByRole('treeitem', { name: 'figure.png' })).toBeVisible();

  // rename syncs
  await owner.page.getByRole('treeitem', { name: 'main.tex' }).hover();
  await owner.page.getByLabel('Rename main.tex').click();
  const input = owner.page.getByRole('treeitem').locator('input[type=text]');
  await input.fill('paper.tex');
  await input.press('Enter');
  await expect(guest.page.getByRole('treeitem', { name: 'paper.tex' })).toBeVisible();
  await expect(guest.page.locator('.cm-content')).toContainText('and the guest');

  await ownerCtx.close();
  await guestCtx.close();
});
