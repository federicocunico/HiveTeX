import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { PROJECT_PW, createProject, joinProject, newUser, uniq } from './helpers.js';

test('share: the invitation has the ID but never the password; roles change from here; editors only copy', async ({ browser }) => {
  const ownerCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const o = await newUser(ownerCtx, 'shr');
  let slug = uniq('shr-');
  slug = await createProject(o.page, slug);

  const guestCtx = await browser.newContext();
  const g = await newUser(guestCtx, 'shrg');
  await joinProject(g.page, slug);
  await expect(g.page.getByTestId('role-pill')).toHaveText('viewer');

  await o.page.getByTestId('share-btn').click();
  const dlg = o.page.getByTestId('share-dialog');
  await expect(dlg).toBeVisible();
  const axe = await new AxeBuilder({ page: o.page }).include('[data-testid=share-dialog]').analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);

  await dlg.getByTestId('copy-invitation').click();
  await expect(o.page.getByRole('status').filter({ hasText: 'Invitation copied' })).toBeVisible();
  const text = await o.page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain(slug);
  expect(text).toContain('Join with ID');
  expect(text).not.toContain(PROJECT_PW);

  // a role change from Share works like one from settings
  await dlg.getByLabel(`Role of ${g.username}`).selectOption('editor');
  await expect(dlg.getByText(`${g.username} is now editor`)).toBeVisible();
  // the guest's ticket refreshes on its own schedule; reload to pick up the new role now
  await g.page.reload();
  await expect(g.page.getByTestId('role-pill')).toHaveText('editor', { timeout: 30_000 });

  // keyboard: Tab stays inside, Escape returns focus to Share
  for (let i = 0; i < 25; i++) {
    await o.page.keyboard.press('Tab');
    expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await o.page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(o.page.getByTestId('share-btn')).toBeFocused();

  // the (now) editor can copy the invitation but sees no access controls
  await g.page.getByTestId('share-btn').click();
  const gd = g.page.getByTestId('share-dialog');
  await expect(gd.getByTestId('copy-invitation')).toBeVisible();
  await expect(gd.getByTestId('members-table')).toHaveCount(0);
  await expect(gd).toContainText('Only the owner can change');
  await ownerCtx.close();
  await guestCtx.close();
});
