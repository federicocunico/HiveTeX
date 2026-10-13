import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, joinProject, newUser, typeInEditor } from './helpers.js';

test('same project name creates separate share IDs that can both be joined', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const { page } = await newUser(ownerContext, 'ids');
  const first = await createProject(page, 'projecttest');
  await page.goto('/#/');
  const second = await createProject(page, 'projecttest');
  expect(first).toMatch(/^projecttest-[a-z2-7]{16}$/);
  expect(second).not.toBe(first);
  const guestContext = await browser.newContext();
  const guest = await newUser(guestContext, 'joinids');
  for (const id of [first, second]) {
    await joinProject(guest.page, id);
    await expect(guest.page.getByTestId('project-slug')).toHaveText(id);
    await guest.page.goto('/#/');
  }
  await ownerContext.close();
  await guestContext.close();
});

test('rename updates the full share ID and cached metadata without changing the internal URL', async ({ browser }) => {
  const context = await browser.newContext();
  const { page } = await newUser(context, 'renameids');
  const original = await createProject(page, 'old-paper');
  await addFile(page, 'main.tex');
  await typeInEditor(page, 'Rename keeps this paper.\n');
  await page.evaluate(async () => {
    await (window as unknown as { __p2p: { session: { model: { flush: () => Promise<void> } } } }).__p2p.session.model.flush();
  });
  const url = page.url();
  await page.getByTestId('settings-btn').click();
  const dialog = page.getByTestId('settings-dialog');
  await dialog.getByLabel('Project name or current ID').fill('new-paper');
  await dialog.getByRole('button', { name: 'Change ID' }).click();
  await expect(dialog).toContainText('Copy the full new ID');
  await page.keyboard.press('Escape');
  const renamed = await page.getByTestId('project-slug').innerText();
  expect(renamed).toMatch(/^new-paper-[a-z2-7]{16}$/);
  expect(renamed).not.toBe(original);
  expect(page.url()).toBe(url);
  await page.getByTestId('share-btn').click();
  await expect(page.getByTestId('share-id')).toHaveValue(renamed);
  const cached = await page.evaluate(() => {
    const id = location.hash.split('/').at(-1);
    return JSON.parse(localStorage.getItem('hivetex.proj.' + id) ?? '{}').slug;
  });
  expect(cached).toBe(renamed);
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('Rename keeps this paper.');
  await expect(page.getByTestId('project-slug')).toHaveText(renamed);
  const guestContext = await browser.newContext();
  const guest = await newUser(guestContext, 'renamedjoin');
  await joinProject(guest.page, renamed);
  await expect(guest.page.getByTestId('project-slug')).toHaveText(renamed);
  await guestContext.close();
  await context.close();
});
