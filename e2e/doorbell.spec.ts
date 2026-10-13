import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { PROJECT_PW, addFile, createProject, joinProject, newUser, typeInEditor, uniq } from './helpers.js';

// 3B.8: the doorbell in real browsers against the dev server, whose own push endpoint (/__dev/push) stands in for
// ntfy.sh. A client that is alone closes its signaling socket and is woken by the ring of a co-author who opens the
// project; once linked, neither keeps a socket and edits still flow.
type Mgr = { socketOpen: boolean; doorbellMode: boolean; stats: { rings: number; answers: number } };
const manager = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __p2p: { session: { runtime: { manager: Mgr | null }; doorbellState: string } } }).__p2p.session;
    const m = s.runtime.manager;
    return { socketOpen: m?.socketOpen ?? false, doorbellMode: m?.doorbellMode ?? false, state: s.doorbellState, rings: m?.stats.rings ?? 0, answers: m?.stats.answers ?? 0 };
  });

test('doorbell: a socketless client is rung awake, syncs, and nobody keeps a server connection afterwards', async ({ browser }) => {
  test.setTimeout(240_000);
  let slug = uniq('bell-');
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const a = await newUser(aCtx, 'bla');
  const b = await newUser(bCtx, 'blb');
  slug = await createProject(a.page, slug);
  await a.page.getByTestId('settings-btn').click();
  await a.page.getByLabel('Default role').selectOption('editor');
  await a.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(a.page.getByTestId('settings-dialog').getByText('Saved', { exact: true })).toBeVisible();
  await a.page.getByRole('button', { name: 'Close' }).click();
  await addFile(a.page, 'main.tex');
  await a.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(a.page, 'written while alone');

  // Alone: subscribed to the doorbell, the introduction window ends and the socket closes.
  await expect.poll(async () => (await manager(a.page)).doorbellMode, { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await manager(a.page)).socketOpen, { timeout: 60_000 }).toBe(false);
  await a.page.getByTestId('rail-sync').click().catch(() => {});

  await b.page.goto('/#/');
  await joinProject(b.page, slug, PROJECT_PW);
  const rang = Date.now();
  await expect(b.page.getByTestId('peer-count')).toContainText('1 co-author online', { timeout: 60_000 });
  const ringToLink = Date.now() - rang;
  console.log(`ring-to-link ${ringToLink} ms`);
  expect((await manager(a.page)).answers).toBeGreaterThan(0);
  await b.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(b.page.locator('.cm-content')).toContainText('written while alone', { timeout: 60_000 });

  // Linked: both sockets close, edits keep flowing peer to peer.
  await expect.poll(async () => (await manager(a.page)).socketOpen || (await manager(b.page)).socketOpen, { timeout: 60_000 }).toBe(false);
  await typeInEditor(b.page, ' and answered p2p');
  await expect(a.page.locator('.cm-content')).toContainText('and answered p2p', { timeout: 30_000 });
  expect((await manager(a.page)).socketOpen || (await manager(b.page)).socketOpen).toBe(false);
  await aCtx.close();
  await bCtx.close();
});
