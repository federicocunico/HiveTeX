import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { newUser, openNewProject, PROJECT_PW, typeInEditor, uniq } from './helpers.js';
import { pdfText } from './fixtures/compile-templates.js';

// Runs against vite preview in the required production lane: no /src imports, injected session, fake engine,
// custom TeX endpoint or fixture package server. Sources are created and PDFs downloaded through the product UI.
for (const name of ['article', 'report'] as const) {
  test(`production workspace builds the bundled ${name} and reopens with compiler resources offline`, async ({ context }, info) => {
    test.setTimeout(180_000);
    await context.addInitScript(() => {
      localStorage.removeItem('texliveUrl');
      localStorage.setItem('hivetex.prefs', JSON.stringify({ compileSchedule: 'manual' }));
    });
    const { page } = await newUser(context, 'bundled', { realCompiler: true });
    await openNewProject(page);
    await page.getByTestId(`template-${name}`).click();
    await page.getByPlaceholder('my-paper-2026').fill(uniq(`bundled-${name}-`));
    await page.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByTestId('workspace')).toBeVisible();
    if (name === 'report') {
      await page.getByTestId('settings-btn').click();
      await page.getByLabel('Engine', { exact: true }).selectOption('xelatex');
      await page.getByRole('button', { name: 'Save build settings' }).click();
      await page.keyboard.press('Escape');
    }
    for (const stage of ['cold', 'warm', 'offline-reopen']) {
      if (stage === 'offline-reopen') {
        await context.route('**/*', route => /\/texlive\/|\/swiftlatex\/|texlive2\.swiftlatex\.com/.test(route.request().url()) ? route.abort('internetdisconnected') : route.continue());
        await page.reload();
        await expect(page.getByTestId('workspace')).toBeVisible();
      }
      await page.getByRole('treeitem', { name: 'main.tex' }).click();
      // Change the real source hash so the warm/offline stages cannot reuse the previous accepted PDF.
      if (stage !== 'cold') await typeInEditor(page, `\n% ${stage} compiler acceptance\n`);
      await page.getByTestId('compile-btn').click();
      await expect(page.getByTestId('build-status')).toContainText('PDF up to date', { timeout: 120_000 });
      await expect(page.locator('[data-page="1"][data-rendered="true"]')).toBeVisible();
      const downloaded = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
      const path = info.outputPath(`${stage}.pdf`);
      await (await downloaded).saveAs(path);
      const text = await pdfText(new Uint8Array(await readFile(path)));
      expect(text).toContain(name === 'article' ? 'Your Paper Title' : 'Thesis Title');
      expect(text).toContain(name === 'article' ? 'Knuth' : 'Lamport');
      expect(text).not.toContain('?');
      await info.attach(`${stage}-pdf`, { path, contentType: 'application/pdf' });
    }
    expect(await page.evaluate(() => localStorage.getItem('texliveUrl'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('hivetex.fakeEngine'))).toBeNull();
  });
}
