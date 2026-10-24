import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test } from './trace-fixture.js';
import { addFile, createProject, joinProject, newUser, uniq } from './helpers.js';
import { aligned, geometry, scrollToLine, type EditorHost } from './editor-geometry.js';
import { manuscript } from './fixtures/manuscript.js';

for (const eol of ['\n', '\r\n'] as const) {
  test(`logical line geometry survives fonts, wrapping and distant scroll (${eol.length === 1 ? 'LF' : 'CRLF'})`, async ({ browser }, info) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const { page } = await newUser(ctx, 'geometry');
    await createProject(page, uniq('geometry-'));
    await addFile(page, 'main.tex');
    await page.getByRole('treeitem', { name: 'main.tex' }).click();
    await expect(page.locator('.cm-content')).toBeVisible();
    await page.evaluate((text) => {
      const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    }, manuscript(eol));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const measurements = [];
    for (const size of [11, 14, 18, 24]) {
      // Use the same cross-tab preference update path as a second application window.
      await page.evaluate((editorFontSize) => {
        const prefs = { ...JSON.parse(localStorage.getItem('hivetex.prefs') ?? '{}'), editorFontSize };
        const newValue = JSON.stringify(prefs);
        localStorage.setItem('hivetex.prefs', newValue);
        window.dispatchEvent(new StorageEvent('storage', { key: 'hivetex.prefs', newValue }));
      }, size);
      await page.emulateMedia({ colorScheme: size % 2 === 0 ? 'dark' : 'light' });
      await expect.poll(() => page.locator('.cm-content').evaluate((el) => getComputedStyle(el).fontSize)).toBe(`${size}px`);
      for (const width of [1440, 1180]) {
        await page.setViewportSize({ width, height: 900 });
        for (const line of [1, 1900, 6100]) {
          await scrollToLine(page, line);
          measurements.push({ size, width, line, ...await aligned(page) });
        }
      }
    }
    await info.attach('geometry.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
    await writeFile(info.outputPath('geometry.json'), JSON.stringify(measurements, null, 2));
    await page.screenshot({ path: info.outputPath('editor.png') });
    // Positive control: prove that our probe can see a real rendering defect.
    const style = await page.addStyleTag({ content: '.cm-lineNumbers .cm-gutterElement { transform: translateY(7px) !important; }' });
    expect((await page.evaluate(geometry)).maxDelta).toBeGreaterThan(5);
    await style.evaluate((el) => el.remove());
    await aligned(page);
    if (eol === '\r\n') {
      await scrollToLine(page, 1);
      // CodeMirror measures scroll requests asynchronously; the final distant row can still be mounted here.
      await expect.poll(async () => (await page.evaluate(geometry)).rows.some((row) => row.line === 2), { message: 'blank CRLF row is visible before the collapse control' }).toBe(true);
      await aligned(page);
      const collapsed = await page.addStyleTag({ content: '.cm-line { min-height: 0 !important; }' });
      await expect.poll(async () => (await page.evaluate(geometry)).collapsed.length, { message: 'detect CR-only blank rows even when gutter and source collapse together' }).toBeGreaterThan(0);
      await collapsed.evaluate((el) => el.remove());
      await aligned(page);
    }
    await ctx.close();
  });
}

test('remote edits preserve selection, copy, undo and logical numbering', async ({ browser }, info) => {
  const owner = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const guest = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page: a } = await newUser(owner, 'geomowner');
  const slug = await createProject(a, uniq('geompeer-'));
  await a.getByTestId('share-btn').click();
  await a.getByLabel('Default role for new members').selectOption('editor');
  await a.getByRole('button', { name: 'Save', exact: true }).click();
  await a.keyboard.press('Escape');
  await addFile(a, 'main.tex');
  await a.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(a.locator('.cm-content')).toBeVisible();
  const original = manuscript();
  await a.evaluate((text) => {
    const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, original);
  const { page: b } = await newUser(guest, 'geomguest');
  await joinProject(b, slug);
  await b.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect.poll(() => b.evaluate(() => (document.querySelector('[data-testid=editor]') as EditorHost)?.__hivetexEditor?.state.doc.lines)).toBe(6200);
  await scrollToLine(a, 1900);
  const selected = await a.evaluate(() => {
    const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
    const from = view.state.doc.line(1900).from, to = view.state.doc.line(1903).to;
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
    view.focus();
    return view.state.sliceDoc(from, to);
  });
  await b.evaluate(() => {
    const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
    view.dispatch({ changes: { from: 0, insert: '% remote one\n% remote two\n' } });
  });
  await expect.poll(() => a.evaluate(() => (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor.state.doc.lines)).toBe(6202);
  await aligned(a);
  expect((await a.evaluate(geometry)).selection).toBe(selected);
  await a.keyboard.press('Control+c');
  expect(await a.evaluate(() => navigator.clipboard.readText())).toBe(selected);
  await a.keyboard.press('ArrowRight');
  await a.keyboard.insertText(' LOCAL MARKER');
  await a.keyboard.press('Control+z');
  await a.keyboard.press('Control+Shift+z');
  await a.keyboard.press('Control+z');
  await b.evaluate(() => {
    const view = (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor;
    view.dispatch({ changes: { from: 0, to: '% remote one\n% remote two\n'.length } });
  });
  const text = () => a.evaluate(() => (document.querySelector('[data-testid=editor]') as EditorHost).__hivetexEditor.state.doc.toString());
  await expect.poll(text).toBe(original);
  await aligned(a);
  await info.attach('peer-geometry.json', { body: JSON.stringify(await a.evaluate(geometry)), contentType: 'application/json' });
  await addFile(a, 'other.tex');
  await a.getByRole('treeitem', { name: 'other.tex' }).click();
  await expect.poll(text).toBe('');
  await a.getByRole('treeitem', { name: /main.tex/ }).click();
  await expect.poll(text).toBe(original);
  await aligned(a);
  await owner.close();
  await guest.close();
});
