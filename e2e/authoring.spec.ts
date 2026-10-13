import { type Page, expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, joinProject, newUser, replaceEditorText, uniq } from './helpers.js';

const editor = (p: Page) => p.locator('.cm-content');

/** Selects `word` in the editor by searching for it on the first line. */
async function selectWord(p: Page, word: string) {
  const text = await editor(p).innerText();
  const at = text.indexOf(word);
  await editor(p).click();
  await p.keyboard.press('Control+Home');
  for (let i = 0; i < at; i++) await p.keyboard.press('ArrowRight');
  for (let i = 0; i < word.length; i++) await p.keyboard.press('Shift+ArrowRight');
}

test('toolbar: Bold wraps the selection and syncs; Ctrl+I italicises; viewers get no toolbar', async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const o = await newUser(ownerCtx, 'fmt');
  let slug = uniq('fmt-');
  slug = await createProject(o.page, slug);
  await addFile(o.page, 'main.tex');
  await o.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(o.page, 'a graph model');
  await expect(o.page.getByTestId('format-toolbar')).toBeVisible();

  const guestCtx = await browser.newContext();
  const g = await newUser(guestCtx, 'fmtv');
  await joinProject(g.page, slug);
  await g.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(editor(g.page)).toContainText('a graph model', { timeout: 30_000 });
  await expect(g.page.getByTestId('format-toolbar')).toHaveCount(0);

  await selectWord(o.page, 'graph');
  await o.page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' }).click();
  await expect(editor(o.page)).toContainText('a \\textbf{graph} model');
  // (the co-author sees the owner's cursor label inside the text, hence the pattern)
  await expect(editor(g.page)).toContainText(/a \\textbf\{graph[^}]*\} model/, { timeout: 30_000 });

  await selectWord(o.page, 'model');
  await o.page.keyboard.press('Control+I');
  await expect(editor(o.page)).toContainText('\\textit{model}');
  // Ctrl+B in the editor formats; it never toggles a panel
  await expect(o.page.getByTestId('file-tree')).toBeVisible();
  await ownerCtx.close();
  await guestCtx.close();
});

test('outline: follows the document, updates live when a co-author adds a section, and jumps on click', async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const o = await newUser(ownerCtx, 'out');
  let slug = uniq('out-');
  slug = await createProject(o.page, slug);
  await o.page.getByTestId('settings-btn').click();
  await o.page.getByLabel('Default role').selectOption('editor');
  await o.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(o.page.getByText('Saved', { exact: true })).toBeVisible();
  await o.page.getByRole('button', { name: 'Close' }).click();
  await addFile(o.page, 'main.tex');
  await o.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(o.page, '\\section{Introduction}\nText.\n\\subsection{Background}\nMore.\n');
  await o.page.getByTestId('rail-outline').click();
  const panel = o.page.getByTestId('outline-panel');
  await expect(panel.getByRole('button')).toHaveText(['1 Introduction', '1.1 Background'], { timeout: 10_000 });

  const guestCtx = await browser.newContext();
  const g = await newUser(guestCtx, 'outg');
  await joinProject(g.page, slug);
  await g.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await g.page.locator('.cm-content').click();
  await g.page.keyboard.press('Control+End');
  await g.page.keyboard.type('\\section{Discussion}\nFinal words.');
  await expect(panel.getByRole('button', { name: /2 Discussion/ })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('button', { name: /1\.1 Background/ }).click();
  await expect(o.page.getByTestId('cursor-pos')).toContainText('Ln 3');
  await expect(panel.getByRole('button', { name: /1\.1 Background/ })).toHaveAttribute('aria-current', 'location');
  await ownerCtx.close();
  await guestCtx.close();
});

test('compile help: a missing package is explained and fixed in one click; Undo removes the fix', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page: p } = await newUser(ctx, 'help');
  await createProject(p, uniq('help-'));
  await addFile(p, 'main.tex');
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(p, '\\documentclass{article}\n\\begin{document}\nRecent work \\citep{jumper21}.\n\\end{document}');
  await p.getByRole('button', { name: 'Recompile' }).click();
  const problems = p.getByTestId('diagnostics');
  await expect(problems).toContainText('Undefined control sequence', { timeout: 30_000 });
  await expect(problems.getByTestId('problem-help')).toContainText('\\citep comes from the natbib package');
  await problems.getByRole('button', { name: 'Go to line' }).click();
  await expect(p.getByTestId('cursor-pos')).toContainText('Ln 3');

  await problems.getByTestId('problem-fix').click();
  await expect(editor(p)).toContainText('\\usepackage{natbib}\\begin{document}');
  await p.locator('.cm-content').click();
  await p.keyboard.press('Control+Z');
  await expect(editor(p)).not.toContainText('natbib');
  // with natbib back, the compile succeeds and the problem goes away
  await problems.getByTestId('problem-fix').click();
  await p.getByRole('button', { name: 'Recompile' }).click();
  await expect(problems).toHaveCount(0, { timeout: 30_000 });
  await ctx.close();
});

test('insert pickers: a 3 × 4 table, a citation from the project .bib, a symbol by name', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page: p } = await newUser(ctx, 'ins');
  await createProject(p, uniq('ins-'));
  await addFile(p, 'refs.bib');
  await p.getByRole('treeitem', { name: 'refs.bib' }).click();
  await replaceEditorText(p, '@book{knuth84,\n  author = {Donald Knuth},\n  title = {The TeXbook},\n  year = {1984}\n}\n');
  await addFile(p, 'main.tex');
  await p.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(p, 'Text ');

  // table
  await p.getByTestId('fmt-table').click();
  const dlg = p.getByTestId('table-dialog');
  await dlg.getByLabel('Rows').fill('3');
  await dlg.getByLabel('Columns').fill('4');
  await dlg.getByRole('button', { name: 'Insert 3 × 4 table' }).click();
  await expect(editor(p)).toContainText('\\begin{tabular}{llll}');

  // citation (the index refreshes shortly after typing)
  await p.keyboard.press('Control+End');
  await p.getByTestId('fmt-cite').click();
  await expect(p.getByTestId('cite-picker').getByRole('option')).toHaveCount(1, { timeout: 15_000 });
  await expect(p.getByTestId('cite-picker')).toContainText('Donald Knuth');
  await p.keyboard.type('knuth');
  await p.keyboard.press('Enter');
  await expect(editor(p)).toContainText('\\cite{knuth84}');

  // symbol: outside math it is wrapped in $…$
  await p.keyboard.press('Control+End');
  await p.keyboard.press('Enter');
  await p.getByTestId('fmt-symbol').click();
  await p.getByLabel('Search symbols').fill('less or equal');
  await p.keyboard.press('Enter');
  await expect(editor(p)).toContainText('$\\leq$');

  // hiding the toolbar keeps the actions in the palette
  await p.getByRole('button', { name: 'Hide the formatting toolbar' }).click();
  await expect(p.getByTestId('format-toolbar')).toHaveCount(0);
  await p.keyboard.press('Control+K');
  await p.keyboard.type('insert figure');
  await expect(p.getByTestId('palette').getByRole('option', { name: /Insert figure/ })).toBeVisible();
  await p.keyboard.press('Enter');
  await expect(p.getByTestId('figure-picker')).toContainText('No images in this project yet');
  await ctx.close();
});
