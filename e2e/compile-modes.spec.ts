import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, joinProject, newUser, typeInEditor, uniq } from './helpers.js';

test('builds stay on each device, including after legacy preference migration and peer disconnect', async ({ browser }) => {
  const [ownerContext, editorContext] = [await browser.newContext(), await browser.newContext()];
  const owner = await newUser(ownerContext, 'localo');
  const editor = await newUser(editorContext, 'locale');
  const slug = await createProject(owner.page, uniq('local-'));
  await addFile(owner.page, 'main.tex');
  await owner.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(owner.page, '\nlocal source');
  await joinProject(editor.page, slug);
  await editor.page.getByRole('treeitem', { name: 'main.tex' }).click();
  for (const user of [owner, editor]) {
    await expect(user.page.getByTestId('peer-count')).toContainText('1 co-author');
    await expect(user.page.getByTestId('compile-location')).toHaveText('Compiles on this device');
    await expect(user.page.getByTestId('compiled-by')).toContainText(user.username);
    await expect(user.page.getByTestId('compile-mode')).toHaveText('Build: this device');
  }
  await editor.page.evaluate(() => localStorage.setItem('hivetex.compileMode', 'peers'));
  await editor.page.reload();
  await expect(editor.page.getByTestId('compile-migration')).toContainText('Shared compilation was removed');
  await expect(editor.page.getByTestId('compiled-by')).toContainText(editor.username);
  expect(await editor.page.evaluate(() => localStorage.getItem('hivetex.compileMode'))).toBe('local');
  // A reload before the member read it keeps the explanation; dismissing it ends it for good.
  await editor.page.reload();
  await expect(editor.page.getByTestId('compile-migration')).toContainText('Shared compilation was removed');
  await expect(editor.page.getByTestId('compile-migration-setup')).toHaveCount(0);
  await editor.page.getByTestId('compile-migration-dismiss').click();
  await expect(editor.page.getByTestId('compile-migration')).toHaveCount(0);
  await editor.page.reload();
  await expect(editor.page.getByTestId('compile-location')).toBeVisible();
  await expect(editor.page.getByTestId('compile-migration')).toHaveCount(0);
  await editorContext.close();
  await typeInEditor(owner.page, '\nstill building here');
  await owner.page.getByTestId('compile-btn').click();
  await expect(owner.page.getByTestId('compiled-by')).toContainText(owner.username);
  await ownerContext.close();
});
