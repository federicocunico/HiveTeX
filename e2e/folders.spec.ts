import { type Page, expect, test } from '@playwright/test';
import { PROJECT_PW, addFile, newUser, openNewProject, typeInEditor, uniq } from './helpers.js';

/**
 * Folder projects in the web app (Chromium, File System Access API). The folder picker is stubbed with a directory
 * of the origin-private file system, which has the same handle API as a folder picked on disk.
 */
async function stubPicker(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle(localStorage.getItem('e2e.pickDir') ?? 'picked', { create: true });
    };
  });
}

const pickNext = (page: Page, dir: string) => page.evaluate((d) => localStorage.setItem('e2e.pickDir', d), dir);

/** Writes a file into a test folder as an external program (Claude Code, Codex, an editor) would. */
const writeExternal = (page: Page, dir: string, path: string, text: string) =>
  page.evaluate(
    async ([d, p, t]) => {
      let h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d as string, { create: true });
      const parts = (p as string).split('/');
      for (const seg of parts.slice(0, -1)) h = await h.getDirectoryHandle(seg, { create: true });
      const w = await (await h.getFileHandle(parts.at(-1) as string, { create: true })).createWritable();
      await w.write(t as string);
      await w.close();
    },
    [dir, path, text],
  );

const readExternal = (page: Page, dir: string, path: string) =>
  page.evaluate(
    async ([d, p]) => {
      try {
        let h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d as string);
        const parts = (p as string).split('/');
        for (const seg of parts.slice(0, -1)) h = await h.getDirectoryHandle(seg);
        return await (await (await h.getFileHandle(parts.at(-1) as string)).getFile()).text();
      } catch {
        return null;
      }
    },
    [dir, path],
  );

test('web folders: create in a folder, external edits sync, reopen re-binds, stop using keeps the files', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'fld');
  await stubPicker(page);
  await page.reload();
  const dir = uniq('dir-');
  await pickNext(page, dir);

  const slug = uniq('fold-');
  await openNewProject(page);
  await page.getByPlaceholder('my-paper-2026').fill(slug);
  await page.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
  await page.getByTestId('create-in-folder').click();
  await expect(page.getByText(`In the folder “${dir}”`)).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByTestId('location-btn')).toContainText(dir);

  // project -> folder
  await addFile(page, 'main.tex');
  await page.getByRole('treeitem', { name: 'main.tex' }).click();
  await typeInEditor(page, 'Written in the app.');
  await expect.poll(() => readExternal(page, dir, 'main.tex'), { timeout: 10_000 }).toContain('Written in the app.');
  await expect.poll(async () => JSON.parse((await readExternal(page, dir, '.hivetex.json')) ?? '{}').project?.slug).toBe(slug);

  // folder -> project (an AI tool rewrites the file); no lock, no staging
  await writeExternal(page, dir, 'main.tex', 'Rewritten by the AI tool.\n');
  await expect(page.locator('.cm-content')).toContainText('Rewritten by the AI tool.', { timeout: 10_000 });

  // the projects page shows where the project lives; reopening binds the folder again
  await page.goto('/#/');
  await expect(page.locator('.item', { hasText: slug }).getByTestId('folder-badge')).toContainText(dir);
  await page.locator('.item', { hasText: slug }).click();
  await expect(page.getByTestId('location-btn')).toContainText(dir);
  await writeExternal(page, dir, 'notes.tex', 'New file from the folder\n');
  await expect(page.getByRole('treeitem', { name: 'notes.tex' })).toBeVisible({ timeout: 10_000 });

  // stop using the folder: the project stays, the files stay on disk
  await page.getByTestId('location-btn').click();
  await page.getByTestId('unlink-folder').click();
  await expect(page.getByTestId('location-btn')).toContainText('In the app');
  expect(await readExternal(page, dir, 'main.tex')).toContain('Rewritten by the AI tool.');
  await writeExternal(page, dir, 'main.tex', 'Not synced any more\n');
  await page.waitForTimeout(3000);
  await expect(page.locator('.cm-content')).not.toContainText('Not synced any more');
  await ctx.close();
});

test('web folders: "Open folder…" creates a project with the folder tree, and opens a known project folder', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'opf');
  await stubPicker(page);
  await page.reload();
  const dir = uniq('clone-');
  await writeExternal(page, dir, 'paper.tex', '% !TEX program = xelatex\n\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n');
  await writeExternal(page, dir, 'sections/intro.tex', 'Intro from the cloned repository.\n');
  await writeExternal(page, dir, '.git/HEAD', 'ref: refs/heads/main\n');

  await pickNext(page, dir);
  await page.getByTestId('open-folder').click();
  await expect(page.getByTestId('from-folder')).toBeVisible();
  const slug = uniq('from-');
  await page.getByTestId('from-folder-slug').fill(slug);
  await page.getByTestId('from-folder-password').fill(PROJECT_PW);
  await page.getByTestId('from-folder-create').click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'paper.tex' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('treeitem', { name: 'intro.tex' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'HEAD' })).toHaveCount(0); // tool folders stay out
  await expect(page.getByRole('status').filter({ hasText: 'Main document: paper.tex' })).toBeVisible();
  const settings = await page.evaluate(() => {
    const s = (window as unknown as { __p2p: { session: { model: { settings: { toJSON(): Record<string, unknown> } } } } }).__p2p.session;
    return s.model.settings.toJSON();
  });
  expect(settings).toMatchObject({ main: 'paper.tex', engine: 'xelatex' });

  // forget the location on this device, then open the folder again: its marker names the project
  await page.getByTestId('location-btn').click();
  await page.getByTestId('unlink-folder').click();
  await page.goto('/#/');
  await expect(page.locator('.item', { hasText: slug }).getByTestId('folder-badge')).toHaveCount(0);
  await page.getByTestId('open-folder').click();
  await expect(page.getByTestId('project-slug')).toHaveText(slug);
  await expect(page.getByTestId('location-btn')).toContainText(dir);
  await ctx.close();
});

test('web folders: a project created from a template in a folder writes the template files there', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'fldt');
  await stubPicker(page);
  await page.reload();
  const dir = uniq('tdir-');
  await pickNext(page, dir);
  await openNewProject(page);
  await page.getByTestId('template-report').click();
  await page.getByPlaceholder('my-paper-2026').fill(uniq('foldt-'));
  await page.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
  await page.getByTestId('create-in-folder').click();
  await expect(page.getByText(`In the folder “${dir}”`)).toBeVisible();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  await expect.poll(() => readExternal(page, dir, 'main.tex'), { timeout: 10_000 }).toContain('\\documentclass');
  await expect.poll(() => readExternal(page, dir, 'chapters/introduction.tex'), { timeout: 10_000 }).toContain('\\chapter{Introduction}');
  await ctx.close();
});
