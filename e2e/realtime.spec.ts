import { type Page, expect, test } from '@playwright/test';
import { addFile, createProject, joinProject, newUser, uniq } from './helpers.js';

/**
 * Real-time collaboration at group scale over real WebRTC (spec peer-sync › Real-time propagation at group scale):
 * seven browser users in one project. Latency is measured from the writer's edit to the moment the text appears in
 * each other user's editor DOM (all pages share the machine clock).
 */

type P2P = { session: { model: { find(p: string): { id: string } | undefined; openText(id: string): Promise<{ insert(i: number, s: string): void; length: number; toString(): string }> } } };

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] as number;

/** Records when each `#k#` marker first appears in this page's editor. */
async function watchMarkers(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __seen: Record<string, number> };
    w.__seen = {};
    const el = document.querySelector('.cm-content') as HTMLElement;
    const scan = () => {
      for (const m of el.textContent?.match(/#\d+#/g) ?? []) if (!(m in w.__seen)) w.__seen[m] = performance.timeOrigin + performance.now();
    };
    new MutationObserver(scan).observe(el, { childList: true, subtree: true, characterData: true });
    scan();
  });
}

const docText = (page: Page) =>
  page.evaluate(async () => {
    const s = (window as unknown as { __p2p: P2P }).__p2p.session;
    return (await s.model.openText(s.model.find('main.tex')!.id)).toString();
  });

test('seven users: edits reach everyone in real time and concurrent typing converges', async ({ browser }) => {
  test.setTimeout(300_000);
  const N = 7;
  const slug = uniq('rt-');
  const ctxs = await Promise.all(Array.from({ length: N }, () => browser.newContext()));
  const users = [];
  for (let i = 0; i < N; i++) users.push(await newUser(ctxs[i]!, `rt${i}`));
  const [owner, ...others] = users as [(typeof users)[number], ...typeof users];

  await createProject(owner.page, slug);
  await owner.page.getByTestId('settings-btn').click();
  await owner.page.getByLabel('Default role').selectOption('editor');
  await owner.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(owner.page.getByTestId('settings-dialog').getByText('Saved', { exact: true })).toBeVisible();
  await owner.page.getByRole('button', { name: 'Close' }).click();
  await addFile(owner.page, 'main.tex');
  for (const u of others) {
    await u.page.goto('/#/');
    await joinProject(u.page, slug);
  }
  for (const u of users) {
    await expect(u.page.getByTestId('peer-count')).toContainText(`${N - 1} co-authors`, { timeout: 120_000 });
    await u.page.getByRole('treeitem', { name: 'main.tex' }).click();
    await expect(u.page.locator('.cm-content')).toBeVisible();
  }

  // ---- latency: one writer, everyone else measures arrival in their editor ----
  const writer = others[0]!;
  const receivers = users.filter((u) => u !== writer);
  for (const r of receivers) await watchMarkers(r.page);
  const sent: Record<string, number> = {};
  for (let k = 0; k < 30; k++) {
    const marker = `#${k}#`;
    sent[marker] = await writer.page.evaluate(async (m) => {
      const s = (window as unknown as { __p2p: P2P }).__p2p.session;
      const t = await s.model.openText(s.model.find('main.tex')!.id);
      const at = performance.timeOrigin + performance.now();
      t.insert(t.length, m);
      return at;
    }, marker);
    await writer.page.waitForTimeout(100); // typing rhythm
  }
  await expect
    .poll(async () => (await Promise.all(receivers.map((r) => r.page.evaluate(() => Object.keys((window as unknown as { __seen: object }).__seen).length)))).every((n) => n === 30), { timeout: 30_000 })
    .toBe(true);
  const lat: number[] = [];
  for (const r of receivers) {
    const seen = await r.page.evaluate(() => (window as unknown as { __seen: Record<string, number> }).__seen);
    for (const [m, t] of Object.entries(sent)) lat.push((seen[m] as number) - t);
  }
  const p50 = pct(lat, 50);
  const p95 = pct(lat, 95);
  console.log(`[realtime] ${N} users over WebRTC: keystroke-to-screen p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${Math.max(...lat).toFixed(1)}ms (${lat.length} samples)`);
  expect(p95).toBeLessThan(250);

  // ---- everyone types at once ----
  const t0 = Date.now();
  await Promise.all(
    users.map((u, i) =>
      u.page.evaluate(async (who) => {
        const s = (window as unknown as { __p2p: P2P }).__p2p.session;
        const t = await s.model.openText(s.model.find('main.tex')!.id);
        for (let k = 0; k < 10; k++) {
          t.insert(k % 2 ? t.length : 0, `<${who}.${k}>`);
          await new Promise((r) => setTimeout(r, 20));
        }
      }, i),
    ),
  );
  await expect
    .poll(async () => new Set(await Promise.all(users.map((u) => docText(u.page)))).size, { timeout: 30_000 })
    .toBe(1);
  console.log(`[realtime] ${N} users x 10 concurrent edits converged in ${Date.now() - t0}ms`);
  const final = await docText(owner.page);
  for (let i = 0; i < N; i++) for (let k = 0; k < 10; k++) expect(final).toContain(`<${i}.${k}>`);
  for (const c of ctxs) await c.close();
});
