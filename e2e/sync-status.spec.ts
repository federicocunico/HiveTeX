import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, joinProject, newUser, uniq } from './helpers.js';

// A WebRTC offer that takes a few seconds, like a slow network: the guest sees the owner on the relay long before
// the connection is up.
const SLOW_OFFER = () => {
  const Orig = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Orig {
    async createOffer(...a: Parameters<RTCPeerConnection['createOffer']>) {
      await new Promise((r) => setTimeout(r, 6000));
      return super.createOffer(...a);
    }
  } as typeof RTCPeerConnection;
};

test('sync status: a slow join shows connecting, then progress, then up to date; Sync now works', async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  await ownerCtx.addInitScript(SLOW_OFFER);
  const o = await newUser(ownerCtx, 'syo');
  let slug = uniq('syn-');
  slug = await createProject(o.page, slug);
  for (const f of ['main.tex', 'intro.tex', 'method.tex', 'results.tex']) await addFile(o.page, f);

  const guestCtx = await browser.newContext();
  await guestCtx.addInitScript(SLOW_OFFER);
  const g = await newUser(guestCtx, 'syg');
  await joinProject(g.page, slug);

  // while the link is being negotiated, the owner is shown as connecting rather than "No co-authors online"
  await expect(g.page.getByTestId('peer-count')).toContainText('connecting', { timeout: 30_000 });
  await expect(g.page.getByTestId('sync-status')).not.toContainText('All changes synced');

  // eventually everything arrives and the bar says so, with a last-sync time
  await expect(g.page.getByTestId('sync-status')).toContainText('All changes synced', { timeout: 90_000 });
  await expect(g.page.getByTestId('peer-count')).toContainText('1 co-author online');

  await g.page.getByTestId('sync-status').click();
  await expect(g.page.getByTestId('sync-panel')).toBeVisible();
  await expect(g.page.getByTestId('sync-count')).toContainText('4 of 4');
  await expect(g.page.getByTestId('sync-files')).toContainText('method.tex');
  await expect(g.page.getByTestId('last-sync')).not.toContainText('not yet');

  await g.page.getByTestId('sync-now').click();
  await expect(g.page.getByTestId('sync-now-result')).toContainText(/up to date|Asked/i, { timeout: 30_000 });

  // diagnostics for a slow join are available in test mode
  const stages = await g.page.evaluate(() => (window as unknown as { __p2p: { session: { syncDiagnostics(): { stages: Record<string, { relaySeenAt?: number; linkUpAt?: number }> } } } }).__p2p.session.syncDiagnostics().stages);
  const first = Object.values(stages)[0];
  expect(typeof first?.relaySeenAt).toBe('number');
  expect(typeof first?.linkUpAt).toBe('number');
  await ownerCtx.close();
  await guestCtx.close();
});

test('sync status: files being edited are marked with who is in them', async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const o = await newUser(ownerCtx, 'sye');
  let slug = uniq('sye-');
  slug = await createProject(o.page, slug);
  await addFile(o.page, 'main.tex');
  await addFile(o.page, 'intro.tex');
  await o.page.getByRole('treeitem', { name: 'intro.tex' }).click();
  const guestCtx = await browser.newContext();
  const g = await newUser(guestCtx, 'syf');
  await joinProject(g.page, slug);
  await g.page.getByTestId('sync-status').click();
  await expect(g.page.getByTestId('sync-files')).toContainText(`${o.username} editing`, { timeout: 30_000 });
  await ownerCtx.close();
  await guestCtx.close();
});
