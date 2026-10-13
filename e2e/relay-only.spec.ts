import { expect, test } from '@playwright/test';
import { PROJECT_PW, addFile, createProject, joinProject, newUser, typeInEditor, uniq } from './helpers.js';

// 9.3: controlled relay-only reconnection. Needs a disposable TURN server on this machine:
//   docker compose --profile turn up -d turn        (coturn, 127.0.0.1:3478, user dev / dev-stack-turn)
//   RELAY_ONLY=1 pnpm exec playwright test e2e/relay-only.spec.ts
// Skipped without RELAY_ONLY=1 so the regular suite needs no relay. It forces iceTransportPolicy "relay" in both browsers
// (no host or server-reflexive candidates may be used) and checks the selected candidate pair, not just that text arrives.
const FORCE_RELAY = () => {
  const Orig = window.RTCPeerConnection;
  const all: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = all;
  window.RTCPeerConnection = class extends Orig {
    constructor(cfg?: RTCConfiguration) {
      super({
        ...cfg,
        iceServers: [{ urls: ['turn:127.0.0.1:3478?transport=udp', 'turn:127.0.0.1:3478?transport=tcp'], username: 'dev', credential: 'dev-stack-turn' }],
        iceTransportPolicy: 'relay',
      });
      all.push(this);
    }
  } as typeof RTCPeerConnection;
};

/** The candidate types of the selected pair of every open connection of the page. */
const selectedTypes = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const out: string[] = [];
    for (const pc of (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs) {
      if (pc.connectionState !== 'connected') continue;
      const stats = await pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      stats.forEach((s) => {
        byId.set(s.id, s);
      });
      stats.forEach((s) => {
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
          out.push(`${(byId.get(s.localCandidateId) as { candidateType?: string })?.candidateType}/${(byId.get(s.remoteCandidateId) as { candidateType?: string })?.candidateType}`);
        }
      });
    }
    return out;
  });

test.skip(!process.env.RELAY_ONLY, 'needs a local TURN server and RELAY_ONLY=1');

test('relay-only: two browsers connect through TURN only, edit, drop the link and reconnect through TURN again', async ({ browser }) => {
  test.setTimeout(240_000);
  let slug = uniq('relay-');
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  await aCtx.addInitScript(FORCE_RELAY);
  await bCtx.addInitScript(FORCE_RELAY);
  const a = await newUser(aCtx, 'rla');
  const b = await newUser(bCtx, 'rlb');
  slug = await createProject(a.page, slug);
  await a.page.getByTestId('settings-btn').click();
  await a.page.getByLabel('Default role').selectOption('editor');
  await a.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(a.page.getByTestId('settings-dialog').getByText('Saved', { exact: true })).toBeVisible();
  await a.page.getByRole('button', { name: 'Close' }).click();
  await addFile(a.page, 'main.tex');
  await a.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(a.page, 'before relay');

  await b.page.goto('/#/');
  await joinProject(b.page, slug, PROJECT_PW);
  await b.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(b.page.locator('.cm-content')).toContainText('before relay', { timeout: 90_000 });
  await expect(b.page.getByTestId('peer-count')).toContainText('1 co-author online');
  // every selected pair used a relay candidate on our side
  const first = await selectedTypes(b.page);
  expect(first.length).toBeGreaterThan(0);
  for (const t of first) expect(t.startsWith('relay/')).toBe(true);

  // drop the link and bring it back: the new connection is relayed again and an edit made meanwhile arrives exactly once
  await b.page.getByTestId('pause-sync').click();
  await expect(b.page.getByTestId('peer-count')).toContainText('No co-authors');
  await typeInEditor(a.page, ' and after');
  await b.page.getByTestId('pause-sync').click();
  await expect(b.page.locator('.cm-content')).toContainText('and after', { timeout: 90_000 });
  const second = await selectedTypes(b.page);
  expect(second.length).toBeGreaterThan(0);
  for (const t of second) expect(t.startsWith('relay/')).toBe(true);
  const text = await b.page.evaluate(async () => {
    const s = (window as unknown as { __p2p: { session: { model: { find(p: string): { id: string } | undefined; openText(id: string): Promise<{ toString(): string }> } } } }).__p2p.session;
    return (await s.model.openText(s.model.find('main.tex')!.id)).toString();
  });
  expect(text.match(/before relay/g)?.length).toBe(1);
  expect(text.match(/and after/g)?.length).toBe(1);
  await aCtx.close();
  await bCtx.close();
});
