import { writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { expect, type Page } from '@playwright/test';
import { test } from './trace-fixture.js';
import { joinProject, newUser } from './helpers.js';
import { articleProject, realCompilerContext } from './real-workspace.js';
import { texFixture } from './tex-fixture.js';
import { manuscript } from './fixtures/manuscript.js';
import { pdfText } from './fixtures/compile-templates.js';
import { aligned, scrollToLine, type EditorHost } from './editor-geometry.js';

const source = (page: Page) => page.evaluate(() => (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor.state.doc.toString());
const edit = (page: Page, from: number, to: number, insert: string) => page.evaluate(({ from, to, insert }) => {
  const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
  view.dispatch({ changes: { from, to, insert } });
}, { from, to, insert });

test('long real manuscript remains responsive through collaboration, offline merge and build recovery', async ({ browser }, info) => {
  test.setTimeout(480_000);
  const packages = await texFixture({ pinned: true });
  const owner = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await realCompilerContext(owner, packages.url); await realCompilerContext(guest, packages.url);
    const { page: a } = await newUser(owner, 'stress-owner', { realCompiler: true });
    const slug = await articleProject(a, 'stress-');
    const original = manuscript();
    await edit(a, 0, (await source(a)).length, original);
    await a.getByTestId('share-btn').click();
    await a.getByLabel('Default role for new members').selectOption('editor');
    await a.getByRole('button', { name: 'Save', exact: true }).click(); await a.keyboard.press('Escape');
    const { page: b } = await newUser(guest, 'stress-guest', { realCompiler: true });
    await joinProject(b, slug); await b.getByRole('treeitem', { name: 'main.tex' }).click();
    await expect.poll(() => source(b)).toBe(original);
    expect(await a.evaluate(() => localStorage.getItem('hivetex.fakeEngine'))).toBeNull();
    await a.getByTestId('compile-btn').click();
    await expect(a.getByTestId('build-status')).toContainText('PDF up to date', { timeout: 180_000 });
    await expect(a.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();
    const pageCount = await a.locator('[data-page]').count();
    expect(pageCount).toBeGreaterThan(100);
    const pdf = await a.evaluate(() => Array.from((window as any).__p2p.session.pdf as Uint8Array));
    expect(await pdfText(new Uint8Array(pdf))).toContain('Observation 6199');

    // Each sample ends after a frame has had an opportunity to paint the input and distant scroll.
    // Zoom invalidates PDF canvases concurrently; the editor remains the focused interaction surface.
    const samples: number[] = [];
    for (let batch = 0; batch < 4; batch++) {
      await a.emulateMedia({ colorScheme: batch % 2 ? 'dark' : 'light' });
      await a.setViewportSize({ width: batch % 2 ? 1180 : 1440, height: 900 });
      await a.getByRole('button', { name: batch % 2 ? 'Zoom out' : 'Zoom in', exact: true }).click();
      const measured = await a.evaluate(async (batch) => {
        const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
        const timings = [];
        view.focus();
        for (let n = 0; n < 15; n++) {
          const start = performance.now();
          const at = view.state.doc.line(1900 + n * 17).from;
          view.dispatch({ changes: { from: at, insert: `% timing ${batch}:${n}\n` }, selection: { anchor: at }, scrollIntoView: true });
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          timings.push(performance.now() - start);
        }
        return timings;
      }, batch);
      samples.push(...measured.slice(batch === 0 ? 5 : 0));
      await aligned(a);
      await expect(a.locator('[data-rendered="true"] canvas').first()).toBeVisible();
      expect(await a.locator('[data-testid="pdf-scroll"] canvas').count()).toBeLessThanOrEqual(6);
    }
    const sorted = [...samples].sort((a, b) => a - b), p95 = sorted[Math.ceil(sorted.length * .95) - 1]!;
    const metrics = { samples, p95, pageCount, targetMs: 100, limitMs: 250, browser: browser.version(), node: process.version,
      platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCPUs: cpus().length };
    await writeFile(info.outputPath('interaction.json'), JSON.stringify(metrics, null, 2));
    await info.attach('interaction.json', { body: JSON.stringify(metrics), contentType: 'application/json' });
    expect(p95, 'dedicated reference-runner interaction budget').toBeLessThanOrEqual(250);
    const beforeUndo = await source(a);
    // End the synthetic input burst's 500 ms Yjs capture group before a separate user edit.
    await a.waitForTimeout(600);
    await a.keyboard.insertText('LOCAL UNDO MARKER'); await a.keyboard.press('Control+z');
    await expect.poll(() => source(a)).toBe(beforeUndo);
    await expect.poll(() => source(b)).toBe(beforeUndo);

    await a.getByTestId('pause-sync').click(); await b.getByTestId('pause-sync').click();
    await expect(a.getByTestId('peer-count')).toContainText('No co-authors');
    await expect(b.getByTestId('peer-count')).toContainText('No co-authors');
    await edit(a, 0, 0, '% owner offline\n');
    const end = (await source(b)).length; await edit(b, end, end, '\n% guest offline');
    expect(await source(a)).not.toContain('guest offline');
    await a.getByTestId('pause-sync').click(); await b.getByTestId('pause-sync').click();
    const merged = `% owner offline\n${beforeUndo}\n% guest offline`;
    for (const p of [a, b]) await expect.poll(() => source(p), { timeout: 30_000 }).toBe(merged);
    await scrollToLine(a, 6100); await aligned(a); await aligned(b);

    // A real TeX error keeps the accepted bytes, then explicit correction produces current output.
    const badAt = merged.indexOf('\\begin{document}') + '\\begin{document}'.length;
    const bad = '\n\\undefinedstresscommand\n'; await edit(a, badAt, badAt, bad);
    await a.getByTestId('compile-btn').click();
    await expect(a.getByTestId('compile-failure')).toBeVisible({ timeout: 120_000 });
    expect(await a.evaluate(() => Array.from((window as any).__p2p.session.pdf as Uint8Array))).toEqual(pdf);
    await edit(a, badAt, badAt + bad.length, '');
    await a.getByTestId('compile-btn').click();
    await expect(a.getByTestId('build-status')).toContainText('PDF up to date', { timeout: 180_000 });
    await expect(a.getByTestId('compile-failure')).toBeHidden();
    await expect.poll(() => source(b)).toBe(merged);
    await aligned(a);
    await expect(a.locator('[data-rendered="true"] canvas').first()).toBeVisible();
    await a.screenshot({ path: info.outputPath('stress-complete.png') });
  } finally {
    await owner.close(); await guest.close(); await packages.close();
  }
});
