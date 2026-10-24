import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, joinProject, newUser, replaceEditorText } from './helpers.js';
import { articleProject, realCompilerContext } from './real-workspace.js';
import { texFixture } from './tex-fixture.js';
import { pdfText } from './fixtures/compile-templates.js';
import type { EditorHost } from './editor-geometry.js';

const sizes = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }];
async function accessible(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.cm-editor');
  if (include) builder = builder.include(include);
  const result = await builder.analyze();
  const failures = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(failures, JSON.stringify(failures.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))).toEqual([]);
}

test('real article review matrix, visual baselines and accessible workspace controls', async ({ browser }, info) => {
  test.setTimeout(360_000);
  const packages = await texFixture({ pinned: true });
  const captures: Array<{ label: string; data: string }> = [];
  try {
    for (const theme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: sizes[0], colorScheme: theme, deviceScaleFactor: 1 });
      const guest = await browser.newContext({ viewport: sizes[0], colorScheme: theme });
      try {
        await realCompilerContext(ctx, packages.url); await realCompilerContext(guest, packages.url);
        const { page: p } = await newUser(ctx, 'visual-researcher-', { realCompiler: true });
        const slug = await articleProject(p, 'collaborative-long-paper-');
        await addFile(p, 'supplementary-analysis-and-methodology.tex');
        await p.getByRole('treeitem', { name: 'main.tex' }).click();
        await p.evaluate(() => document.fonts.ready);
        const source = await p.evaluate(() => {
          const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
          const text = view.state.doc.toString();
          const at = text.indexOf('\\date{\\today}');
          view.dispatch({ changes: { from: at, to: at + '\\date{\\today}'.length, insert: '\\date{October 2026}' } });
          // keyboard.type sends both CR and LF as Enter; use one Enter per source line for bulk typing below.
          return view.state.doc.toString().replace(/\r\n/g, '\n');
        });
        const capture = async (state: string, baseline = false) => {
          for (const size of sizes) {
            await p.setViewportSize(size);
            if (size.width === 1024) await p.getByRole('button', { name: 'Editor', exact: true }).click();
            await expect(p.getByTestId('compile-btn')).toBeVisible();
            expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            const label = `${theme}-${size.width}-${state}`;
            const bytes = await p.screenshot({ path: info.outputPath(`${label}.png`), animations: 'disabled' });
            captures.push({ label, data: bytes.toString('base64') });
            if (baseline) await expect(p).toHaveScreenshot(`${label}.png`, {
              animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002,
              stylePath: 'e2e/fixtures/visual-stability.css',
              mask: [p.getByTestId('project-slug'), p.getByTestId('compiled-by'), p.getByRole('button', { name: 'Account menu' }), p.getByTestId('sync-status')],
            });
            if (size.width === 1024) {
              await p.getByRole('button', { name: 'PDF', exact: true }).click();
              // Narrow layout remounts PdfView; wait for the actual page, not just its toolbar.
              if (state !== 'loading') await expect(p.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();
              const pdf = await p.screenshot({ path: info.outputPath(`${label}-pdf.png`), animations: 'disabled' });
              captures.push({ label: `${label}-pdf`, data: pdf.toString('base64') });
              if (baseline) await expect(p).toHaveScreenshot(`${label}-pdf.png`, {
                animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.002,
                stylePath: 'e2e/fixtures/visual-stability.css',
                mask: [p.getByTestId('project-slug'), p.getByTestId('compiled-by'), p.getByRole('button', { name: 'Account menu' }), p.getByTestId('sync-status')],
              });
            }
          }
          await p.setViewportSize(sizes[0]!);
          if (state !== 'loading') await expect(p.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();
        };

        // Hold real package responses while the real worker waits: deterministic loading, no fake engine/state.
        await expect(p.getByTestId('compile-schedule-state')).toHaveText('Manual', { timeout: 30_000 });
        packages.pause();
        await p.getByTestId('compile-btn').click();
        await expect(p.getByTestId('compile-btn')).toHaveText('Compiling…');
        await capture('loading');
        packages.resume();
        await expect(p.getByTestId('build-status')).toContainText('PDF up to date', { timeout: 180_000 });
        await expect(p.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();
        const output = await p.evaluate(() => { const s = (window as any).__p2p.session; return { pdf: Array.from(s.pdf as Uint8Array), log: s.result.log, fake: localStorage.getItem('hivetex.fakeEngine') }; });
        expect(output.fake).toBeNull();
        const text = await pdfText(new Uint8Array(output.pdf));
        expect(text).toContain('Your Paper Title'); expect(text).toContain('Knuth'); expect(text).not.toContain('?');
        await info.attach(`${theme}-compiler.log`, { body: output.log, contentType: 'text/plain' });
        await capture('ready', true);
        await accessible(p);

        // Both themes: menu keyboard/focus, preferences and details, including axe checks.
        await p.getByTestId('split-splitter').focus(); await p.keyboard.press('Home');
        await p.getByTestId('fmt-more').focus(); await p.keyboard.press('ArrowDown');
        await accessible(p, '[role="menu"]');
        await p.keyboard.press('Escape'); await expect(p.getByTestId('fmt-more')).toBeFocused();
        await p.getByTestId('split-splitter').dblclick();
        await p.getByTestId('status-details').click(); await accessible(p, '[data-testid="status-dialog"]');
        await p.keyboard.press('Escape'); await expect(p.getByTestId('status-details')).toBeFocused();
        await p.getByRole('button', { name: 'Compile options', exact: true }).click();
        await p.getByRole('menuitem', { name: 'Schedule and interval…' }).click();
        await accessible(p, '[role="dialog"]'); await p.keyboard.press('Escape');
        await expect(p.getByRole('button', { name: 'Compile options', exact: true })).toBeFocused();

        await replaceEditorText(p, `${source}\n% pending edit\n`); await capture('stale');
        await replaceEditorText(p, source.replace('\\begin{document}', '\\begin{document}\n\\undefinedauthoringcommand'));
        await p.getByTestId('compile-btn').click();
        await expect(p.getByTestId('compile-failure')).toBeVisible({ timeout: 90_000 });
        await capture('error');
        await replaceEditorText(p, source);
        await p.getByTestId('compile-btn').click();
        await expect(p.getByTestId('compile-btn')).toHaveText('Recompile', { timeout: 90_000 });
        const retryLog = await p.evaluate(() => (window as any).__p2p.session.result?.log ?? 'No build result');
        await info.attach(`${theme}-retry.log`, { body: retryLog, contentType: 'text/plain' });
        await expect(p.getByTestId('compile-failure'), retryLog).toHaveCount(0);
        await p.getByTestId('pause-sync').click(); await capture('offline');
        await p.getByTestId('pause-sync').click();
        const other = await newUser(guest, 'research-coauthor-', { realCompiler: true });
        await joinProject(other.page, slug); await other.page.getByRole('treeitem', { name: 'main.tex' }).click();
        await other.page.locator('.cm-content').click();
        await expect(p.getByTestId('peer-count')).toContainText('1 co-author');
        await capture('collaborating');

        for (const zoom of [1.25, 1.5]) {
          await p.setViewportSize(sizes[2]!);
          await p.getByRole('button', { name: 'Editor', exact: true }).click();
          await p.evaluate((zoom) => { document.documentElement.style.zoom = String(zoom); }, zoom);
          await expect(p.getByTestId('compile-btn')).toBeInViewport();
          await expect(p.getByRole('group', { name: 'Show', exact: true })).toBeInViewport();
          expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
          await p.screenshot({ path: info.outputPath(`${theme}-zoom-${zoom}.png`), animations: 'disabled' });
        }
        await p.evaluate(() => { document.documentElement.style.zoom = ''; });
      } finally { packages.resume(); await ctx.close(); await guest.close(); }
    }
    const html = `<!doctype html><meta charset="utf-8"><title>HiveTeX authoring review</title><style>body{font:14px system-ui;background:#e8eaee;margin:20px}main{display:grid;grid-template-columns:repeat(3,420px);gap:12px}figure{margin:0;background:white;padding:6px}img{width:100%}figcaption{padding:6px}</style><h1>HiveTeX — real LaTeX authoring review</h1><p>Chromium ${browser.version()} · ${process.platform} · Node ${process.version}</p><main>${captures.map((c) => `<figure><img src="data:image/png;base64,${c.data}"><figcaption>${c.label}</figcaption></figure>`).join('')}</main>`;
    writeFileSync(info.outputPath('contact-sheet.html'), html);
    const sheet = await browser.newPage({ viewport: { width: 1348, height: 900 } });
    await sheet.setContent(html); await sheet.locator('img').evaluateAll(async (images) => { await Promise.all(images.map((img) => (img as HTMLImageElement).decode())); });
    await sheet.screenshot({ path: info.outputPath('contact-sheet.png'), fullPage: true });
    if (process.env.AUTHORING_REVIEW_EXPORT) {
      mkdirSync('docs/images', { recursive: true });
      await sheet.screenshot({ path: join('docs/images', 'authoring-review.png'), fullPage: true });
    }
    await sheet.close();
    await info.attach('review-environment.json', { body: JSON.stringify({ browser: browser.version(), platform: process.platform, node: process.version, fonts: ['IBM Plex Sans 5.3.0', 'JetBrains Mono 5.3.0', 'STIX Two Text 5.3.0'] }, null, 2), contentType: 'application/json' });
  } finally { await packages.close(); }
});
