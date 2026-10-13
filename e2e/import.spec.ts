import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { type Page, expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { PROJECT_PW, addFile, createProject, joinProject, newUser, openNewProject, uniq } from './helpers.js';

const DOC = (pre = '') => `\\documentclass{article}\n${pre}\\begin{document}\n\\input{sections/intro}\n\\end{document}\n`;

/** Minimal ustar writer for fixtures. */
function tar(entries: Record<string, Uint8Array>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.fill(32, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(h, Buffer.from(data), Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const zipFile = (name: string, files: Record<string, string | Uint8Array>) => ({
  name,
  mimeType: 'application/zip',
  buffer: Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])))),
});

const fileIn = (page: Page, path: string) => page.locator(`[data-testid=file-tree] [title="${path}"]`);
const settings = (page: Page, key: string) =>
  page.evaluate((k) => (window as unknown as { __p2p: { session: { model: { settings: { get(k: string): unknown } } } } }).__p2p.session.model.settings.get(k), key);
const textOf = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    const s = (window as unknown as { __p2p: { session: { model: { find(p: string): { id: string } | undefined; openText(id: string): Promise<{ toString(): string }> } } } }).__p2p.session;
    const f = s.model.find(p);
    return f ? (await s.model.openText(f.id)).toString() : null;
  }, path);

test('create a project from an Overleaf zip; co-author sees the files; viewers cannot import', async ({ browser }) => {
  let slug = uniq('imp-');
  const ownerCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const owner = await newUser(ownerCtx, 'ima');
  const page = owner.page;

  await openNewProject(page);
  await page.getByTestId('create-archive').setInputFiles(
    zipFile('overleaf.zip', {
      'paper.tex': DOC('\\usepackage{fontspec}\n'),
      'sections/intro.tex': '\\section{Intro}',
      'figures/a.png': new Uint8Array([137, 80, 78, 71, 1]),
      'paper.aux': 'junk',
      'paper.log': 'junk',
    }),
  );
  slug = await createProject(page, slug);
  await expect(page.getByTestId('import-summary')).toContainText('Imported 3 new files');
  await page.getByTestId('skipped-summary').click();
  await expect(page.getByTestId('import-dialog')).toContainText('LaTeX build artifact');
  await page.getByTestId('import-done').click();

  await expect(fileIn(page, 'paper.tex').locator('xpath=..').getByTestId('main-badge')).toBeVisible();
  await expect(fileIn(page, 'sections/intro.tex')).toBeVisible();
  await expect(fileIn(page, 'figures/a.png')).toBeVisible();
  await expect(fileIn(page, 'paper.aux')).toHaveCount(0);
  expect(await settings(page, 'main')).toBe('paper.tex');
  expect(await settings(page, 'engine')).toBe('xelatex');

  const guest = await newUser(guestCtx, 'imb');
  await guest.page.goto('/#/');
  await joinProject(guest.page, slug, PROJECT_PW);
  await expect(guest.page.getByTestId('role-pill')).toHaveText('viewer');
  await expect(fileIn(guest.page, 'sections/intro.tex')).toBeVisible();
  await expect(fileIn(guest.page, 'figures/a.png')).toBeVisible();
  await expect(guest.page.getByTestId('import-btn')).toHaveCount(0);
  await expect(guest.page.getByRole('button', { name: 'Upload files' })).toHaveCount(0);
  await ownerCtx.close();
  await guestCtx.close();
});

