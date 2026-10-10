import { type Page, expect, test } from '@playwright/test';
import { addFile, createProject, joinProject, newUser, replaceEditorText, showFiles, typeInEditor, uniq } from './helpers.js';

async function owner(browser: import('@playwright/test').Browser, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const u = await newUser(ctx, 'ws');
  const slug = uniq('ws-');
  await createProject(u.page, slug);
  return { ctx, ...u, slug };
}

const header = (p: Page) => p.locator('.ws-head');

test('the header holds at most four actions besides More, and More holds the rest', async ({ browser }) => {
  const o = await owner(browser);
  const p = o.page;
  await expect(p.getByTestId('project-slug')).toHaveText(o.slug);
  await expect(p.getByTestId('role-pill')).toHaveText('owner');
  // Share, Recompile, compile options, Download PDF (+ the More menu and the back link)
  const buttons = header(p).getByRole('button');
  const names = await buttons.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim() ?? ''));
  const actions = names.filter((n) => n !== 'More actions');
  expect(actions.length, names.join(' | ')).toBeLessThanOrEqual(4);
  await p.getByRole('button', { name: 'More actions' }).click();
  for (const item of ['Import…', 'Download project (.zip)', 'History', 'Project settings']) await expect(p.getByRole('menuitem', { name: item })).toBeVisible();
  await p.keyboard.press('Escape');
  await expect(p.getByRole('menu')).toHaveCount(0);
  await expect(p.getByRole('button', { name: 'More actions' })).toBeFocused();
  await o.ctx.close();
});

test('rail: switch panels, collapse on re-click, and remember the choice', async ({ browser }) => {
  const o = await owner(browser);
  const p = o.page;
  await expect(p.getByTestId('file-tree')).toBeVisible();
  await p.getByTestId('rail-history').click();
  await expect(p.getByTestId('history-panel')).toBeVisible();
  await expect(p.getByTestId('rail-history')).toHaveAttribute('aria-pressed', 'true');
  await p.getByTestId('rail-history').click();
  await expect(p.getByTestId('history-panel')).toHaveCount(0);
  await expect(p.getByLabel('Side panel')).toHaveCount(0);
  // the choice is remembered for the next project
  await p.reload();
  await expect(p.getByTestId('workspace')).toBeVisible();
  await expect(p.getByLabel('Side panel')).toHaveCount(0);
  await showFiles(p);
  await expect(p.getByTestId('rail-files')).toHaveAttribute('aria-pressed', 'true');
  await o.ctx.close();
});

test('unseen changes from a co-author show on the Changes rail button until the panel is opened', async ({ browser }) => {
  const o = await owner(browser);
  const p = o.page;
  await p.getByTestId('settings-btn').click();
  await p.getByLabel('Default role').selectOption('editor');
  await p.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(p.getByText('Saved', { exact: true })).toBeVisible();
  await p.getByRole('button', { name: 'Close' }).click();
  await addFile(p, 'main.tex');

  const guestCtx = await browser.newContext();
  const g = await newUser(guestCtx, 'wsc');
  await joinProject(g.page, o.slug);
  await g.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(g.page, 'From the co-author.');
  await expect(p.getByTestId('changes-btn').locator('.badge')).toBeVisible({ timeout: 30_000 });
  await expect(p.getByTestId('changes-btn')).toHaveAccessibleName(/Changes, \d+ new/);
  await p.getByTestId('changes-btn').click();
  await expect(p.getByTestId('changes-panel')).toBeVisible();
  await expect(p.getByTestId('changes-btn').locator('.badge')).toHaveCount(0);
  await guestCtx.close();
  await o.ctx.close();
});

