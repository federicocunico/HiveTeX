import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, newUser, replaceEditorText, uniq } from './helpers.js';

const fixture = (n: string) => readFileSync(resolve(process.cwd(), 'e2e', n)).toString('base64');

test('double-clicking the PDF jumps to the source line; forward search highlights the PDF (8.7)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const u = await newUser(ctx, 'sync');
  const page = u.page;
  await createProject(page, uniq('synctex-'));
  await addFile(page, 'main.tex');
  await page.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(page, 'a\nb\nFirst paragraph of the main file on line three.\n');
  await addFile(page, 'sections/body.tex');
  await page.getByRole('treeitem', { name: 'body.tex' }).click();
  await replaceEditorText(page, '\\section{Body}\nBody text line two, in the included file.\n');
  await page.getByRole('treeitem', { name: 'main.tex' }).click();

  // let the automatic (fake-engine) build finish first so it cannot overwrite what we install below
  await expect(page.getByTestId('compiled-by')).toBeVisible();
  await expect(page.getByTestId('stale-badge')).toBeHidden();

  // install a real pdfTeX output (with its .synctex.gz) as the displayed PDF
  await page.evaluate(
    async ([pdfB64, syncB64]) => {
      const dec = (b: string) => Uint8Array.from(atob(b as string), (c) => c.charCodeAt(0));
      const w = window as unknown as { __p2p: { session: { pdf: Uint8Array; pdfRev: number; syncIndex: unknown }; compile: { parseSyncTeXGz(b: Uint8Array): Promise<unknown> } } };
      w.__p2p.session.syncIndex = await w.__p2p.compile.parseSyncTeXGz(dec(syncB64 as string));
      w.__p2p.session.pdf = dec(pdfB64 as string);
      w.__p2p.session.pdfRev++;
    },
    [fixture('sample.pdf'), fixture('sample.synctex.gz')],
  );
  const canvas = page.locator('[data-testid=pdf-scroll] canvas').first();
  await expect(canvas).toBeVisible();

  // where does main.tex:3 live on the page? (computed by the same SyncTeX index)
  const pos = await page.evaluate(() => {
    const w = window as unknown as { __p2p: { session: { syncIndex: unknown }; compile: { forwardSearch(i: unknown, f: string, l: number): { page: number; x: number; y: number; w: number; h: number } | null } } };
    return w.__p2p.compile.forwardSearch(w.__p2p.session.syncIndex, 'main.tex', 3);
  });
  expect(pos?.page).toBe(1);
  const pageWidth = await canvas.evaluate((el) => Number.parseFloat(el.style.width) / 1.2);
  for (const scale of [1.2, 1.3, 1.4]) {
    if (scale > 1.2) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect(page.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();
    await expect.poll(async () => Math.abs(await canvas.evaluate((el) => Number.parseFloat(el.style.width)) - pageWidth * scale)).toBeLessThan(0.01);
    const box = (await canvas.boundingBox())!;
    await page.mouse.dblclick(box.x + (pos!.x + 20) * scale, box.y + (pos!.y + pos!.h / 2) * scale);
    await expect(page.locator('.cm-activeLine')).toContainText('First paragraph of the main file');
  }
  const zoom = 1.4;
  const box = (await canvas.boundingBox())!;

  // reverse into the included file (second page text lives in sections/body.tex)
  const pos2 = await page.evaluate(() => {
    const w = window as unknown as { __p2p: { session: { syncIndex: unknown }; compile: { forwardSearch(i: unknown, f: string, l: number): { page: number; x: number; y: number; w: number; h: number } | null } } };
    return w.__p2p.compile.forwardSearch(w.__p2p.session.syncIndex, 'sections/body.tex', 2);
  });
  expect(pos2?.page).toBe(1);
  await page.mouse.dblclick(box.x + ((pos2 as { x: number }).x + 20) * zoom, box.y + ((pos2 as { y: number; h: number }).y + (pos2 as { h: number }).h / 2) * zoom);
  await expect(page.locator('.cm-activeLine')).toContainText('Body text line two');

  // forward search: Ctrl+Alt+J in the editor highlights the matching spot in the PDF
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('Control+Alt+j');
  await expect(page.locator('.pdf-scroll .hl')).toHaveCount(1);
  await expect(page.locator('.cm-content')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
  const highlight = page.locator('.pdf-scroll .hl');
  await expect.poll(async () => Math.abs(await highlight.evaluate((el) => Number.parseFloat((el as HTMLElement).style.left)) - (pos2!.x * zoom - 2))).toBeLessThan(0.01);

  // Removing the map disables both directions, and removes old highlighting.
  await page.evaluate(() => { (window as any).__p2p.session.syncIndex = null; });
  await expect(highlight).toHaveCount(0);
  await page.keyboard.press('Control+Alt+j');
  await expect(highlight).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('Show this line in the PDF');
  await expect(page.getByTestId('palette').getByRole('option', { name: /Show this line/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const before = await page.getByTestId('cursor-pos').innerText();
  const now = (await canvas.boundingBox())!;
  await page.mouse.dblclick(now.x + (pos!.x + 20) * zoom, now.y + (pos!.y + pos!.h / 2) * zoom);
  await expect(page.getByTestId('cursor-pos')).toHaveText(before);
  await ctx.close();
});
