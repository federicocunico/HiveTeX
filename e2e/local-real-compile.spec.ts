import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, newUser, replaceEditorText, uniq } from './helpers.js';
import { texFixture } from './tex-fixture.js';

test('a real WASM compiler builds a local PDF without a co-author', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  const packages = await texFixture();
  const consoleLog: string[] = [];
  try {
  const user = await newUser(context, 'wasmreal', { realCompiler: true });
  user.page.on('console', (message) => { if (!message.text().includes('state_proxy')) consoleLog.push(message.text()); });
  await user.page.evaluate((url) => { localStorage.setItem('texliveUrl', url); sessionStorage.removeItem('hivetex.texserver'); }, packages.url);
  const loaded: string[] = [];
  user.page.on('request', (request) => {
    if (/swiftlatex\/(?:swiftlatexpdftex\.js|swiftlatexpdftex\.wasm)/.test(request.url())) loaded.push(request.url());
  });
  await createProject(user.page, uniq('wasmreal-'));
  await addFile(user.page, 'main.tex');
  await user.page.getByRole('treeitem', { name: 'main.tex' }).click();
  // The vendored WASM format predates current article.cls. The stable minimal class exercises a real LaTeX build
  // without mixing a 2020 format with a 2026 class; native acceptance separately covers article and package installs.
  await replaceEditorText(user.page, '\\documentclass{minimal}\n\\begin{document}\nActual local LaTeX compilation.\n\\end{document}\n');
  await user.page.getByTestId('compile-btn').click();
  await expect.poll(async () => {
    if (await user.page.locator('[data-testid=pdf-scroll] canvas').first().isVisible()) return 'pdf';
    const errors = user.page.getByRole('region', { name: 'Problems' });
    if (await user.page.getByTestId('compile-btn').isEnabled() && await errors.getByRole('button', { name: /[1-9].*errors/ }).isVisible()) {
      const logButton = errors.getByRole('button', { name: /log/i });
      if (await logButton.isVisible()) await logButton.click();
      throw new Error(`Real WASM failed: ${await errors.innerText()}`);
    }
    return 'waiting';
  }, { timeout: 150_000 }).toBe('pdf');
  expect(await user.page.evaluate(() => localStorage.getItem('hivetex.fakeEngine'))).toBeNull();
  expect(loaded.some((url) => url.includes('swiftlatexpdftex.js'))).toBe(true);
  await expect(user.page.getByTestId('compiled-by')).toContainText(user.username);
  await expect(user.page.getByTestId('peer-count')).toContainText('No co-authors');
  expect(await user.page.evaluate(async (url) => !!await (await caches.open('hivetex-tex-v1')).match(`${url}pdftex/10/swiftlatexpdftex.fmt`), packages.url)).toBe(true);
  await packages.close();
  await user.page.evaluate(() => sessionStorage.removeItem('hivetex.texserver'));
  await user.page.reload();
  await expect(user.page.getByTestId('workspace')).toBeVisible();
  await expect(user.page.locator('[data-testid=pdf-scroll] canvas').first()).toBeVisible({timeout:60_000});
  await expect(user.page.getByTestId('compiled-by')).toContainText(user.username);
  await context.close();
  expect(packages.requests).toContain('swiftlatexpdftex.fmt');
  } finally {
    await test.info().attach('wasm-console', { body: consoleLog.join('\n'), contentType: 'text/plain' });
    await test.info().attach('tex-package-requests', { body: packages.requests.join('\n'), contentType: 'text/plain' });
    await context.close(); await packages.close();
  }
});
