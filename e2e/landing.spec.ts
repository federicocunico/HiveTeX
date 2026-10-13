import { expect, test } from '@playwright/test';
import { createProject, newUser, PW, signOut, uniq } from './helpers.js';

test('signed-out visitors see the landing page; its main action opens registration', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('landing')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: /Write your paper together/ })).toBeVisible();
  // Desktop downloads are offered, with a working fallback link to the releases page.
  await expect(page.getByTestId('download-windows')).toHaveAttribute('href', /\/releases\/latest$/);
  await expect(page.getByRole('link', { name: 'Source code' }).first()).toHaveAttribute('href', /github\.com/);
  await page.getByRole('link', { name: 'Create free account' }).first().click();
  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('signed-in users go straight to their projects and never load the landing page', async ({ browser }) => {
  const ctx = await browser.newContext();
  const u = await newUser(ctx, 'land');
  const landingRequests: string[] = [];
  u.page.on('request', (r) => /Landing/.test(r.url()) && landingRequests.push(r.url()));
  await u.page.goto('/');
  await expect(u.page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  await u.page.reload();
  await expect(u.page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  expect(landingRequests).toEqual([]);
  await ctx.close();
});

test('a project link opened while signed out continues to the project after sign-in', async ({ browser }) => {
  const ctx = await browser.newContext();
  const u = await newUser(ctx, 'deep');
  let slug = uniq('deep-');
  slug = await createProject(u.page, slug);
  const projectUrl = u.page.url();
  await u.page.goto('/#/');
  await signOut(u.page);
  await expect(u.page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await u.page.goto(projectUrl);
  await expect(u.page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await u.page.getByLabel('Username or email').fill(u.username);
  await u.page.getByLabel('Password').fill(PW);
  await u.page.getByRole('button', { name: 'Sign in' }).click();
  await expect(u.page.getByTestId('workspace')).toBeVisible();
  await expect(u.page.getByTestId('project-slug')).toHaveText(slug);
  await ctx.close();
});

test('registration checks the rules while typing and shows server errors at the field', async ({ browser }) => {
  const ctx = await browser.newContext();
  const taken = await newUser(ctx, 'taken');
  // A fresh context has no session: register screen.
  const ctx2 = await browser.newContext();
  const p = await ctx2.newPage();
  await p.goto('/#/register');

  const pw = p.locator('#reg-pw');
  await pw.fill('short123');
  await expect(p.getByTestId('rule-length')).toHaveAttribute('data-met', 'false');
  await expect(p.getByTestId('rule-length')).toContainText('8 so far');
  await pw.fill('long enough pw');
  await expect(p.getByTestId('rule-length')).toHaveAttribute('data-met', 'true');

  await p.getByLabel('Username').fill('bad name!');
  await expect(p.getByText('Use only a–z, 0–9, _ and -')).toBeVisible();

  // Show reveals both password fields.
  await p.getByRole('button', { name: 'Show' }).click();
  await expect(pw).toHaveAttribute('type', 'text');
  await p.getByRole('button', { name: 'Hide' }).click();
  await expect(pw).toHaveAttribute('type', 'password');

  await p.getByLabel('Username').fill(taken.username.toUpperCase());
  await expect(p.getByTestId('rule-username')).toHaveAttribute('data-met', 'true');
  await p.getByLabel('Email').fill(`${uniq('x')}@example.com`);
  await pw.fill(PW);
  await p.locator('#reg-pw2').fill(PW);
  await expect(p.getByTestId('rule-repeat')).toHaveAttribute('data-met', 'true');
  await p.getByRole('button', { name: 'Create account' }).click();
  const err = p.locator('#reg-user-err');
  await expect(err).toContainText(/unavailable/i);
  await expect(p.getByLabel('Username')).toHaveAttribute('aria-invalid', 'true');
  await expect(p.getByLabel('Username')).toHaveAttribute('aria-describedby', 'reg-user-err');
  await ctx.close();
  await ctx2.close();
});