test('panes: keyboard resize, hide and show the PDF, focus mode restores the layout', async ({ browser }) => {
  const o = await owner(browser);
  const p = o.page;
  await addFile(p, 'main.tex');
  const split = p.getByRole('separator', { name: 'Resize editor and PDF' });
  const before = Number(await split.getAttribute('aria-valuenow'));
  await split.focus();
  await p.keyboard.press('ArrowLeft');
  await expect.poll(async () => Number(await split.getAttribute('aria-valuenow'))).toBeLessThan(before);
  const side = p.getByRole('separator', { name: 'Resize side panel' });
  const sideBefore = Number(await side.getAttribute('aria-valuenow'));
  await side.focus();
  await p.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await side.getAttribute('aria-valuenow'))).toBeGreaterThan(sideBefore);

  // hide the PDF: the editor takes the width and "Show PDF" stays visible
  await p.getByRole('button', { name: 'Hide PDF' }).click();
  await expect(p.getByTestId('pdf-pane')).toHaveCount(0);
  await expect(p.getByTestId('show-pdf')).toBeVisible();
  await p.getByTestId('show-pdf').click();
  await expect(p.getByTestId('pdf-pane')).toBeVisible();

  // focus mode hides the chrome and brings it back
  await p.getByTestId('focus-btn').click();
  await expect(p.getByRole('navigation', { name: 'Panels' })).toHaveCount(0);
  await expect(p.getByTestId('statusbar')).toHaveCount(0);
  await expect(p.getByTestId('editor')).toBeVisible();
  await p.getByRole('button', { name: 'Leave focus mode' }).first().click();
  await expect(p.getByRole('navigation', { name: 'Panels' })).toBeVisible();
  await expect(p.getByTestId('file-tree')).toBeVisible();
  await expect(p.getByTestId('statusbar')).toBeVisible();
  await o.ctx.close();
});

test('at 1024 px one of editor and PDF shows, with a toggle, and nothing overflows', async ({ browser }) => {
  const o = await owner(browser, { width: 1024, height: 700 });
  const p = o.page;
  await addFile(p, 'main.tex');
  // the side panel floats over the editor and gets out of the way once a file is picked
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(p.getByLabel('Side panel')).toHaveCount(0);
  await expect(p.getByRole('group', { name: 'Show' })).toBeVisible();
  await expect(p.getByTestId('editor')).toBeVisible();
  await expect(p.getByTestId('pdf-pane')).toHaveCount(0);
  await p.getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(p.getByTestId('pdf-pane')).toBeVisible();
  await expect(p.getByTestId('editor')).toHaveCount(0);
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await o.ctx.close();
});

test('a toast still showing never covers the buttons of a dialog opened after it', async ({ browser }) => {
  const o = await owner(browser, { width: 1024, height: 640 });
  const p = o.page;
  await addFile(p, 'main.tex');
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await p.getByRole('button', { name: 'Hide the formatting toolbar' }).click();
  await expect(p.locator('.hx-toaster .toast')).toBeVisible();
  // back to the projects page (same page, so the toast stays) and straight into New project
  await p.evaluate(() => (location.hash = '#/'));
  await p.getByTestId('new-project-btn').click();
  const dialog = p.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toBeVisible();
  await expect(p.locator('.hx-toaster .toast')).toBeVisible();
  const covered = await dialog.evaluate((d) => {
    const t = document.querySelector('.hx-toaster .toast')!.getBoundingClientRect();
    return [...d.querySelectorAll('button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.left < t.right && r.right > t.left && r.top < t.bottom && r.bottom > t.top;
      })
      .map((b) => b.textContent?.trim() || b.getAttribute('aria-label'));
  });
  expect(covered).toEqual([]);
  await o.ctx.close();
});

test('in a narrow PDF pane, "compiled by" moves to its own line instead of being squeezed out', async ({ browser }) => {
  const o = await owner(browser, { width: 1100, height: 700 });
  const p = o.page;
  await addFile(p, 'main.tex');
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await p.getByRole('button', { name: 'Recompile' }).click();
  const by = p.getByTestId('compiled-by');
  await expect(by).toBeVisible({ timeout: 30_000 });
  // the whole "compiled by <name> (this device)" fits, and the zoom controls stay on the bar too
  expect(await by.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.clientWidth > 0)).toBe(true);
  await expect(p.getByRole('button', { name: 'Zoom in' })).toBeVisible();
  await o.ctx.close();
});

