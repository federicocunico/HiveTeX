import { expect, test } from '@playwright/test';
import { PROJECT_PW, addFile, createProject, joinProject, newUser, typeInEditor, uniq } from './helpers.js';

// 3.7: two browsers that cannot open any WebRTC path (no host/STUN candidates, no TURN) still collaborate through the
// server's end-to-end encrypted application relay. Needs the dev server with the relay role:
//   APPLICATION_RELAY=1 pnpm exec playwright test e2e/application-relay.spec.ts
// Skipped otherwise, so the regular suite keeps its direct-WebRTC behaviour.
const NO_WEBRTC = () => {
  const Orig = window.RTCPeerConnection;
  const all: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = all;
  window.RTCPeerConnection = class extends Orig {
    constructor(cfg?: RTCConfiguration) {
      // Relay-only candidates with no TURN server: ICE can never select a pair.
      super({ ...cfg, iceServers: [], iceTransportPolicy: 'relay' });
      all.push(this);
    }
  } as typeof RTCPeerConnection;
};
const connectedPcs = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((pc) => pc.connectionState === 'connected').length);

test.skip(process.env.APPLICATION_RELAY !== '1', 'needs the dev server with APPLICATION_RELAY=1');

test('application relay: two browsers without WebRTC or TURN edit together, reconnect after pausing, and show the route', async ({ browser }) => {
  test.setTimeout(240_000);
  const slug = uniq('apprelay-');
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  await aCtx.addInitScript(NO_WEBRTC);
  await bCtx.addInitScript(NO_WEBRTC);
  const a = await newUser(aCtx, 'ara');
  const b = await newUser(bCtx, 'arb');
  await createProject(a.page, slug);
  await a.page.getByTestId('settings-btn').click();
  await a.page.getByLabel('Default role').selectOption('editor');
  await a.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(a.page.getByTestId('settings-dialog').getByText('Saved', { exact: true })).toBeVisible();
  await a.page.getByRole('button', { name: 'Close' }).click();
  await addFile(a.page, 'main.tex');
  await a.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(a.page, 'through the server relay');

  await b.page.goto('/#/');
  const joined = Date.now();
  await joinProject(b.page, slug, PROJECT_PW);
  await expect(b.page.getByTestId('peer-count')).toContainText('1 co-author online', { timeout: 60_000 });
  // Relay setup starts within 10 s of learning the capability; joining and authenticating add a little on top.
  expect(Date.now() - joined).toBeLessThan(30_000);
  await b.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(b.page.locator('.cm-content')).toContainText('through the server relay', { timeout: 60_000 });
  expect(await connectedPcs(a.page)).toBe(0);
  expect(await connectedPcs(b.page)).toBe(0);

  await b.page.getByTestId('peer-count').click();
  await expect(b.page.locator('[data-route="relay"]')).toContainText('HiveTeX server (encrypted)');

  // Edits in both directions, then a pause/resume: a fresh relay session carries the edit made meanwhile exactly once.
  await typeInEditor(b.page, ' and back');
  await expect(a.page.locator('.cm-content')).toContainText('and back', { timeout: 60_000 });
  await b.page.getByTestId('pause-sync').click();
  await expect(b.page.getByTestId('peer-count')).toContainText('No co-authors');
  await typeInEditor(a.page, ' while paused');
  await b.page.getByTestId('pause-sync').click();
  await expect(b.page.locator('.cm-content')).toContainText('while paused', { timeout: 90_000 });
  const text = await b.page.evaluate(async () => {
    const s = (window as unknown as { __p2p: { session: { model: { find(p: string): { id: string } | undefined; openText(id: string): Promise<{ toString(): string }> } } } }).__p2p.session;
    return (await s.model.openText(s.model.find('main.tex')!.id)).toString();
  });
  expect(text.match(/while paused/g)?.length).toBe(1);
  expect(await connectedPcs(b.page)).toBe(0);
  await aCtx.close();
  await bCtx.close();
});
