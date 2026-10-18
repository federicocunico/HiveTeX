import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { createProject, newUser, uniq } from './helpers.js';

test('browser folder imports never bind a mirror and legacy remembered folders stay untouched', async ({ browser }) => {
  const context = await browser.newContext();
  const { page } = await newUser(context, 'folder-read');
  await createProject(page, uniq('folder-read-'));
  await expect(page.getByTestId('file-tree')).toBeVisible();
  // OPFS provides real, clonable File System Access handles without OS picker/firewall dependencies.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle('read-only-source', { create: true });
    const writer = await (await folder.getFileHandle('external.tex', { create: true })).createWritable();
    await writer.write('original external contribution'); await writer.close();
    (window as any).__folder = folder;
    (window as any).showDirectoryPicker = async (options: { mode: string }) => { (window as any).__pickerMode = options.mode; return folder; };
  });
  await page.getByTestId('location-btn').click();
  await page.getByTestId('link-folder').click();
  await expect(page.getByTestId('import-confirm')).toBeVisible();
  await page.getByTestId('import-confirm').click();
  await expect(page.getByTestId('import-summary')).toContainText('Imported');
  await page.getByTestId('import-done').click();
  expect(await page.evaluate(() => (window as any).__pickerMode)).toBe('read');
  expect(await page.evaluate(() => (window as any).__p2p.session.mirrorDir)).toBeNull();
  await page.evaluate(async () => {
    const session = (window as any).__p2p.session;
    const file = session.model.find('external.tex');
    const text = await session.model.openText(file.id); text.insert(text.length, ' project-only edit');
    await session.model.flush();
    const source = await (window as any).__folder.getFileHandle('external.tex');
    if (await (await source.getFile()).text() !== 'original external contribution') throw new Error('Browser wrote to import source');
    // Simulate a location saved by the preceding release, with a real structured-clonable directory handle.
    const request = indexedDB.open('hivetex-locations', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onupgradeneeded = () => request.result.createObjectStore('locations'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('locations', 'readwrite'); tx.objectStore('locations').put({ kind: 'folder', label: 'legacy folder', handle: (window as any).__folder }, session.project.id);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); db.close();
  });
  await page.reload();
  await expect(page.getByTestId('file-tree')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__p2p?.session.mirrorNotice)).toContain('import-only');
  expect(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(), folder = await root.getDirectoryHandle('read-only-source');
    return (await (await folder.getFileHandle('external.tex')).getFile()).text();
  })).toBe('original external contribution');
  expect(await page.evaluate(() => (window as any).__p2p.session.location.kind)).toBe('app');
  await context.close();
});
