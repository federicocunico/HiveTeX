import { type BrowserContext, type Page, expect } from '@playwright/test';

export const PW = 'correct horse battery staple';
export const PROJECT_PW = 'project-secret-1';

let n = 0;
export const uniq = (p: string) => `${p}${Date.now().toString(36)}${n++}`.toLowerCase().slice(0, 28);

export async function newUser(context: BrowserContext, prefix = 'user') {
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('hivetex.test', '1');
    localStorage.setItem('hivetex.fakeEngine', '1');
    localStorage.setItem('hivetex.epochGraceMs', '4000');
  });
  const username = uniq(prefix);
  await page.goto('/#/register');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Email').fill(`${username}@example.com`);
  await page.locator('input[type=password]').nth(0).fill(PW);
  await page.locator('input[type=password]').nth(1).fill(PW);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  return { page, username };
}

/** Opens the "New project" dialog from the projects page. */
export async function openNewProject(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'New project' });
  if (!(await dialog.isVisible())) await page.getByTestId('new-project-btn').click();
  await expect(dialog).toBeVisible();
}

export async function createProject(page: Page, slug: string, password = PROJECT_PW) {
  await openNewProject(page);
  await page.getByPlaceholder('my-paper-2026').fill(slug);
  await page.locator('form:has(h2:text("New project")) input[type=password]').fill(password);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
}

export async function joinProject(page: Page, slug: string, password = PROJECT_PW) {
  await page.getByTestId('join-btn').click();
  await page.locator('form:has(h2:text("Join a project")) input[type=text]').fill(slug);
  await page.locator('form:has(h2:text("Join a project")) input[type=password]').fill(password);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
}

/** Signs out from the account menu in the app header. */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
}

/** Opens the Files panel of the workspace unless it is already showing (the open panel is remembered per device). */
export async function showFiles(page: Page) {
  if (!(await page.getByTestId('file-tree').isVisible())) await page.getByTestId('rail-files').click();
  await expect(page.getByTestId('file-tree')).toBeVisible();
}

export async function addFile(page: Page, name: string) {
  await showFiles(page);
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page.getByTestId('new-name').fill(name);
  await page.getByTestId('new-name').press('Enter');
  await expect(page.getByRole('treeitem', { name: name.split('/').pop() as string })).toBeVisible();
}

export async function typeInEditor(page: Page, text: string) {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

export const editorText = (page: Page) => page.locator('.cm-content').innerText();

export async function replaceEditorText(page: Page, text: string) {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text);
}

/** True when the suite runs against the docker stack (`make test-stack`) instead of the embedded dev server. */
export const onStack = !!process.env.SKIP_WEBSERVER;

/** Emails sent so far: the dev server's in-memory mailbox, or Mailpit on the docker stack. */
export async function readMailbox(page: Page): Promise<Array<{ to: string; subject: string; text: string }>> {
  if (!onStack) return (await page.request.get('/api/__dev/mailbox')).json();
  const base = process.env.MAILPIT_URL ?? 'http://localhost:8025';
  const list = (await (await page.request.get(`${base}/api/v1/messages?limit=200`)).json()) as {
    messages: Array<{ ID: string; Subject: string; To: Array<{ Address: string }> }>;
  };
  const out = [];
  // Mailpit lists newest first; the dev mailbox is oldest first.
  for (const m of [...list.messages].reverse()) {
    const full = (await (await page.request.get(`${base}/api/v1/message/${m.ID}`)).json()) as { Text: string };
    out.push({ to: m.To[0]?.Address ?? '', subject: m.Subject, text: full.Text });
  }
  return out;
}

/** Waits for the newest email to `to` whose subject matches (mail may be sent after the response, as on Vercel). */
export async function waitForMail(page: Page, to: string, subject: RegExp) {
  let found: { to: string; subject: string; text: string } | undefined;
  await expect
    .poll(async () => {
      found = [...(await readMailbox(page))].reverse().find((m) => m.to === to && subject.test(m.subject));
      return !!found;
    }, { timeout: 15_000 })
    .toBe(true);
  return found as { to: string; subject: string; text: string };
}
