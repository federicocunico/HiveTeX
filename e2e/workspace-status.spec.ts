import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { addFile, createProject, joinProject, newUser, replaceEditorText, uniq } from './helpers.js';

test('source sync, stale PDF and save/build warnings remain independent and reachable at narrow widths', async ({ browser }) => {
  const owner = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const peer = await browser.newContext();
  try {
    const a = await newUser(owner, 'statusa'), b = await newUser(peer, 'statusb');
    const p = a.page;
    await p.goto('/#/account'); await p.getByLabel('Compilation schedule', { exact: true }).selectOption('manual');
    await p.goto('/#/');
    const slug = await createProject(p, uniq('status-'));
    await p.getByTestId('settings-btn').click();
    await p.getByLabel('Default role').selectOption('editor');
    await p.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect(p.getByText('Saved', { exact: true })).toBeVisible();
    await p.getByRole('button', { name: 'Close', exact: true }).click();
    await addFile(p, 'main.tex'); await p.getByRole('treeitem', { name: 'main.tex' }).click();
    await p.getByTestId('compile-btn').click();
    await expect(p.getByTestId('build-status')).toContainText('PDF up to date');
    await joinProject(b.page, slug);
    await b.page.getByRole('treeitem', { name: 'main.tex' }).click();
    await replaceEditorText(p, 'An edit awaiting compilation.');
    await expect(b.page.locator('.cm-content')).toContainText('An edit awaiting compilation.');
    await p.getByTestId('sync-status').click();
    await p.getByTestId('sync-now').click();
    await expect(p.getByTestId('sync-now-result')).toContainText('up to date');
    await expect(p.getByTestId('sync-status')).toContainText('All changes synced');
    await expect(p.getByTestId('build-status')).toContainText('PDF outdated');
    await expect(p.getByTestId('build-status')).toContainText('Manual');

    await replaceEditorText(p, '\\fail'); await p.getByTestId('compile-btn').click();
    await expect(p.getByTestId('build-status')).toContainText('Build failed');
    // Storage failure injection is independent of the actual fake-engine source failure above.
    await p.evaluate(() => { (window as any).__p2p.session.model.durabilityError('acceptance-storage', new Error('Storage unavailable')); });
    for (const width of [1280, 1024, 800]) {
      await p.setViewportSize({ width, height: 768 });
      for (const id of ['save-failed', 'export-recovery', 'build-status', 'status-details']) {
        const item = p.getByTestId(id); await expect(item).toBeVisible();
        const box = (await item.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(768);
      }
      expect(await p.getByTestId('statusbar').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await p.getByTestId('status-details').focus(); await p.keyboard.press('Enter');
    const dialog = p.getByRole('dialog', { name: 'Workspace status' });
    await expect(dialog).toContainText('storage is failing');
    await expect(dialog).toContainText('in-browser compiler');
    await expect(dialog.getByRole('button', { name: 'Compile now', exact: true })).toBeVisible();
    await p.keyboard.press('Escape'); await expect(p.getByTestId('status-details')).toBeFocused();
    await p.evaluate(() => { (window as any).__p2p.session.model.durabilityError('acceptance-storage', null); });
  } finally { await owner.close(); await peer.close(); }
});
