import { type Page, expect, test } from '@playwright/test';
import { addFile, createProject, joinProject, newUser, typeInEditor, uniq } from './helpers.js';

const leaderText = (p: Page) => p.getByTestId('leader').innerText();
const setMode = (p: Page, mode: 'auto' | 'peers' | 'local') => p.getByTestId('compile-mode').selectOption(mode);

test('compiler preference: hand-off when the leader chooses "Use peers", peers never compile, "This device only" stays local', async ({ browser }) => {
  test.setTimeout(180_000);
  const slug = uniq('cm-');
  const [co, ce] = [await browser.newContext(), await browser.newContext()];
  const O = await newUser(co, 'cmo');
  const E = await newUser(ce, 'cme');
  await createProject(O.page, slug);
  await O.page.getByTestId('settings-btn').click();
  await O.page.getByLabel('Default role').selectOption('editor');
  await O.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await O.page.getByRole('button', { name: 'Close' }).click();
  await addFile(O.page, 'main.tex');
  await O.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(O.page, '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n');
  await E.page.goto('/#/');
  await joinProject(E.page, slug);
  await E.page.getByRole('treeitem', { name: 'main.tex' }).click();
  for (const u of [O, E]) await expect(u.page.getByTestId('peer-count')).toContainText('1 co-author', { timeout: 30_000 });

  // whoever leads now switches to "Use peers": the other device takes over, without reopening anything
  await expect.poll(() => leaderText(O.page), { timeout: 30_000 }).not.toContain('none available');
  const ownerLeads = (await leaderText(O.page)).includes('this device');
  const [L, M] = ownerLeads ? [O, E] : [E, O];
  await setMode(L.page, 'peers');
  await expect.poll(() => leaderText(M.page), { timeout: 30_000 }).toContain('this device');
  await expect.poll(() => leaderText(L.page), { timeout: 30_000 }).toContain(M.username);

  // the "Use peers" device never compiles: its PDFs come from the other device
  await L.page.locator('.cm-content').click();
  await L.page.keyboard.press('Control+End');
  await L.page.keyboard.type('% edit from the peers-only device');
  await expect(L.page.getByTestId('compiled-by')).toContainText(M.username, { timeout: 30_000 });
  await expect(L.page.getByTestId('compiled-by')).not.toContainText(L.username);

  // nobody eligible any more: the peers-only device says so
  await setMode(M.page, 'local');
  await expect(L.page.getByTestId('no-peer-compiler')).toBeVisible({ timeout: 30_000 });
  await expect(M.page.getByTestId('leader')).toHaveText('Compiles only on this device');

  // "This device only" compiles its own PDF after edits
  await M.page.locator('.cm-content').click();
  await M.page.keyboard.press('Control+End');
  await M.page.keyboard.type('% local edit');
  await expect(M.page.getByTestId('compiled-by')).toContainText(`${M.username} (this device)`, { timeout: 30_000 });

  // back to automatic: it leads again
  await setMode(M.page, 'auto');
  await expect.poll(() => leaderText(M.page), { timeout: 30_000 }).toContain('this device');
  await expect(L.page.getByTestId('no-peer-compiler')).toHaveCount(0, { timeout: 30_000 });
  await co.close();
  await ce.close();
});
