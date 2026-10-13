import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { PW, createProject, newUser, uniq } from './helpers.js';

test('account recents: the projects list follows the order projects were opened, across devices', async ({ browser }) => {
  const c1 = await browser.newContext();
  const { page, username } = await newUser(c1, 'rec');
  const ids: string[] = [];
  for (const prefix of [uniq('reca-'), uniq('recb-')]) {
    ids.push(await createProject(page, prefix));
    await page.goto('/#/');
  }
  const [a, b] = ids as [string, string];
  // open B, then A
  for (const slug of [b, a]) {
    await page.locator('.item', { hasText: slug }).click();
    await expect(page.getByTestId('project-slug')).toHaveText(slug);
    await page.waitForTimeout(300);
    await page.goto('/#/');
  }

  // another device of the same account
  const c2 = await browser.newContext();
  const other = await c2.newPage();
  await other.goto('/#/login');
  await other.getByLabel('Username or email').fill(username);
  await other.locator('input[type=password]').fill(PW);
  await other.locator('form button[type=submit]').click();
  await expect(other.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  const items = other.getByTestId('project-list').locator('.item');
  await expect(items.first()).toContainText(a);
  await expect(items.nth(1)).toContainText(b);
  await expect(items.first().getByTestId('opened-ago')).toHaveText(/opened (just now|.*ago)/);
  await c1.close();
  await c2.close();
});
