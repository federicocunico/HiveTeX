import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { newUser, signOut } from './helpers.js';

test('persistent web cookie restores after browser restart and sign-out clears it', async ({ baseURL }) => {
  const directory = await mkdtemp(join(tmpdir(), 'hivetex-cookie-'));
  let context = await chromium.launchPersistentContext(directory, { baseURL });
  try {
    const { username } = await newUser(context, 'cookie');
    await context.close();
    context = await chromium.launchPersistentContext(directory, { baseURL });
    const page = await context.newPage();
    await page.goto('/#/');
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
    await expect(page.getByText(username, { exact: true }).first()).toBeVisible();
    await signOut(page);
    await expect(page.getByLabel('Username or email')).toBeVisible();
    await context.close();
    context = await chromium.launchPersistentContext(directory, { baseURL });
    const reopened = await context.newPage();
    await reopened.goto('/#/login');
    await expect(reopened.getByLabel('Username or email')).toBeVisible();
  } finally {
    await context.close();
    const resolved = await realpath(directory);
    const temporaryRoot = await realpath(tmpdir());
    if (dirname(resolved).toLowerCase() !== temporaryRoot.toLowerCase()) throw new Error('Unexpected browser profile cleanup path');
    await rm(resolved, { recursive: true, force: true });
  }
});
