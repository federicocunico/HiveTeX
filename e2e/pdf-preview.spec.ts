import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, newUser, uniq } from './helpers.js';
import { longPdf } from './fixtures/long-pdf.js';

test('100-page preview preserves reading location and focus through zoom, output and viewport resize', async ({ browser }, info) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const { page } = await newUser(context, 'preview');
    await createProject(page, uniq('preview-')); await addFile(page, 'main.tex');
    await page.getByRole('treeitem', { name: 'main.tex' }).click();
    await expect(page.getByTestId('compiled-by')).toBeVisible();
    await page.getByRole('button', { name: 'Compile options', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Manual/ }).click();
    const show = () => page.evaluate((bytes) => {
      const s = (window as unknown as { __p2p: { session: { pdf: Uint8Array; pdfRev: number; syncIndex: unknown } } }).__p2p.session;
      s.syncIndex = null; s.pdf = new Uint8Array(bytes); s.pdfRev++;
    }, longPdf());
    await show();
    await expect(page.locator('.page-wrap')).toHaveCount(100);
    const scrollTo = (n: number, fraction = 0) => page.getByTestId('pdf-scroll').evaluate((scroll, { n, fraction }) => {
      const wrap = scroll.querySelector<HTMLElement>(`[data-page="${n}"]`)!;
      scroll.scrollTop = wrap.offsetTop + wrap.offsetHeight * fraction;
    }, { n, fraction });
    await scrollTo(50, 0.35);
    const target = page.locator('.page-wrap[data-page="50"]');
    await expect(target).toHaveAttribute('data-rendered', 'true');
    expect(await page.locator('[data-testid=pdf-scroll] canvas').count()).toBeLessThanOrEqual(6);
    const anchor = () => page.getByTestId('pdf-scroll').evaluate((scroll) => {
      const wrap = scroll.querySelector<HTMLElement>('[data-page="50"]')!;
      return (scroll.scrollTop - wrap.offsetTop) / wrap.offsetHeight;
    });
    expect(await anchor()).toBeCloseTo(0.35, 2);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(target).toHaveAttribute('data-rendered', 'true');
    expect(await anchor()).toBeCloseTo(0.35, 2);
    await page.locator('.cm-content').focus();
    await show();
    await expect(target).toHaveAttribute('data-rendered', 'true');
    expect(await anchor()).toBeCloseTo(0.35, 2);
    await expect(page.locator('.cm-content')).toBeFocused();
    for (const n of [98, 4, 75, 51]) {
      await scrollTo(n);
      await expect(page.locator(`.page-wrap[data-page="${n}"]`)).toHaveAttribute('data-rendered', 'true');
      expect(await page.locator('[data-testid=pdf-scroll] canvas').count()).toBeLessThanOrEqual(6);
    }
    const landscape = await page.locator('.page-wrap[data-page="51"] canvas').boundingBox();
    expect(landscape!.width).toBeGreaterThan(landscape!.height);

    await page.setViewportSize({ width: 1440, height: 500 });
    for (let n = 0; n < 8; n++) await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await expect(page.locator('.page-wrap')).toHaveCount(100);
    await scrollTo(1);
    await expect(page.locator('.page-wrap[data-page="1"]')).toHaveAttribute('data-rendered', 'true');
    await expect(page.locator('.page-wrap[data-page="2"]')).toHaveAttribute('data-rendered', 'true');
    const third = page.locator('.page-wrap[data-page="3"]');
    await expect(third).not.toHaveAttribute('data-rendered', 'true');
    await page.locator('.cm-content').focus();
    // Expose a page outside the old neighbor window without sending a scroll event.
    await page.setViewportSize({ width: 1440, height: 1400 });
    await expect(third).toHaveAttribute('data-rendered', 'true');
    await expect(page.locator('.cm-content')).toBeFocused();
    expect(await page.locator('[data-testid=pdf-scroll] canvas').count()).toBeLessThanOrEqual(6);
    await page.screenshot({ path: info.outputPath('long-preview.png') });
  } finally { await context.close(); }
});
