import { type Page, expect, test } from '@playwright/test';
import { addFile, createProject, joinProject, newUser, replaceEditorText, typeInEditor, uniq } from './helpers.js';

/**
 * Real-browser regressions for the editor (F16) and for the folder mirror (F15): a file whose document loads late
 * never takes over the editor, and a folder bound on a matching or a read-only project behaves as documented in
 * docs/folders.md. The folder picker is stubbed with a directory of the origin-private file system (see folders.spec.ts).
 */

type Session = {
  model: {
    find(p: string): { id: string } | undefined;
    openText(id: string): Promise<{ insert(i: number, s: string): void; toString(): string }>;
    list(): Array<{ path: string }>;
  };
};

async function stubPicker(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle(localStorage.getItem('e2e.pickDir') ?? 'picked', { create: true });
    };
  });
  await page.reload();
}
const pickNext = (page: Page, dir: string) => page.evaluate((d) => localStorage.setItem('e2e.pickDir', d), dir);

const writeExternal = (page: Page, dir: string, path: string, text: string) =>
  page.evaluate(
    async ([d, p, t]) => {
      const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d as string, { create: true });
      const w = await (await h.getFileHandle(p as string, { create: true })).createWritable();
      await w.write(t as string);
      await w.close();
    },
    [dir, path, text],
  );
const readExternal = (page: Page, dir: string, path: string) =>
  page.evaluate(
    async ([d, p]) => {
      try {
        const h = await (await navigator.storage.getDirectory()).getDirectoryHandle(d as string);
        return await (await (await h.getFileHandle(p as string)).getFile()).text();
      } catch {
        return null;
      }
    },
    [dir, path],
  );
const docText = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    const s = (window as unknown as { __p2p: { session: Session } }).__p2p.session;
    const f = s.model.find(p);
    return f ? (await s.model.openText(f.id)).toString() : null;
  }, path);
const bindFolder = async (page: Page, dir: string) => {
  await pickNext(page, dir);
  await page.getByTestId('location-btn').click();
  await page.getByTestId('link-folder').click();
  await expect(page.getByTestId('location-btn')).toContainText(dir);
};

/** Makes loading the text of `path` wait until `__release()` is called (as a slow store or a busy device would). */
const delayLoads = (page: Page, path: string) =>
  page.evaluate((p) => {
    const w = window as unknown as { __p2p: { session: Session }; __release: () => void };
    const model = w.__p2p.session.model;
    const id = model.find(p)?.id;
    const orig = model.openText.bind(model);
    const waiting: Array<() => void> = [];
    let held = true;
    model.openText = async (fid: string) => {
      if (held && fid === id) await new Promise<void>((r) => waiting.push(r));
      return orig(fid);
    };
    w.__release = () => {
      held = false;
      for (const r of waiting.splice(0)) r();
    };
  }, path);
const release = (page: Page) => page.evaluate(() => (window as unknown as { __release: () => void }).__release());

test('editor: a file that loads late never takes over the editor, and closing the project leaves none behind', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page } = await newUser(ctx, 'edl');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await createProject(page, uniq('edl-'));
  await addFile(page, 'a.tex');
  await page.getByRole('treeitem', { name: 'a.tex' }).click();
  await replaceEditorText(page, 'text of A');
  await addFile(page, 'b.tex');
  await page.getByRole('treeitem', { name: 'b.tex' }).click();
  await replaceEditorText(page, 'text of B');
  await expect.poll(() => docText(page, 'b.tex')).toBe('text of B');

  // A is selected, its document loads slowly; B is selected meanwhile and finishes first
  await delayLoads(page, 'a.tex');
  await page.getByRole('treeitem', { name: 'a.tex' }).click();
  await page.getByRole('treeitem', { name: 'b.tex' }).click();
  await expect(page.locator('.cm-content')).toContainText('text of B');
  await release(page);
  await page.waitForTimeout(500);
  await expect(page.locator('.cm-editor')).toHaveCount(1);
  await expect(page.locator('.cm-content')).toContainText('text of B');
  await typeInEditor(page, '!');
  await expect.poll(() => docText(page, 'b.tex')).toBe('text of B!');
  expect(await docText(page, 'a.tex')).toBe('text of A');

  // closing the project while a file is still loading
  await delayLoads(page, 'a.tex');
  await page.getByRole('treeitem', { name: 'a.tex' }).click();
  await page.goto('/#/');
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await release(page);
  await page.waitForTimeout(500);
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  expect(errors).toEqual([]);
  await ctx.close();
});

