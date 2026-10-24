import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { texFixture } from './tex-fixture.js';
import { realCompilerContext, compileArticle } from './real-workspace.js';
import { joinProject, newUser, openNewProject, PROJECT_PW, uniq } from './helpers.js';

/**
 * Regenerates the README and docs screenshots: SCREENSHOTS=1 pnpm exec playwright test e2e/screenshots.spec.ts
 * A pinned real WASM package fixture is required. Fake PDFs are never used for product captures.
 */
test.skip(!process.env.SCREENSHOTS, 'screenshots are generated on request');

const path = (u: URL) => u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const out = (name: string) => path(new URL(`../docs/images/${name}.png`, import.meta.url));

let packages: Awaited<ReturnType<typeof texFixture>>;
test.beforeAll(async () => { packages = await texFixture({ pinned: true }); });
test.afterAll(async () => { await packages?.close(); });

test('screenshots for the README and docs', async ({ browser }) => {
  test.setTimeout(240_000);
  for (const colorScheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, colorScheme, deviceScaleFactor: 1 });
    await realCompilerContext(ctx, packages.url);
    const { page: p } = await newUser(ctx, `shot${colorScheme}`, { realCompiler: true });
    await openNewProject(p);
    await p.getByTestId('template-article').click();
    await p.getByPlaceholder('my-paper-2026').fill(uniq('protein-folding-'));
    await p.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
    if (colorScheme === 'light') await p.screenshot({ path: out('new-project') });
    await p.getByRole('button', { name: 'Create project' }).click();
    await expect(p.getByTestId('workspace')).toBeVisible();
    await compileArticle(p);
    await p.getByTestId('rail-outline').click();
    await expect(p.getByText('Rendering…')).toHaveCount(0, { timeout: 15_000 });
    await p.waitForTimeout(800);
    await p.screenshot({ path: out(`workspace-${colorScheme}`) });
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('landing')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out('landing') });
  await ctx.close();
});

test('screenshots: writing together, sharing, and the compiler settings', async ({ browser }) => {
  test.setTimeout(240_000);
  const view = { viewport: { width: 1440, height: 860 }, colorScheme: 'light' as const, deviceScaleFactor: 1 };
  const [oc, ec] = [await browser.newContext(view), await browser.newContext(view)];
  await realCompilerContext(oc, packages.url);
  await realCompilerContext(ec, packages.url);
  const { page: o } = await newUser(oc, 'ada', { realCompiler: true });
  const { page: e } = await newUser(ec, 'grace', { realCompiler: true });
  const slug = uniq('climate-review-');
  await openNewProject(o);
  await o.getByTestId('template-article').click();
  await o.getByPlaceholder('my-paper-2026').fill(slug);
  await o.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
  await o.getByRole('button', { name: 'Create project' }).click();
  await expect(o.getByTestId('workspace')).toBeVisible();
  const assignedSlug = await o.getByTestId('project-slug').innerText();

  // new members may edit (Share dialog)
  await o.getByTestId('share-btn').click();
  const share = o.getByTestId('share-dialog');
  await share.getByLabel('Default role for new members').selectOption('editor');
  await share.getByRole('button', { name: 'Save', exact: true }).click();
  await o.keyboard.press('Escape');

  // a co-author joins and edits the title: avatars, colored cursors, and the PDF compiled locally with real LaTeX
  await e.goto('/#/');
  await joinProject(e, assignedSlug);
  await e.getByRole('treeitem', { name: 'main.tex' }).click();
  await e.locator('.cm-line', { hasText: '\title{Your Paper Title}' }).click();
  await e.keyboard.press('End');
  await e.keyboard.press('ArrowLeft');
  await e.keyboard.type(': Sea Ice and Ocean Heat');
  await expect(o.locator('.cm-content')).toContainText('Sea Ice and Ocean Heat', { timeout: 30_000 });
  await compileArticle(o);
  await o.waitForTimeout(1500);
  await o.screenshot({ path: out('collaboration') });

  // Share dialog: the invitation (project ID; the password is sent separately), the default role and the members
  await o.getByTestId('share-btn').click();
  await expect(o.getByTestId('share-dialog')).toContainText('grace');
  await o.waitForTimeout(400);
  await o.screenshot({ path: out('share') });
  await o.keyboard.press('Escape');

  // Account > Compiler: this device's role in building PDFs, and compiling with the desktop app
  await o.goto('/#/account');
  const panel = o.getByTestId('compiler-settings');
  await expect(panel).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await o.waitForTimeout(300);
  await panel.screenshot({ path: out('compiler-settings') });
  await oc.close();
  await ec.close();
});
