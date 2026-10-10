import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { FakeGitHub } from '../packages/github/src/testing.js';
import { PROJECT_PW, addFile, createProject, joinProject, newUser, onStack, replaceEditorText, showFiles, uniq } from './helpers.js';

// The fake GitHub OAuth endpoints only exist in the embedded dev server (E2E_FAKE_GITHUB).
test.skip(onStack, 'GitHub OAuth is not faked on the docker stack');

/** Routes GitHub (OAuth page + REST API) to an in-process fake, with the CORS headers a real browser needs. */
async function mockGithub(context: BrowserContext, gh: FakeGitHub) {
  await context.route('https://github.com/login/oauth/authorize*', async (route) => {
    const url = new URL(route.request().url());
    const state = url.searchParams.get('state');
    // back to the callback the server asked for (whatever port the dev page runs on)
    const callback = url.searchParams.get('redirect_uri') ?? 'http://localhost:1420/api/github/callback';
    await route.fulfill({ status: 302, headers: { location: `${callback}?code=e2e-code&state=${state}` } });
  });
  await context.route('https://api.github.com/**', async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const res = await gh.fetch(req.url(), { method: req.method(), ...(req.postData() ? { body: req.postData() as string } : {}) });
    await route.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: await res.text() });
  });
}

async function connect(page: Page) {
  await page.getByTestId('backup-btn').click();
  await page.getByTestId('github-connect').click();
  await expect(page.getByText('Connected as')).toBeVisible({ timeout: 30_000 });
}

test('connect GitHub, link a new private repo, back up now, and see status (10.3)', async ({ browser }) => {
  const gh = new FakeGitHub();
  const ctx = await browser.newContext();
  await mockGithub(ctx, gh);
  const u = await newUser(ctx, 'git');
  await createProject(u.page, uniq('gh-'));
  await addFile(u.page, 'main.tex');
  await u.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(u.page, '\\documentclass{article}\\begin{document}Backed up!\\end{document}');

  await connect(u.page);
  await u.page.getByTestId('github-bind').click();
  await expect(u.page.getByTestId('github-status')).toContainText('octocat/');
  await u.page.getByTestId('github-now').click();
  await expect(u.page.getByText('Backup pushed')).toBeVisible({ timeout: 30_000 });

  const repoName = [...gh.repos.keys()][0] as string;
  await expect.poll(() => gh.repo(repoName).files('main')['main.tex']).toContain('Backed up!');
  await expect(u.page.getByTestId('github-status')).toContainText('Last backup:');
  await expect(u.page.getByTestId('github-status')).toContainText('pushed by this device');
  // the token never reached the server's database and was sealed in transit (covered by server tests); here: no token in the page's URL/storage that the server could read
  expect(await u.page.evaluate(() => JSON.stringify(localStorage))).not.toContain('ghu_E2E_TOKEN');
  await ctx.close();
});

test('a member with repo access loads the project from GitHub when nobody is online, then merges with peers (10.6)', async ({ browser }) => {
  const gh = new FakeGitHub();
  const slug = uniq('boot-');
  const ownerCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  await mockGithub(ownerCtx, gh);
  await mockGithub(guestCtx, gh);
  const owner = await newUser(ownerCtx, 'olga');
  await createProject(owner.page, slug);
  // members start as editors so a guest can bootstrap from GitHub and later merge
  await owner.page.getByTestId('settings-btn').click();
  await owner.page.getByLabel('Default role').selectOption('editor');
  await owner.page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(owner.page.getByText('Saved', { exact: true })).toBeVisible();
  await owner.page.getByRole('button', { name: 'Close' }).click();
  await addFile(owner.page, 'main.tex');
  await owner.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await replaceEditorText(owner.page, 'Chapter one from the backup.');
  await connect(owner.page);
  await owner.page.getByTestId('github-bind').click();
  await expect(owner.page.getByTestId('github-status')).toBeVisible();
  await owner.page.getByTestId('github-now').click();
  await expect(owner.page.getByText('Backup pushed')).toBeVisible({ timeout: 30_000 });

  // owner goes away entirely
  await owner.page.close();

  const guest = await newUser(guestCtx, 'gus');
  await guest.page.goto('/#/');
  await joinProject(guest.page, slug, PROJECT_PW);
  await expect(guest.page.getByTestId('bootstrap-banner')).toBeVisible();
  // the guest connects GitHub (fake account has access to the repo) then loads the backup
  await connect(guest.page);
  await guest.page.getByTestId('load-github').click();
  await expect(guest.page.getByRole('treeitem', { name: 'main.tex' })).toBeVisible({ timeout: 30_000 });
  await guest.page.getByRole('treeitem', { name: 'main.tex' }).click();
  await expect(guest.page.locator('.cm-content')).toContainText('Chapter one from the backup.');

  // the owner comes back: both copies merge into ONE main.tex
  const back = await ownerCtx.newPage();
  await back.addInitScript(() => {
    localStorage.setItem('hivetex.test', '1');
    localStorage.setItem('hivetex.fakeEngine', '1');
  });
  await back.goto('/#/');
  await back.getByRole('link', { name: new RegExp(slug) }).click();
  await expect(back.getByTestId('workspace')).toBeVisible();
  await expect(back.getByTestId('peer-count')).toContainText('1 co-author', { timeout: 30_000 });
  await expect(guest.page.getByTestId('peer-count')).toContainText(owner.username, { timeout: 30_000 });
  await showFiles(back);
  await expect(guest.page.getByRole('treeitem', { name: /main/ })).toHaveCount(1, { timeout: 15_000 });
  await expect(back.getByRole('treeitem', { name: /main/ })).toHaveCount(1, { timeout: 15_000 });
  await ownerCtx.close();
  await guestCtx.close();
});

test('a forwarded GitHub authorization link cannot link the victim to the sender (security)', async ({ browser }) => {
  const attackerCtx = await browser.newContext();
  const victimCtx = await browser.newContext();
  const attacker = await newUser(attackerCtx, 'mal');
  const victim = await newUser(victimCtx, 'vic');
  // The attacker starts a flow for their own account and device key...
  const start = await attacker.page.request.post('/api/github/start', {
    headers: { 'X-Requested-With': 'hivetex', 'Content-Type': 'application/json' },
    data: { handoff: 'e2e-handoff-0123456789', pub: 'A'.repeat(43) },
  });
  const state = new URL((await start.json()).url).searchParams.get('state') as string;
  // ...and the victim opens the link: GitHub (already authorized) redirects the victim's browser to the callback.
  await victim.page.goto(`/api/github/callback?code=e2e-code&state=${state}`);
  await expect(victim.page.getByTestId('github-continue-error')).toContainText('another account');
  await expect(victim.page).not.toHaveURL(/code=/); // the code does not stay in the address bar
  const h = await attacker.page.request.get('/api/github/handoff/e2e-handoff-0123456789', { headers: { 'X-Requested-With': 'hivetex' } });
  expect((await h.json()).ready).toBe(false);
  await attackerCtx.close();
  await victimCtx.close();
});
