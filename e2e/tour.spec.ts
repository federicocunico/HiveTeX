import { expect } from '@playwright/test';
import { test } from './trace-fixture.js';
import { createProject, newUser, uniq } from './helpers.js';

test('first-run tour: shown once, skippable, replayable from Help', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page: p } = await newUser(ctx, 'tour');
  // a new device (test runs skip the tour unless they ask for it)
  await p.evaluate(() => localStorage.setItem('hivetex.tour', 'new'));
  await createProject(p, uniq('tour-'));
  const tour = p.getByTestId('tour');
  await expect(tour).toBeVisible();
  await expect(tour).toContainText('Step 1 of 4');
  await expect(tour.getByRole('button', { name: 'Next' })).toBeFocused();
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText('Everything else is in this rail');
  await tour.getByRole('button', { name: 'Back' }).click();
  await expect(tour).toContainText('Write here');
  await tour.getByRole('button', { name: 'Skip tour' }).click();
  await expect(tour).toHaveCount(0);

  // another project on this device: no tour
  await p.goto('/#/');
  await createProject(p, uniq('tour2-'));
  await expect(p.getByTestId('workspace')).toBeVisible();
  await p.waitForTimeout(800);
  await expect(tour).toHaveCount(0);

  // Help → Take the tour starts again from step 1, and finishing works
  await p.getByRole('button', { name: 'More actions' }).click();
  await p.getByRole('menuitem', { name: 'Take the tour' }).click();
  await expect(tour).toContainText('Step 1 of 4');
  for (let i = 0; i < 3; i++) await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText('Invite your co-authors');
  await tour.getByRole('button', { name: 'Done' }).click();
  await expect(tour).toHaveCount(0);
  await ctx.close();
});
