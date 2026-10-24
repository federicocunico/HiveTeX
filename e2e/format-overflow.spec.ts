import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, newUser, replaceEditorText, uniq } from './helpers.js';

const order = ['Bold', 'Italic', 'Bulleted list', 'Numbered list', 'Inline math', 'Equation', 'Symbol', 'Figure', 'Table', 'Citation', 'Cross-reference'];

test('formatting overflow preserves order, selection, keyboard reachability and resize focus', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const { page: p } = await newUser(ctx, 'overflow');
    await createProject(p, uniq('overflow-')); await addFile(p, 'main.tex');
    await p.getByRole('treeitem', { name: 'main.tex' }).click();
    await replaceEditorText(p, 'selected');
    const bar = p.getByRole('toolbar', { name: 'Formatting' });
    const split = p.getByRole('separator', { name: 'Resize editor and PDF' });
    await split.focus(); await p.keyboard.press('Home');
    const more = bar.getByRole('button', { name: 'More formatting', exact: true });
    await expect(more).toBeVisible();
    // All actions appear exactly once, as a prefix in the toolbar and suffix in its menu.
    const visible = (await bar.getByRole('button').all()).length;
    expect(visible).toBeLessThan(order.length + 2);
    const prefix = await bar.locator('button[data-testid^="fmt-"]:not([data-testid="fmt-section"]):not([data-testid="fmt-more"])').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    await more.focus(); await p.keyboard.press('ArrowDown');
    const menu = p.getByRole('menu', { name: 'More formatting' });
    const suffix = await menu.getByRole('menuitem').allTextContents();
    expect([...prefix, ...suffix.map((s) => s.trim())]).toEqual(order);
    await p.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: 'Cross-reference', exact: true })).toBeFocused();
    await p.keyboard.press('Escape'); await expect(more).toBeFocused();

    await p.locator('.cm-content').focus(); await p.keyboard.press('Control+a');
    await more.focus(); await p.keyboard.press('ArrowDown');
    // The narrow pane moves Inline math to the menu. Keyboard execution wraps the original selection.
    const math = menu.getByRole('menuitem', { name: 'Inline math', exact: true });
    await expect(math).toBeVisible(); await math.focus(); await p.keyboard.press('Enter');
    await expect(p.locator('.cm-content')).toHaveText('$selected$');
    await expect(p.locator('.cm-content')).toBeFocused();
    await p.keyboard.press('Control+z'); await expect(p.locator('.cm-content')).toHaveText('selected');

    await more.focus();
    await p.setViewportSize({ width: 3000, height: 900 });
    await expect(more).toHaveCount(0);
    await expect(bar.getByRole('button', { name: 'Insert a heading' })).toBeFocused();
    expect(await bar.locator('button[data-testid^="fmt-"]:not([data-testid="fmt-section"])').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(order);
    for (const width of [1440, 1280]) {
      await p.setViewportSize({ width, height: 900 });
      await expect(more).toBeVisible();
      expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
  } finally { await ctx.close(); }
});