test('a failing compile is listed under Problems, and Go to line moves the cursor there', async ({ browser }) => {
  const o = await owner(browser);
  const p = o.page;
  await addFile(p, 'main.tex');
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(p, '\\fail\nsecond line\nthird line');
  await p.getByRole('button', { name: 'Recompile' }).click();
  const problems = p.getByTestId('diagnostics');
  await expect(problems).toContainText('Undefined control sequence', { timeout: 30_000 });
  await expect(problems).toContainText('1 error');
  // move the cursor away, then jump back
  await p.locator('.cm-content').click();
  await p.keyboard.press('Control+End');
  await expect(p.getByTestId('cursor-pos')).toContainText('Ln 3');
  await problems.getByRole('button', { name: 'Go to line' }).first().click();
  await expect(p.getByTestId('cursor-pos')).toContainText('Ln 1');
  await o.ctx.close();
});

test('the status bar and PDF bar speak plainly', async ({ browser }) => {
  const o = await owner(browser);
  const p = o.page;
  await addFile(p, 'main.tex');
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(p.getByTestId('statusbar')).toContainText('Saved on this device');
  await expect(p.getByTestId('peer-count')).toHaveText('No co-authors online');
  await p.getByRole('button', { name: 'Recompile' }).click();
  await expect(p.getByTestId('compiled-by')).toBeVisible({ timeout: 30_000 });
  await expect(p.getByTestId('stale-badge')).toBeHidden();
  // Only co-authors may compile now (none is online), so the PDF stays outdated after typing.
  await p.getByTestId('compile-mode').selectOption('peers');
  await expect(p.getByTestId('no-peer-compiler')).toBeVisible();
  await typeInEditor(p, ' more');
  await expect(p.getByTestId('stale-badge')).toContainText(/Outdated: \d+ edits? since the last compile/);
  await o.ctx.close();
});

test('a selection is highlighted on every line it covers, including the line with the cursor (both themes)', async ({ browser }) => {
  const o = await owner(browser);
  const p = o.page;
  await addFile(p, 'sel.tex');
  await p.getByRole('treeitem', { name: 'sel.tex' }).click();
  await replaceEditorText(p, 'line one\nline two\nline three\nline four\nline five\nline six\nline seven\n');
  for (const scheme of ['light', 'dark'] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    // from the start of line 3 to the end of line 6, as a mouse drag or Shift+Down would select
    await p.locator('.cm-line', { hasText: 'line three' }).click({ position: { x: 1, y: 5 } });
    await p.keyboard.press('Home');
    for (let i = 0; i < 3; i++) await p.keyboard.press('Shift+ArrowDown');
    await p.keyboard.press('Shift+End');
    await expect(p.locator('.cm-activeLine')).toHaveCount(0);
    // the selection layer is drawn after a measure frame: wait for it
    await expect
      .poll(() =>
        p.evaluate(() => {
      const boxes = [...document.querySelectorAll('.cm-selectionBackground')].map((e) => e.getBoundingClientRect());
      const lines = [...document.querySelectorAll('.cm-line')].filter((l) => /line (three|four|five|six)/.test(l.textContent ?? ''));
      return lines.map((l) => {
        const r = l.getBoundingClientRect();
        const y = r.top + r.height / 2;
        const hit = boxes.some((b) => b.top <= y && b.bottom >= y && b.width > 4);
        // the line itself must not paint over the selection layer
        const bg = getComputedStyle(l).backgroundColor;
        return hit && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent');
      });
    }),
      )
      .toEqual([true, true, true, true]);
    // nothing selected: the current line is tinted again
    await p.keyboard.press('ArrowRight');
    await expect(p.locator('.cm-activeLine')).toHaveCount(1);
  }
  await o.ctx.close();
});
