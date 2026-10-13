import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Page, expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { joinProject, newUser, openNewProject, PROJECT_PW, uniq } from './helpers.js';

/**
 * Regenerates the README and docs screenshots: SCREENSHOTS=1 pnpm exec playwright test e2e/screenshots.spec.ts
 * With a local TeX installation the PDF pane shows the template compiled for real; otherwise the test engine's output.
 */
test.skip(!process.env.SCREENSHOTS, 'screenshots are generated on request');

const path = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const out = (name: string) => path(new URL(`../docs/images/${name}.png`, import.meta.url));

/** The Article template compiled with the local pdflatex (+bibtex), or null without TeX. */
function articlePdf(): Buffer | null {
  if (spawnSync('pdflatex', ['--version']).status !== 0) return null;
  const src = path(new URL('../apps/web/src/templates/article/', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'hivetex-shot-'));
  for (const f of readdirSync(src)) if (/\.(tex|bib)$/.test(f)) writeFileSync(join(dir, f), readFileSync(join(src, f)));
  const tex = () => spawnSync('pdflatex', ['-interaction=nonstopmode', 'main.tex'], { cwd: dir });
  tex();
  spawnSync('bibtex', ['main'], { cwd: dir });
  tex();
  tex();
  return readFileSync(join(dir, 'main.pdf'));
}

async function showPdf(p: Page, pdf: Buffer) {
  await p.evaluate((b64) => {
    const s = (window as unknown as { __p2p: { session: { pdf: Uint8Array; pdfRev: number; stale: boolean } } }).__p2p.session;
    s.pdf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    s.stale = false;
    s.pdfRev++;
  }, pdf.toString('base64'));
}

test('screenshots for the README and docs', async ({ browser }) => {
  test.setTimeout(240_000);
  const pdf = articlePdf();
  for (const colorScheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, colorScheme, deviceScaleFactor: 1 });
    const { page: p } = await newUser(ctx, `shot${colorScheme}`);
    await openNewProject(p);
    await p.getByTestId('template-article').click();
    await p.getByPlaceholder('my-paper-2026').fill(uniq('protein-folding-'));
    await p.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
    if (colorScheme === 'light') await p.screenshot({ path: out('new-project') });
    await p.getByRole('button', { name: 'Create project' }).click();
    await expect(p.getByTestId('workspace')).toBeVisible();
    await p.getByRole('button', { name: 'Recompile' }).click();
    await expect(p.getByTestId('compiled-by')).toBeVisible({ timeout: 30_000 });
    if (pdf) await showPdf(p, pdf);
    await p.getByTestId('rail-outline').click();
    await expect(p.getByText('Rendering…')).toHaveCount(0, { timeout: 15_000 });
    if (pdf) await p.evaluate(() => ((window as unknown as { __p2p: { session: { stale: boolean } } }).__p2p.session.stale = false));
    await p.waitForTimeout(800);
    await p.screenshot({ path: out(`workspace-${colorScheme}`) });
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('landing')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out('landing') });
  await ctx.close();
});

test('screenshots: writing together, sharing, and the compiler settings', async ({ browser }) => {
  test.setTimeout(240_000);
  const pdf = articlePdf();
  const view = { viewport: { width: 1440, height: 860 }, colorScheme: 'light' as const, deviceScaleFactor: 1 };
  const [oc, ec] = [await browser.newContext(view), await browser.newContext(view)];
  const { page: o } = await newUser(oc, 'ada');
  const { page: e } = await newUser(ec, 'grace');
  const slug = uniq('climate-review-');
  await openNewProject(o);
  await o.getByTestId('template-article').click();
  await o.getByPlaceholder('my-paper-2026').fill(slug);
  await o.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
  await o.getByRole('button', { name: 'Create project' }).click();
  await expect(o.getByTestId('workspace')).toBeVisible();

  // new members may edit (Share dialog)
  await o.getByTestId('share-btn').click();
  const share = o.getByTestId('share-dialog');
  await share.getByLabel('Default role for new members').selectOption('editor');
  await share.getByRole('button', { name: 'Save', exact: true }).click();
  await o.keyboard.press('Escape');

  // a co-author joins and edits the title: avatars, colored cursors, and the PDF compiled by the best device
  await e.goto('/#/');
  await joinProject(e, slug);
  await e.getByRole('treeitem', { name: 'main.tex' }).click();
  await e.locator('.cm-line', { hasText: '\title{Your Paper Title}' }).click();
  await e.keyboard.press('End');
  await e.keyboard.press('ArrowLeft');
  await e.keyboard.type(': Sea Ice and Ocean Heat');
  await expect(o.locator('.cm-content')).toContainText('Sea Ice and Ocean Heat', { timeout: 30_000 });
  await o.getByRole('button', { name: 'Recompile' }).click();
  await expect(o.getByTestId('compiled-by')).toBeVisible({ timeout: 30_000 });
  if (pdf) await showPdf(o, pdf);
  await o.waitForTimeout(1500);
  await o.screenshot({ path: out('collaboration') });

  // Share dialog: the invitation (project ID; the password is sent separately), the default role and the members
  await o.getByTestId('share-btn').click();
  await expect(o.getByTestId('share-dialog')).toContainText('grace');
  await o.waitForTimeout(400);
  await o.screenshot({ path: out('share') });
  await o.keyboard.press('Escape');

  // Account > Compiler: this device's role in building PDFs, and compiling with the desktop app
  await o.goto('/#/account');
  const panel = o.getByTestId('compiler-settings');
  await expect(panel).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await o.waitForTimeout(300);
  await panel.screenshot({ path: out('compiler-settings') });
  await oc.close();
  await ec.close();
});