test('folders: a folder that matched at bind time merges a co-author edit and a tool edit that arrive together', async ({ browser }) => {
  const slug = uniq('fmrg-');
  const o = await newUser(await browser.newContext(), 'fmo');
  await stubPicker(o.page);
  await createProject(o.page, slug);
  await o.page.getByTestId('settings-btn').click();
  await o.page.getByLabel('Default role').selectOption('editor');
  await o.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(o.page.getByTestId('settings-dialog').getByText('Saved', { exact: true })).toBeVisible();
  await o.page.getByRole('button', { name: 'Close' }).click();
  await addFile(o.page, 'main.tex');
  await o.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(o.page, 'BASE');
  await expect.poll(() => docText(o.page, 'main.tex')).toBe('BASE');

  const c = await newUser(await browser.newContext(), 'fmc');
  await c.page.goto('/#/');
  await joinProject(c.page, slug);
  await expect(c.page.getByTestId('peer-count')).toContainText('1 co-author', { timeout: 60_000 });
  await c.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect.poll(() => docText(c.page, 'main.tex'), { timeout: 30_000 }).toBe('BASE');

  // the folder already holds exactly the project's text
  const dir = uniq('dir-');
  await writeExternal(o.page, dir, 'main.tex', 'BASE');
  await bindFolder(o.page, dir);
  await expect.poll(() => readExternal(o.page, dir, 'main.tex')).toBe('BASE');
  await o.page.waitForTimeout(1500); // the first reconcile has finished

  // a co-author types at the start while a tool edits the version the folder had
  await writeExternal(o.page, dir, 'main.tex', 'BASE LOCAL');
  await c.page.evaluate(async () => {
    const s = (window as unknown as { __p2p: { session: Session } }).__p2p.session;
    (await s.model.openText(s.model.find('main.tex')!.id)).insert(0, 'REMOTE ');
  });
  await expect.poll(() => docText(o.page, 'main.tex'), { timeout: 20_000 }).toBe('REMOTE BASE LOCAL');
  await expect.poll(() => readExternal(o.page, dir, 'main.tex'), { timeout: 20_000 }).toBe('REMOTE BASE LOCAL');
  await expect.poll(() => docText(c.page, 'main.tex'), { timeout: 20_000 }).toBe('REMOTE BASE LOCAL');
});

test('folders: a viewer binding a different copy changes nothing in the project and is told what happened', async ({ browser }) => {
  const slug = uniq('fvw-');
  const o = await newUser(await browser.newContext(), 'fvo');
  await createProject(o.page, slug);
  await addFile(o.page, 'main.tex');
  await o.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(o.page, 'project text');
  await expect.poll(() => docText(o.page, 'main.tex')).toBe('project text');

  const v = await newUser(await browser.newContext(), 'fvv');
  await stubPicker(v.page);
  await v.page.goto('/#/');
  await joinProject(v.page, slug);
  await expect(v.page.getByTestId('role-pill')).toHaveText('viewer');
  await v.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect.poll(() => docText(v.page, 'main.tex'), { timeout: 30_000 }).toBe('project text');

  const dir = uniq('dir-');
  await writeExternal(v.page, dir, 'main.tex', 'viewer copy');
  await writeExternal(v.page, dir, 'extra.tex', 'only on this device');
  await bindFolder(v.page, dir);
  await expect.poll(() => readExternal(v.page, dir, 'main.tex')).toBe('project text');
  await expect(v.page.getByRole('status').filter({ hasText: 'read-only' }).first()).toBeVisible();
  await v.page.waitForTimeout(1500);
  expect(await docText(v.page, 'main.tex')).toBe('project text');
  expect(await v.page.evaluate(() => (window as unknown as { __p2p: { session: Session } }).__p2p.session.model.list().map((f) => f.path))).toEqual(['main.tex']);
  expect(await docText(o.page, 'main.tex')).toBe('project text');
  await expect(o.page.getByRole('treeitem', { name: 'extra.tex' })).toHaveCount(0);
  expect(await readExternal(v.page, dir, 'extra.tex')).toBe('only on this device');
});