test('import an arXiv tarball into an existing project: keep existing, legacy encoding converted', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'imc');
  await createProject(page, uniq('imp-'));
  await addFile(page, 'main.tex');
  expect(await textOf(page, 'main.tex')).toContain('Hello!');

  const latin1 = Buffer.concat([Buffer.from('Questo perch'), Buffer.from([0xe9]), Buffer.from(' funziona\n')]);
  const tgz = gzipSync(tar({ 'main.tex': strToU8(DOC()), 'refs.bib': strToU8('@misc{k,}'), 'old.tex': latin1 }));
  await page.getByTestId('import-btn').click();
  await page.getByTestId('import-input').setInputFiles({ name: '2401.00001.tar.gz', mimeType: 'application/gzip', buffer: tgz });
  await expect(page.getByTestId('count-changed')).toHaveText('1 changed');
  await expect(page.getByTestId('count-added')).toHaveText('2 new');
  await page.getByLabel('Resolution for main.tex').selectOption('keep');
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-summary')).toContainText('kept 1 existing');
  await expect(page.getByTestId('converted-list')).toContainText('old.tex');
  await page.getByTestId('import-done').click();

  expect(await textOf(page, 'main.tex')).toContain('Hello!');
  expect(await textOf(page, 'old.tex')).toContain('perché');
  await expect(fileIn(page, 'refs.bib')).toBeVisible();
  await ctx.close();
});

test('replace project contents', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'imd');
  await createProject(page, uniq('imp-'));
  await addFile(page, 'old.tex');
  await page.getByTestId('import-btn').click();
  await page.getByTestId('import-input').setInputFiles(zipFile('new.zip', { 'main.tex': DOC() }));
  await page.getByTestId('mode-replace').check();
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-confirm')).toHaveText('Really replace everything?');
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-summary')).toContainText('deleted 1');
  await page.getByTestId('import-done').click();
  await expect(fileIn(page, 'old.tex')).toHaveCount(0);
  await expect(fileIn(page, 'main.tex')).toBeVisible();
  await ctx.close();
});

test('unsafe archive is refused and nothing changes', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'ime');
  await createProject(page, uniq('imp-'));
  await addFile(page, 'main.tex');
  await page.getByTestId('import-btn').click();
  await page.getByTestId('import-input').setInputFiles(zipFile('evil.zip', { 'ok.tex': 'x', '../../evil.tex': 'x' }));
  await expect(page.getByTestId('import-error')).toContainText('Unsafe path');
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(fileIn(page, 'ok.tex')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __p2p: { session: { files: unknown[] } } }).__p2p.session.files.length)).toBe(1);
  await ctx.close();
});

test('uploads: oversized file skipped, others added; existing name asks before overwrite; archive drop offers extract', async ({ browser }, info) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'imf');
  await createProject(page, uniq('imp-'));

  const video = info.outputPath('video.mp4');
  const figure = info.outputPath('figure.png');
  writeFileSync(video, Buffer.alloc(51 * 1024 * 1024));
  writeFileSync(figure, Buffer.from([137, 80, 78, 71, 1]));
  await page.getByTestId('upload-input').setInputFiles([video, figure]);
  // empty project: applied straight away, the summary lists what was skipped
  await expect(page.getByTestId('skipped-summary')).toHaveText('1 skipped');
  await page.getByTestId('import-done').click();
  await expect(fileIn(page, 'figure.png')).toBeVisible();
  await expect(fileIn(page, 'video.mp4')).toHaveCount(0);

  // same name, different content: preview with a conflict
  await page.getByTestId('upload-input').setInputFiles({ name: 'figure.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 2]) });
  await expect(page.getByTestId('conflicts')).toContainText('figure.png');
  await page.getByTestId('overwrite-all').click();
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-summary')).toContainText('overwrote 1');
  await page.getByTestId('import-done').click();

  // a single archive: choose to extract
  await page.getByTestId('upload-input').setInputFiles(zipFile('bits.zip', { 'chap/one.tex': 'one', 'notes.txt': 'n' }));
  await page.getByTestId('archive-extract').click();
  await expect(page.getByTestId('count-added')).toHaveText('2 new');
  await page.getByTestId('import-confirm').click();
  await page.getByTestId('import-done').click();
  await expect(fileIn(page, 'chap/one.tex')).toBeVisible();
  await ctx.close();
});
