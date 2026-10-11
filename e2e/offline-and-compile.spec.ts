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
  await expect(a.page.getByTestId('peer-count')).toContainText('No co-authors');
  await expect(b.page.getByTestId('peer-count')).toContainText('No co-authors');

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
  await typeInEditor(u.page, '\\documentclass{article}\n\\begin{document}\nHello from hivetex.\n\\end{document}\n');

  await expect(u.page.getByTestId('statusbar')).toContainText('in-browser compiler');
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

// 9.2: a link that drops while a binary file is being transferred neither corrupts nor strands it.
test('reconnect with a binary transfer in flight: the exact bytes arrive and the status settles', async ({ browser }) => {
  test.setTimeout(180_000);
  type Blobs = { has(h: string): Promise<boolean>; get(h: string): Promise<Uint8Array | undefined>; chunkProgress(h: string): number };
  type S = { addBinary(p: string, b: Uint8Array): Promise<void>; blobs: Blobs; model: { find(p: string): { hash?: string; size?: number } | undefined } };
  const slug = uniq('binfl-');
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await newUser(aCtx, 'bia');
  const b = await newUser(bCtx, 'bib');
  await createProject(a.page, slug);
  await addFile(a.page, 'main.tex');
  // 24 MB of incompressible bytes, so the transfer takes long enough to interrupt on a loopback link
  const hash = await a.page.evaluate(async () => {
    const s = (window as unknown as { __p2p: { session: S } }).__p2p.session;
    const bytes = new Uint8Array(24 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(bytes.length, i + 65536)));
    await s.addBinary('big.png', bytes);
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
  });
  expect(hash).toMatch(/^[0-9a-f]{64}$/);

  await b.page.goto('/#/');
  await joinProject(b.page, slug, PROJECT_PW);
  await expect(b.page.getByRole('treeitem', { name: 'big.png' })).toBeVisible({ timeout: 60_000 });
  const probe = (h: string) =>
    b.page.evaluate(async (hh) => {
      const s = (window as unknown as { __p2p: { session: S } }).__p2p.session;
      return { has: await s.blobs.has(hh), progress: s.blobs.chunkProgress(hh) };
    }, h);
  // cut the link as soon as the first chunks are in but the file is not complete
  await expect.poll(async () => (await probe(hash)).progress, { timeout: 60_000, intervals: [20] }).toBeGreaterThan(0);
  const mid = await probe(hash);
  await b.page.getByTestId('pause-sync').click();
  expect(mid.has, 'the transfer finished before the link was cut: the scenario did not run in flight').toBe(false);
  await expect(b.page.getByTestId('peer-count')).toContainText('No co-authors');
  // the owner keeps typing while the link is down and the transfer is unfinished
  await a.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(a.page, 'typed while the transfer was cut');
  await b.page.getByTestId('pause-sync').click(); // Resume sync

  await expect.poll(async () => (await probe(hash)).has, { timeout: 120_000 }).toBe(true);
  const digest = await b.page.evaluate(async (hh) => {
    const s = (window as unknown as { __p2p: { session: S } }).__p2p.session;
    const bytes = (await s.blobs.get(hh)) as Uint8Array;
    const d = await crypto.subtle.digest('SHA-256', bytes);
    return { len: bytes.length, sha: [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('') };
  }, hash);
  expect(digest).toEqual({ len: 24 * 1024 * 1024, sha: hash });
  await b.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(b.page.locator('.cm-content')).toContainText('typed while the transfer was cut', { timeout: 60_000 });
  // identical shared text on both sides (the editor DOM also carries remote-cursor labels, so compare the documents)
  const shared = (page: typeof a.page) =>
    page.evaluate(async () => {
      const s = (window as unknown as { __p2p: { session: { model: { find(p: string): { id: string } | undefined; openText(id: string): Promise<{ toString(): string }> } } } }).__p2p.session;
      return (await s.model.openText(s.model.find('main.tex')!.id)).toString();
    });
  await expect.poll(async () => (await shared(b.page)) === (await shared(a.page))).toBe(true);
  expect(await shared(b.page)).toContain('typed while the transfer was cut');
  await expect(b.page.getByTestId('sync-status')).toContainText('All changes synced', { timeout: 60_000 });
  await aCtx.close();
  await bCtx.close();
});
