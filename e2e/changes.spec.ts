import { expect, test } from '@playwright/test';
import { addFile, createProject, joinProject, newUser, typeInEditor, uniq } from './helpers.js';

type P2P = { folderEdit(path: string, text: string): Promise<void> };

test('changes view: a folder edit (e.g. Claude Code) is listed with its diff and can be undone for everyone', async ({ browser }) => {
  let slug = uniq('chg-');
  const [oc, gc] = [await browser.newContext(), await browser.newContext()];
  const owner = await newUser(oc, 'cho');
  const guest = await newUser(gc, 'chg');
  slug = await createProject(owner.page, slug);
  await addFile(owner.page, 'main.tex');
  await owner.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(owner.page, '\nFirst paragraph by hand.');
  await guest.page.goto('/#/');
  await joinProject(guest.page, slug);
  await guest.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(guest.page.locator('.cm-content')).toContainText('First paragraph by hand.');

  // an external tool rewrites the file in the bound folder
  const before = await owner.page.locator('.cm-content').innerText();
  await owner.page.evaluate(
    (t) => (window as unknown as { __p2p: P2P }).__p2p.folderEdit('main.tex', t.replace('First paragraph by hand.', 'First paragraph, polished by the AI.')),
    before,
  );
  await expect(guest.page.locator('.cm-content')).toContainText('polished by the AI'); // no lock, no staging

  await owner.page.getByTestId('changes-btn').click();
  const folderSet = owner.page.locator('[data-testid=change-set][data-source=folder]').first();
  await expect(folderSet).toBeVisible({ timeout: 10_000 });
  await folderSet.getByRole('button', { name: /Folder on this device/ }).click();
  await folderSet.getByRole('button', { name: /main\.tex/ }).click();
  await expect(folderSet.getByTestId('change-diff')).toContainText('polished by the AI');

  await folderSet.getByTestId('undo-change').click();
  await expect(owner.page.getByTestId('changes-message')).toContainText('Undone');
  await expect(guest.page.locator('.cm-content')).toContainText('First paragraph by hand.');
  await expect(guest.page.locator('.cm-content')).not.toContainText('polished by the AI');

  // the guest (editor) sees the owner's edits attributed to the owner
  await guest.page.getByTestId('changes-btn').click();
  await expect(guest.page.locator('[data-testid=change-set][data-source=peer]').first()).toContainText(owner.username);
  await oc.close();
  await gc.close();
});
