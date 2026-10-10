import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { newUser, openNewProject, PROJECT_PW, uniq } from './helpers.js';

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
