import { type Browser, type Page, expect, test } from '@playwright/test';
import { addFile, createProject, joinProject, newUser, replaceEditorText, uniq } from './helpers.js';

const BASE = 'line one\nline two\nline three\nline four\nline five\nline six\n';
const editorText = (p: Page) => p.evaluate(async () => {
  const s = (window as unknown as { __p2p: { session: { model: { find(p: string): { id: string }; openText(id: string): Promise<{ toString(): string }> } } } }).__p2p.session;
  return (await s.model.openText(s.model.find('main.tex').id)).toString();
});

/** Owner and an editor in one project, both with main.tex open and linked. */
async function pair(browser: Browser) {
  const [oc, ec] = [await browser.newContext(), await browser.newContext()];
  const o = await newUser(oc, 'mo');
  const e = await newUser(ec, 'me');
  let slug = uniq('merge-');
  slug = await createProject(o.page, slug);
  await o.page.getByTestId('settings-btn').click();
  await o.page.getByLabel('Default role').selectOption('editor');
  await o.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await o.page.getByRole('button', { name: 'Close' }).click();
  await addFile(o.page, 'main.tex');
  await o.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(o.page, BASE);
  await e.page.goto('/#/');
  await joinProject(e.page, slug);
  await e.page.getByRole('treeitem', { name: 'main.tex' }).click();
  for (const p of [o.page, e.page]) await expect(p.getByTestId('peer-count')).toContainText('1 co-author online', { timeout: 30_000 });
  await expect.poll(() => editorText(e.page), { timeout: 30_000 }).toBe(BASE);
  return { o: o.page, e: e.page, close: async () => { await oc.close(); await ec.close(); } };
}

/** Types at the end of line `n` (1-based) in the editor. */
async function typeAtEndOf(p: Page, n: number, text: string) {
  await p.locator('.cm-line').nth(n - 1).click();
  await p.keyboard.press('End');
  await p.keyboard.type(text);
}

async function workApart(o: Page, e: Page) {
  await o.getByTestId('pause-sync').click();
  for (const p of [o, e]) await expect(p.getByTestId('peer-count')).toContainText('No co-authors', { timeout: 30_000 });
}

test('offline edits to the same line become a conflict, resolved with "keep both" and shared', async ({ browser }) => {
  test.setTimeout(180_000);
  const { o, e, close } = await pair(browser);
  await workApart(o, e);
  await typeAtEndOf(o, 2, ' by owner');
  await typeAtEndOf(e, 2, ' by editor');
  await expect(o.getByTestId('unshared-work')).toBeVisible();
  await o.getByTestId('pause-sync').click(); // Resume sync

  // exactly one of the two devices holds the conflict (the other shared its work as it was)
  const pill = (p: Page) => p.getByTestId('conflicts-pill');
  await expect.poll(async () => (await pill(o).count()) + (await pill(e).count()), { timeout: 30_000 }).toBe(1);
  const [merger, other] = (await pill(o).count()) ? [o, e] : [e, o];
  const mine = merger === o ? 'line two by owner' : 'line two by editor';
  const theirs = merger === o ? 'line two by editor' : 'line two by owner';
  // the other device keeps its version until the conflict is decided
  await expect.poll(() => editorText(other)).toBe(`line one\n${theirs}\nline three\nline four\nline five\nline six\n`);
  await expect(merger.getByTestId('conflict-bar')).toBeVisible();

  await merger.getByTestId('resolve-btn').click();
  const dialog = merger.getByTestId('conflict-dialog');
  await expect(dialog.getByTestId('hunk-mine')).toContainText(mine);
  await expect(dialog.getByTestId('hunk-theirs')).toContainText(theirs);
  await dialog.getByTestId('keep-both').click();
  await dialog.getByTestId('apply-resolution').click();
  await expect(dialog.getByTestId('no-conflicts')).toBeVisible();
  const want = `line one\n${mine}\n${theirs}\nline three\nline four\nline five\nline six\n`;
  await expect.poll(() => editorText(other), { timeout: 30_000 }).toBe(want);
  await expect.poll(() => editorText(merger)).toBe(want);
  await expect(pill(merger)).toHaveCount(0);
  await close();
});

test('offline edits to different lines merge with a warning, and typing during the merge is kept', async ({ browser }) => {
  test.setTimeout(180_000);
  const { o, e, close } = await pair(browser);
  await workApart(o, e);
  await typeAtEndOf(o, 1, ' (owner)');
  await typeAtEndOf(e, 6, ' (editor)');
  await o.getByTestId('pause-sync').click();
  // keep typing while the devices reconnect and merge
  await typeAtEndOf(o, 3, ' typed-during-merge');
  const want = 'line one (owner)\nline two\nline three typed-during-merge\nline four\nline five\nline six (editor)\n';
  await expect.poll(() => editorText(o), { timeout: 30_000 }).toBe(want);
  await expect.poll(() => editorText(e), { timeout: 30_000 }).toBe(want);
  // the device that merged says which file was merged with others' changes
  const warned = (p: Page) => p.getByText(/merged with others' changes: main\.tex/).count();
  await expect.poll(async () => (await warned(o)) + (await warned(e)), { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(o.getByTestId('conflicts-pill')).toHaveCount(0);
  await expect(e.getByTestId('conflicts-pill')).toHaveCount(0);
  await close();
});

test('typing is not dropped while the file list changes under the editor', async ({ browser }) => {
  test.setTimeout(120_000);
  const { o, e, close } = await pair(browser);
  // a co-author keeps adding files (as a merge does when it replaces and re-applies documents) while the owner types
  const adding = e.evaluate(async () => {
    const s = (window as unknown as { __p2p: { session: { model: { createTextNow(p: string, c: string): Promise<string> } } } }).__p2p.session;
    for (let i = 0; i < 8; i++) {
      await s.model.createTextNow(`extra-${i}.tex`, '');
      await new Promise((r) => setTimeout(r, 120));
    }
  });
  await o.locator('.cm-line').nth(2).click();
  await o.keyboard.press('End');
  const typed = ' typed-while-files-change-1234567890';
  await o.keyboard.type(typed, { delay: 30 });
  await adding;
  const want = BASE.replace('line three\n', `line three${typed}\n`);
  await expect.poll(() => editorText(o), { timeout: 30_000 }).toBe(want);
  await expect(o.locator('.cm-content')).toContainText(typed.trim());
  await close();
});
