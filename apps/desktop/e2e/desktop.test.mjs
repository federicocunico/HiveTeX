/**
 * Desktop app UI tests over WebDriver (tauri-driver). Run through `run.mjs`: the app is a debug build with the
 * `test-picker` feature, so "choosing a folder" returns $HIVETEX_TEST_PICK_DIR/<name written in .next-pick>.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { Keys, Session } from './webdriver.mjs';

const pickBase = process.env.HIVETEX_TEST_PICK_DIR;
const PW = 'correct horse battery staple';
const PROJECT_PW = 'project-secret-1';
let n = 0;
const uniq = (p) => `${p}${Date.now().toString(36)}${n++}`.toLowerCase().slice(0, 28);

/** @type {Session} */
let b;
/** The account registered in before() (signed in again by the local-mode test). */
let deskUser = "";

const pickNext = (name) => writeFileSync(join(pickBase, '.next-pick'), name);
function writeDisk(dir, path, text) {
  const p = join(pickBase, dir, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function readDisk(dir, path) {
  try {
    return readFileSync(join(pickBase, dir, path), 'utf8');
  } catch {
    return null;
  }
}
const byTestId = (id) => b.$(`[data-testid="${id}"]`);
const textOf = async (id) => (await byTestId(id)).getText();
async function until(fn, msg, ms = 15_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // what the user would see (notices, errors) makes CI failures readable
  const page = await b.execute(() => document.body.innerText).catch(() => '');
  const trace = await b.connectionTrace();
  throw new Error(`timed out: ${msg} (last: ${last})\n--- page ---\n${String(page).slice(0, 2000)}${trace ? `\n${trace}` : ''}`);
}
/**
 * The tree item labelled `name`, or null. Matched inside the page on the item's own text (without nested items):
 * WebDriver "element text" differs between WebView2 and WebKitGTK, textContent does not.
 */
async function treeHas(name) {
  if (!(await b.execute(() => !!document.querySelector('aside.side')))) await filesPanel();
  const found = await b.execute((n) => {
    for (const el of document.querySelectorAll('[role="treeitem"]')) {
      const own = el.cloneNode(true);
      for (const nested of own.querySelectorAll('[role="treeitem"], [role="group"]')) nested.remove();
      const words = (own.textContent ?? '').replace(/[★📄📁▾▸]/gu, ' ').split(/\s+/);
      if (words.includes(n)) {
        el.setAttribute('data-e2e-hit', n);
        return true;
      }
    }
    return false;
  }, name);
  return found ? b.find(`[data-e2e-hit="${name}"]`) : null;
}
/**
 * Under 1100 px (the CI runners' screens) the workspace is narrow: the side panel is an overlay opened from the rail,
 * and the editor and the PDF take turns. These make the files panel / a view visible in both layouts.
 */
async function filesPanel() {
  const open = await b.execute(() => !!document.querySelector('aside.side [data-testid="location-btn"]'));
  if (!open) await (await byTestId('rail-files')).click();
  await byTestId('location-btn');
}
async function show(view) {
  await b.execute((v) => {
    for (const btn of document.querySelectorAll('.ws.narrow [aria-label="Show"] button')) if (btn.textContent.trim() === v) btn.click();
  }, view);
}
/** Text of an element even where the narrow layout hides its label. */
const fullText = (id) => b.execute((i) => document.querySelector(`[data-testid="${i}"]`)?.textContent ?? '', id);
const editorText = async () => (await b.$('.cm-content')).getText();
const present = (sel) => b.execute((s) => !!document.querySelector(s), sel);

/**
 * Under 1100 px (CI screens are 1024 × 768) the workspace is in its narrow layout: the side panel stays closed until
 * a rail button opens it, and editor and PDF take turns. These open what a test needs, in either layout.
 */
async function showFiles() {
  if (!(await present('[data-testid="file-tree"]'))) await (await byTestId('rail-files')).click();
  await byTestId('file-tree');
}
async function showPdf() {
  if (!(await present('[data-testid="pdf-pane"]'))) await (await b.$("//div[@aria-label='Show']//button[normalize-space()='PDF']")).click();
  await byTestId('pdf-pane');
}
const PROJECTS_H1 = "//h1[normalize-space()='Your projects']";

async function clickCreateProject() {
  // Retry a real pointer click while the creation form finishes mounting.
  await until(async () => {
    await (await b.$("//button[normalize-space()='Create project']")).click();
    return true;
  }, 'Create project button accepts a pointer click');
}

async function home() {
  await b.execute(() => {
    location.hash = '#/';
  });
  await b.$(PROJECTS_H1);
}

before(async () => {
  b = await Session.create(`http://127.0.0.1:${process.env.HIVETEX_DRIVER_PORT ?? 4446}`, {
    browserName: 'wry',
    'tauri:options': { application: process.env.HIVETEX_APP, args: ['--test-pick-dir', pickBase, '--ignore-system-tex'] },
  });
  await until(async () => (await b.execute(() => document.readyState === 'complete' && !!document.getElementById('app') && location.protocol !== 'about:')) === true, 'app loaded');
  // HIVETEX_WINDOW=1024x768 reproduces a CI screen (the narrow workspace layout) on a larger one
  const [width, height] = (process.env.HIVETEX_WINDOW ?? '').split('x').map(Number);
  if (width && height) await b.cmd('POST', '/window/rect', { width, height });
  await b.execute(() => {
    localStorage.setItem('hivetex.test', '1');
    localStorage.setItem('hivetex.fakeEngine', '1');
    location.hash = '#/register';
    location.reload();
  });
  await b.$("//label[contains(., 'Repeat password')]", 30_000);
  // the server is shown (and changeable) before signing in
  assert.equal(await (await byTestId('server-current')).getText(), 'http://localhost:3000');
  const username = uniq('desk');
  deskUser = username;
  await (await b.$('#reg-user')).setValue(username);
  await (await b.$('#reg-email')).setValue(`${username}@example.com`);
  await (await b.$('#reg-pw')).setValue(PW);
  await (await b.$('#reg-pw2')).setValue(PW);
  await (await b.$("//button[normalize-space()='Create account']")).click();
  await b.$(PROJECTS_H1);
});

after(async () => {
  await b?.close().catch(() => {});
});

async function relaunch() {
  await b.close();
  b = await Session.create(`http://127.0.0.1:${process.env.HIVETEX_DRIVER_PORT ?? 4446}`, {
    browserName: 'wry',
    'tauri:options': { application: process.env.HIVETEX_APP, args: ['--test-pick-dir', pickBase, '--ignore-system-tex'] },
  });
}

test('remembered sign-in survives closing and relaunching the real desktop app', async () => {
  assert.equal(await present('[data-testid="session-notice"]'), false, 'native session storage must succeed; a skipped/failed keychain is not persistence verification');
  await relaunch();
  await b.$(PROJECTS_H1, 30_000);
  assert.match(await b.execute(() => document.body.innerText), new RegExp(deskUser));
  assert.equal(await present('#login-id'), false);
  assert.equal(await present('[data-testid="session-notice"]'), false);
});

test('sign-out survives a real desktop relaunch', async () => {
  await (await b.$('[aria-label="Account menu"]')).click();
  await (await b.$("//button[@role='menuitem'][contains(., 'Sign out')]" )).click();
  await b.$('#login-id');
  await relaunch();
  await b.$('#login-id', 30_000);
  assert.equal(await b.execute(() => !![...document.querySelectorAll('h1')].find(h => h.textContent.trim() === 'Your projects')), false);
  // WebDriver may use a fresh WebView profile per launch; restore test hooks after the persistence assertions.
  await b.execute(() => {
    localStorage.setItem('hivetex.test', '1');
    localStorage.setItem('hivetex.fakeEngine', '1');
    location.reload();
  });
  await b.$('#login-id', 30_000);
  await (await b.$('#login-id')).setValue(deskUser);
  await (await b.$('#login-pw')).setValue(PW);
  await (await b.$("//button[normalize-space()='Sign in']")).click();
  await b.$(PROJECTS_H1);
});

test('create a project from a cloned folder: the tree comes from disk and edits flow both ways', async () => {
  const dir = uniq('clone-');
  writeDisk(dir, 'paper.tex', '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n');
  writeDisk(dir, 'sections/intro.tex', 'Intro from the clone.\n');
  writeDisk(dir, '.git/HEAD', 'ref: refs/heads/main\n');
  pickNext(dir);
  await (await byTestId('open-folder')).click();
  await byTestId('from-folder');
  let slug = uniq('desk-');
  await (await byTestId('from-folder-slug')).setValue(slug);
  await (await byTestId('from-folder-password')).setValue(PROJECT_PW);
  await (await byTestId('from-folder-create')).click();
  await byTestId('workspace');
  await showFiles();
  await until(() => treeHas('intro.tex'), 'imported tree');
  assert.equal(await treeHas('HEAD'), null, 'tool folders are not imported');
  assert.match(readDisk(dir, '.hivetex.json') ?? '', new RegExp(slug));

  // an external tool edits the file on disk -> visible in the app
  await (await treeHas('intro.tex')).click();
  await show('Editor');
  await until(async () => (await editorText()).includes('Intro from the clone.'), 'file opened');
  writeDisk(dir, 'sections/intro.tex', 'Intro rewritten by an AI tool.\n');
  await until(async () => (await editorText()).includes('rewritten by an AI tool'), 'external edit visible');

  // an edit in the app -> written to disk
  const editor = await b.$('.cm-content');
  await editor.click();
  await editor.type(`${Keys.End} Typed in the app.`);
  await until(() => {
    const t = readDisk(dir, 'sections/intro.tex') ?? '';
    return t.includes('rewritten by an AI tool') && t.includes('Typed in the app.');
  }, 'app edit on disk');
});

test('link a folder to a project, then open that folder again from the projects page', async () => {
  await home();
  let slug = uniq('link-');
  await (await byTestId('new-project-btn')).click();
  await (await b.$('input[placeholder="my-paper-2026"]')).setValue(slug);
  await (await b.$("//form[.//h2[normalize-space()='New project']]//input[@type='password']")).setValue(PROJECT_PW);
  await clickCreateProject();
  await byTestId('workspace');
  slug = await fullText('project-slug');
  assert.match(slug, /-[a-z2-7]{16}$/);
  await byTestId('workspace');

  const dir = uniq('linked-');
  pickNext(dir);
  await showFiles();
  await filesPanel();
  await (await byTestId('location-btn')).click();
  await (await byTestId('link-folder')).click();
  await until(async () => (await fullText('location-btn')).includes(dir), 'folder in use');
  await until(() => JSON.parse(readDisk(dir, '.hivetex.json') ?? '{}').project?.slug === slug, 'marker written');

  // import a folder of sources into the project (also through the confined picker)
  const src = uniq('src-');
  writeDisk(src, 'figs/plot.tex', '% a figure\n');
  pickNext(src);
  await filesPanel();
  await (await byTestId('import-btn')).click();
  await (await byTestId('import-pick-folder')).click();
  await (await byTestId('import-confirm')).click();
  await (await byTestId('import-done')).click();
  await showFiles();
  await until(() => treeHas('plot.tex'), 'imported file in tree');
  await until(() => readDisk(dir, 'figs/plot.tex') !== null, 'imported file mirrored to the folder');

  // stop using it here, then open the folder: its marker names the project
  await showFiles();
  await filesPanel();
  await (await byTestId('location-btn')).click();
  await (await byTestId('unlink-folder')).click();
  await home();
  pickNext(dir);
  await (await byTestId('open-folder')).click();
  await until(async () => (await fullText('project-slug')) === slug, 'project opened from marker');
  await showFiles();
  await until(async () => {
    await filesPanel();
    return (await fullText('location-btn')).includes(dir);
  }, 'folder bound again');
});

test('without any TeX installed, the first compile sets up the quick compiler and builds on this device', { timeout: 600_000 }, async () => {
  await home();
  let slug = uniq('quick-');
  await (await byTestId('new-project-btn')).click();
  await (await b.$('input[placeholder="my-paper-2026"]')).setValue(slug);
  await (await b.$("//form[.//h2[normalize-space()='New project']]//input[@type='password']")).setValue(PROJECT_PW);
  await clickCreateProject();
  await byTestId('workspace');
  slug = await fullText('project-slug');
  assert.match(slug, /-[a-z2-7]{16}$/);
  await byTestId('workspace');
  // the compiler is set up (download with progress) without any installation step
  await until(async () => /quick compiler/.test(await textOf('compiler-state')), 'quick compiler ready', 300_000);
  await showFiles();
  await filesPanel();
  await (await b.$('button[aria-label="New file"]')).click();
  await (await byTestId('new-name')).setValue('main.tex');
  await (await byTestId('new-name')).type(Keys.Enter);
  await until(() => treeHas('main.tex'), 'main.tex created');
  await (await treeHas('main.tex')).click();
  await show('Editor');
  const editor = await b.$('.cm-content');
  await editor.click();
  await editor.type(String.raw`\documentclass{article}` + '\n' + String.raw`\begin{document}` + '\nQuick compiler works.\n' + String.raw`\end{document}` + '\n');
  // builds stay local: the PDF is this device's own
  await show('PDF');
  await showPdf();
  await until(async () => (await fullText('compiled-by')).includes('(this device)'), 'local PDF from the quick compiler', 300_000);
  assert.match(await textOf('compiler-state'), /builds stay on this device/);
});

test('the web app pairs with the desktop app (confirmed here), compiles through it, and the pairing can be revoked', { timeout: 600_000 }, async () => {
  const origin = 'https://hivetex.vercel.app';
  let port;
  for (const p of [47812, 47813, 47814, 47815]) {
    const r = await fetch(`http://127.0.0.1:${p}/status`, { headers: { Origin: origin } }).catch(() => null);
    if (r?.ok && (await r.json()).app === 'hivetex') {
      port = p;
      break;
    }
  }
  assert.ok(port, 'helper listening');
  const base = `http://127.0.0.1:${port}`;
  // another website is refused
  assert.equal((await fetch(`${base}/status`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const pairing = fetch(`${base}/pair`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'webuser', server: origin }) });
  await until(() => byTestId('pair-request'), 'pairing asked in the app');
  assert.match(await textOf('pair-request'), /webuser/);
  await (await b.$("//div[@data-testid='pair-request']//button[normalize-space()='Allow']")).click();
  const res = await pairing;
  assert.equal(res.status, 200);
  const { token } = await res.json();
  const doc = String.raw`\documentclass{article}\begin{document}From the browser.\end{document}` + '\n';
  const compiled = await fetch(`${base}/compile`, {
    method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ main: 'main.tex', engine: 'pdflatex', project: 'web1', files: [{ path: 'main.tex', b64: Buffer.from(doc).toString('base64') }] }),
  }).then((r) => r.json());
  assert.equal(compiled.ok, true, compiled.log);
  assert.ok(Buffer.from(compiled.pdfB64, 'base64').subarray(0, 4).toString() === '%PDF');
  assert.equal(compiled.localOnly, true, 'quick compiler builds are not shared');

  // Account > Compiler lists the pairing; revoking it stops the token
  await b.execute(() => {
    location.hash = '#/account';
  });
  await until(async () => (await textOf('compiler-panel')).includes('webuser'), 'pairing listed');
  assert.match(await textOf('current-compiler'), /quick compiler/);
  // SCREENSHOTS=1: the README's picture of the desktop app (Account > Compiler with the quick compiler and a pairing)
  if (process.env.SCREENSHOTS) {
    await b.execute(() => document.querySelector('[data-testid="compiler-settings"]')?.scrollIntoView({ block: 'center' }));
    await new Promise((r) => setTimeout(r, 500));
    writeFileSync(new URL('../../../docs/images/desktop-compiler.png', import.meta.url), Buffer.from(await b.cmd('GET', '/screenshot'), 'base64'));
  }
  // (the app's data folder may keep pairings from earlier runs: revoke them all)
  await until(async () => {
    if (!(await textOf('compiler-panel')).includes('webuser')) return true;
    await (await byTestId('revoke-pairing')).click();
    return false;
  }, 'pairing revoked');
  const after = await fetch(`${base}/compile`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}` }, body: '{}' });
  assert.equal(after.status, 401);
});

test('application relay: the desktop app and a browser without any WebRTC path edit together through the server', { timeout: 300_000 }, async (t) => {
  const web = 'http://localhost:1420';
  if (!(await fetch(web).then((r) => r.ok).catch(() => false))) return t.skip('web dev server not running');
  const { chromium } = await import('@playwright/test');
  const click = async (sel) => {
    await b.$(sel);
    await b.execute((q) => {
      const el = /^[/(]/.test(q) ? document.evaluate(q, document, null, 9, null).singleNodeValue : document.querySelector(q);
      el.click();
    }, sel);
  };
  // No WebRTC path on either side: the desktop test build honours this flag (VITE_E2E=1), the browser gets an init script.
  await b.execute(() => localStorage.setItem('hivetex.e2e.noWebrtc', '1'));
  let slug = uniq('deskrelay-');
  await home();
  await click('[data-testid="new-project-btn"]');
  await (await b.$("//input[@placeholder='my-paper-2026']")).setValue(slug);
  await (await b.$("//form[.//h2[normalize-space()='New project']]//input[@type='password']")).setValue(PROJECT_PW);
  await click("//button[normalize-space()='Create project']");
  await byTestId('workspace');
  slug = await fullText('project-slug');
  await click('[data-testid="settings-btn"]');
  await b.execute(() => {
    const sel = [...document.querySelectorAll('select')].find((s) => s.closest('label')?.textContent?.includes('Default role') || document.querySelector(`label[for="${s.id}"]`)?.textContent?.includes('Default role'));
    sel.value = 'editor';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click("(//button[normalize-space()='Save'])[1]");
  await until(async () => (await fullText('settings-dialog')).includes('Saved'), 'role saved');
  await click("//div[@data-testid='settings-dialog']//button[@aria-label='Close' or normalize-space()='Close']");
  const id = await b.execute(async () => {
    const s = window.__p2p.session;
    const fid = await s.model.createTextNow('main.tex', 'typed on the desktop');
    await s.model.flush();
    return fid;
  });

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ baseURL: web });
    await ctx.addInitScript(() => {
      const Orig = window.RTCPeerConnection;
      window.__pcs = [];
      window.RTCPeerConnection = class extends Orig {
        constructor(cfg) {
          super({ ...cfg, iceServers: [], iceTransportPolicy: 'relay' });
          window.__pcs.push(this);
        }
      };
    });
    const page = await ctx.newPage();
    const user = uniq('webrel');
    await page.goto('/#/register');
    await page.getByLabel('Username').fill(user);
    await page.getByLabel('Email').fill(`${user}@example.com`);
    await page.locator('input[type=password]').nth(0).fill(PW);
    await page.locator('input[type=password]').nth(1).fill(PW);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Your projects' }).waitFor();
    await page.getByTestId('join-btn').click();
    await page.locator('form:has(h2:text("Join a project")) input[type=text]').fill(slug);
    await page.locator('form:has(h2:text("Join a project")) input[type=password]').fill(PROJECT_PW);
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.getByTestId('workspace').waitFor();
    await page.getByRole('treeitem', { name: 'main.tex' }).click({ timeout: 60_000 });
    await page.locator('.cm-content', { hasText: 'typed on the desktop' }).waitFor({ timeout: 60_000 });
    // edits back to the desktop, still without any connected RTCPeerConnection
    await page.locator('.cm-content').click();
    await page.keyboard.type(' and in the browser');
    await until(() => b.execute(async (f) => (await window.__p2p.session.model.openText(f)).toString().includes('and in the browser'), id), 'browser edit on the desktop', 60_000);
    assert.equal(await page.evaluate(() => window.__pcs.filter((pc) => pc.connectionState === 'connected').length), 0);
    assert.equal(await b.execute(() => window.__p2p.session.peers.map((p) => p.route).join(',')), 'relay');
  } finally {
    await browser.close();
    await b.execute(() => localStorage.removeItem('hivetex.e2e.noWebrtc'));
  }
});

test('application relay only (13.7): payload loss, socket rotation and instance replacement between the desktop app and a browser', { timeout: 400_000 }, async (t) => {
  const web = 'http://localhost:1420';
  const api = 'http://localhost:3000';
  if (!(await fetch(web).then((r) => r.ok).catch(() => false))) return t.skip('web dev server not running');
  if (!(await fetch(`${api}/api/__dev/faults`).then((r) => r.ok).catch(() => false))) return t.skip('local server without fault injection');
  const { chromium } = await import('@playwright/test');
  const fault = (q) => fetch(`${api}/api/__dev/faults?${q}`).then((r) => r.json());
  const terminate = () => fetch(`${api}/api/__dev/signal/terminate`).then((r) => r.json());
  const click = async (sel) => {
    await b.$(sel);
    await b.execute((q) => {
      const el = /^[/(]/.test(q) ? document.evaluate(q, document, null, 9, null).singleNodeValue : document.querySelector(q);
      el.click();
    }, sel);
  };
  await b.execute(() => localStorage.setItem('hivetex.e2e.noWebrtc', '1'));
  let slug = uniq('desk137-');
  await home();
  await click('[data-testid="new-project-btn"]');
  await (await b.$("//input[@placeholder='my-paper-2026']")).setValue(slug);
  await (await b.$("//form[.//h2[normalize-space()='New project']]//input[@type='password']")).setValue(PROJECT_PW);
  await click("//button[normalize-space()='Create project']");
  await byTestId('workspace');
  slug = await fullText('project-slug');
  await click('[data-testid="settings-btn"]');
  await b.execute(() => {
    const sel = [...document.querySelectorAll('select')].find((s) => s.closest('label')?.textContent?.includes('Default role') || document.querySelector(`label[for="${s.id}"]`)?.textContent?.includes('Default role'));
    sel.value = 'editor';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click("(//button[normalize-space()='Save'])[1]");
  await until(async () => (await fullText('settings-dialog')).includes('Saved'), 'role saved');
  await click("//div[@data-testid='settings-dialog']//button[@aria-label='Close' or normalize-space()='Close']");
  const id = await b.execute(async () => {
    const s = window.__p2p.session;
    const fid = await s.model.createTextNow('main.tex', 'relay137');
    await s.model.flush();
    return fid;
  });
  const deskText = () => b.execute(async (f) => (await window.__p2p.session.model.openText(f)).toString(), id);
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ baseURL: web });
    await ctx.addInitScript(() => localStorage.setItem('hivetex.test', '1'));
    await ctx.addInitScript(() => {
      const Orig = window.RTCPeerConnection;
      window.__pcs = [];
      window.RTCPeerConnection = class extends Orig {
        constructor(cfg) {
          super({ ...cfg, iceServers: [], iceTransportPolicy: 'relay' });
          window.__pcs.push(this);
        }
      };
    });
    const page = await ctx.newPage();
    const user = uniq('web137');
    await page.goto('/#/register');
    await page.getByLabel('Username').fill(user);
    await page.getByLabel('Email').fill(`${user}@example.com`);
    await page.locator('input[type=password]').nth(0).fill(PW);
    await page.locator('input[type=password]').nth(1).fill(PW);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Your projects' }).waitFor();
    await page.getByTestId('join-btn').click();
    await page.locator('form:has(h2:text("Join a project")) input[type=text]').fill(slug);
    await page.locator('form:has(h2:text("Join a project")) input[type=password]').fill(PROJECT_PW);
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.getByTestId('workspace').waitFor();
    await page.getByRole('treeitem', { name: 'main.tex' }).click({ timeout: 60_000 });
    await page.locator('.cm-content', { hasText: 'relay137' }).waitFor({ timeout: 60_000 });
    const webText = () => page.evaluate(async () => { const s = window.__p2p.session; return (await s.model.openText(s.model.find('main.tex').id)).toString(); });
    const webInsert = (txt) => page.evaluate(async (x) => { const s = window.__p2p.session; const t = await s.model.openText(s.model.find('main.tex').id); t.insert(t.length, x); }, txt);
    const deskInsert = (txt) => b.execute(async (f, x) => { const t = await window.__p2p.session.model.openText(f); t.insert(t.length, x); }, id, txt);
    assert.equal(await b.execute(() => window.__p2p.session.peers.map((p) => p.route).join(',')), 'relay');
    const peerUser = await b.execute(() => window.__p2p.session.peers.map((p) => p.uname).join(','));
    assert.equal(peerUser, user, 'the relayed peer is the authenticated browser member');

    // 1. Payload loss: a fifth of relayed ciphertext frames vanish; retransmission still delivers everything once.
    await fault('relayDrop=0.2');
    for (let n = 0; n < 30; n++) { await webInsert(` w${n}`); if (n % 3 === 0) await deskInsert(` d${n}`); await new Promise((r) => setTimeout(r, 40)); }
    await until(async () => (await deskText()).includes(' w29') && (await webText()).includes(' d27'), 'every edit despite 20% frame loss', 90_000);
    await fault('relayDrop=0');
    assert.equal((await deskText()).match(/ w\d+/g).length, 30, 'no duplicated insertions');

    // 2. Rotation: every signaling socket ends abruptly (the 300 s platform limit); both endpoints come back.
    const before = (await terminate()).terminated;
    assert.ok(before >= 2, `sockets terminated: ${before}`);
    await webInsert(' after-rotation');
    await until(async () => (await deskText()).includes('after-rotation'), 'edit after rotation', 90_000);
    await deskInsert(' back-after-rotation');
    await until(async () => (await webText()).includes('back-after-rotation'), 'desktop edit after rotation', 90_000);

    // 3. Instance replacement during an asset transfer: the sockets go away twice while a 400 kB image is in flight.
    const hash = await b.execute(async () => {
      const s = window.__p2p.session;
      const png = new Uint8Array(400_000).map((_, i) => (i * 13) % 251);
      const h = await s.blobs.add(png);
      s.model.createBinary('fig137.png', h, png.length);
      await s.model.flush();
      return h;
    });
    await new Promise((r) => setTimeout(r, 300));
    await terminate();
    await new Promise((r) => setTimeout(r, 1500));
    await terminate();
    await until(() => page.evaluate((h) => window.__p2p.session.blobs.has(h), hash), 'asset after instance replacements', 120_000);
    const bytes = await page.evaluate(async (h) => { const b = await window.__p2p.session.store.getBlob(h); return b ? b.length : 0; }, hash).catch(() => -1);
    if (bytes !== -1) assert.equal(bytes, 400_000);
    // Still relay-only and authenticated after all of it.
    assert.equal(await page.evaluate(() => window.__pcs.filter((pc) => pc.connectionState === 'connected').length), 0);
    assert.equal(await b.execute(() => window.__p2p.session.peers.map((p) => `${p.route}:${p.uname}`).join(',')), `relay:${user}`);
  } finally {
    await fault('relayDrop=0').catch(() => {});
    await browser.close();
    await b.execute(() => localStorage.removeItem('hivetex.e2e.noWebrtc'));
  }
});

test('doorbell: the desktop app waits without a server connection and is rung awake by a browser that opens the project', { timeout: 300_000 }, async (t) => {
  const web = 'http://localhost:1420';
  if (!(await fetch(web).then((r) => r.ok).catch(() => false))) return t.skip('web dev server not running');
  const { chromium } = await import('@playwright/test');
  const click = async (sel) => {
    await b.$(sel);
    await b.execute((q) => {
      const el = /^[/(]/.test(q) ? document.evaluate(q, document, null, 9, null).singleNodeValue : document.querySelector(q);
      el.click();
    }, sel);
  };
  const desk = () => b.execute(() => {
    const s = window.__p2p.session;
    const d = s.runtime?.managerDiagnostics;
    return { socket: d?.socketOpen ?? false, bell: d?.doorbellMode ?? false, answers: d?.answers ?? 0, peers: s.peers.length };
  });
  let slug = uniq('deskbell-');
  await home();
  await click('[data-testid="new-project-btn"]');
  await (await b.$("//input[@placeholder='my-paper-2026']")).setValue(slug);
  await (await b.$("//form[.//h2[normalize-space()='New project']]//input[@type='password']")).setValue(PROJECT_PW);
  await click("//button[normalize-space()='Create project']");
  await byTestId('workspace');
  slug = await fullText('project-slug');
  await click('[data-testid="settings-btn"]');
  await b.execute(() => {
    const sel = [...document.querySelectorAll('select')].find((s) => s.closest('label')?.textContent?.includes('Default role') || document.querySelector(`label[for="${s.id}"]`)?.textContent?.includes('Default role'));
    sel.value = 'editor';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click("(//button[normalize-space()='Save'])[1]");
  await until(async () => (await fullText('settings-dialog')).includes('Saved'), 'role saved');
  await click("//div[@data-testid='settings-dialog']//button[@aria-label='Close' or normalize-space()='Close']");
  const id = await b.execute(async () => {
    const s = window.__p2p.session;
    const fid = await s.model.createTextNow('main.tex', 'kept on the sleeping desktop');
    await s.model.flush();
    return fid;
  });
  // Alone: the introduction window ends and the app keeps no connection to the server.
  await until(async () => { const d = await desk(); return d.bell && !d.socket; }, 'desktop dormant without a socket', 90_000);
  const projectId = await b.execute(() => window.__p2p.session.project.id);
  const catalog = () => b.execute(async () => JSON.parse(await window.__TAURI_INTERNALS__.invoke('worker_request', { method: 'catalog.list', params: '{}' })));
  await home();
  await until(async () => {
    const entry = (await catalog()).projects.find((p) => p.project.project === projectId);
    return entry?.stage === 'dormant' && !entry.status;
  }, 'retained seed dormant with no editor or live actor', 30_000);
  assert.equal(await present('[data-testid="workspace"]'), false);

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ baseURL: web });
    await ctx.addInitScript(() => localStorage.setItem('hivetex.test', '1'));
    const page = await ctx.newPage();
    const user = uniq('webbell');
    await page.goto('/#/register');
    await page.getByLabel('Username').fill(user);
    await page.getByLabel('Email').fill(`${user}@example.com`);
    await page.locator('input[type=password]').nth(0).fill(PW);
    await page.locator('input[type=password]').nth(1).fill(PW);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Your projects' }).waitFor();
    await page.getByTestId('join-btn').click();
    await page.locator('form:has(h2:text("Join a project")) input[type=text]').fill(slug);
    await page.locator('form:has(h2:text("Join a project")) input[type=password]').fill(PROJECT_PW);
    const rang = Date.now();
    await page.getByRole('button', { name: 'Join', exact: true }).click();
    await page.getByTestId('workspace').waitFor();
    await page.getByRole('treeitem', { name: 'main.tex' }).click({ timeout: 60_000 });
    await page.locator('.cm-content', { hasText: 'kept on the sleeping desktop' }).waitFor({ timeout: 60_000 });
    console.log(`# desktop ring-to-content ${Date.now() - rang} ms`);
    await until(async () => (await catalog()).projects.some((p) => p.project.project === projectId && p.status?.diagnostics?.answers > 0), 'the headless desktop answered a ring', 30_000);
    await page.locator('.cm-content').click();
    await page.keyboard.type(' and the browser replied');
    await b.execute((pid) => { location.hash = '#/p/' + pid; }, projectId);
    await byTestId('workspace');
    await until(() => b.execute(async (f) => (await window.__p2p.session.model.openText(f)).toString().includes('the browser replied'), id), 'browser edit on the desktop', 60_000);
    await until(async () => !(await desk()).socket && !(await page.evaluate(() => window.__p2p.session.runtime?.managerDiagnostics?.socketOpen ?? false)), 'no socket on either side', 60_000);
  } finally {
    await browser.close();
  }
});

test('right-click Files > Open folder puts a project kept in the app in Documents/HiveTeX, and disk changes show up live', { timeout: 300_000 }, async () => {
  await home();
  let slug = uniq('ctx-');
  await (await byTestId('new-project-btn')).click();
  await (await b.$('input[placeholder="my-paper-2026"]')).setValue(slug);
  await (await b.$("//form[.//h2[normalize-space()='New project']]//input[@type='password']")).setValue(PROJECT_PW);
  await clickCreateProject();
  await byTestId('workspace');
  slug = await fullText('project-slug');
  assert.match(slug, /-[a-z2-7]{16}$/);
  await byTestId('workspace');
  await filesPanel();
  await (await b.$('button[aria-label="New file"]')).click();
  await (await byTestId('new-name')).setValue('main.tex');
  await (await byTestId('new-name')).type(Keys.Enter);
  await until(() => treeHas('main.tex'), 'main.tex created');
  assert.match(await fullText('location-btn'), /In the app/);

  // right-click a file: the menu offers the folder actions
  const menuFor = async (name) => {
    await treeHas(name);
    await b.execute((n) => {
      const el = document.querySelector(`[data-e2e-hit="${n}"]`);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 8 }));
    }, name);
    return byTestId('files-menu');
  };
  await menuFor('main.tex');
  for (const id of ['ctx-open-folder', 'ctx-terminal', 'ctx-copy-path', 'ctx-reveal']) assert.ok(await b.find(`[data-testid="${id}"]`), id);
  // test builds record what would have been opened instead of opening it
  const opened = join(pickBase, '.opened');
  writeFileSync(opened, '');
  const openedLine = (kind) => readFileSync(opened, 'utf8').split('\n').find((l) => l.startsWith(`${kind} `) && l.includes('HiveTeX') && l.endsWith(slug));

  // Open folder: the project is put in <Documents>/HiveTeX/<slug>, and that folder opens
  await (await byTestId('ctx-open-folder')).click();
  const folder = join('HiveTeX', slug);
  await until(() => readDisk(folder, 'main.tex') !== null, 'project files written to Documents/HiveTeX/<slug>');
  await until(() => openedLine('folder'), 'the folder was opened');
  await until(async () => {
    await filesPanel();
    return (await fullText('location-btn')).includes(slug);
  }, 'the project now lives in that folder');
  assert.match(readDisk(folder, '.hivetex.json') ?? '', new RegExp(slug));

  // an AI tool adds a file and edits another on disk: both show up in the app at once
  writeDisk(folder, 'sections/related.tex', 'Related work, written by an AI tool.\n');
  await until(() => treeHas('related.tex'), 'file created on disk appears in the tree');
  await (await treeHas('main.tex')).click();
  await show('Editor');
  writeDisk(folder, 'main.tex', '\documentclass{article}\n\begin{document}\nRewritten on disk.\n\end{document}\n');
  await until(async () => (await editorText()).includes('Rewritten on disk.'), 'disk edit visible in the editor');

  // Open in terminal and Copy folder path use the same folder (no second one is created)
  await menuFor('main.tex');
  await (await byTestId('ctx-terminal')).click();
  await until(() => openedLine('terminal'), 'terminal opened in the folder');
  await menuFor('main.tex');
  await (await byTestId('ctx-copy-path')).click();
  const dir = join(pickBase, 'HiveTeX', slug);
  await until(async () => (await b.execute(() => document.body.innerText)).includes(`Copied ${dir}`), 'path copied');
  assert.equal(readDisk(join('HiveTeX', `${slug}-2`), 'main.tex'), null, 'no second folder');
});

test('local mode: no account, nothing sent anywhere; later sign in, share one local project and merge another into it', { timeout: 600_000 }, async () => {
  // Toasts can sit over buttons at click time: click through the DOM once the element is shown.
  const click = async (sel) => {
    await b.$(sel);
    await b.execute((q) => {
      const el = q.startsWith('/') ? document.evaluate(q, document, null, 9, null).singleNodeValue : document.querySelector(q);
      el.click();
    }, sel);
  };
  const setMain = (text) =>
    b.execute(async (t) => {
      const s = window.__p2p.session;
      const f = s.model.find('main.tex') ?? s.model.list().find((x) => x.kind === 'text');
      const y = await s.model.openText(f.id);
      y.doc.transact(() => {
        y.delete(0, y.length);
        y.insert(0, t);
      });
      await s.model.flush();
      return f.path;
    }, text);
  const mainText = () => b.execute(async () => { const s = window.__p2p.session; const f = s.model.find('main.tex'); return f ? (await s.model.openText(f.id)).toString() : null; });
  const newLocal = async (name) => {
    await home();
    await click('[data-testid="new-project-btn"]');
    await click('[data-testid="template-article"]');
    await (await b.$('#np-slug')).setValue(name);
    await click("//button[normalize-space()='Create project']");
    await byTestId('workspace');
    await until(() => b.execute(() => !!window.__p2p?.session?.model.find('main.tex')), 'template written');
  };

  // sign out, then continue without an account
  await home();
  await click('button[aria-label="Account menu"]');
  await click("//button[@role='menuitem'][normalize-space()='Sign out']");
  await byTestId('continue-local');
  await b.execute(() => document.querySelector('[data-testid="continue-local"]').click());
  await byTestId('local-mode');
  // from now on, record every request and socket the app opens
  await b.execute(() => {
    window.__net = [];
    const f = window.fetch;
    window.fetch = (u, o) => (window.__net.push(String(u?.url ?? u)), f(u, o));
    const W = window.WebSocket;
    window.WebSocket = function (u, p) {
      window.__net.push(`ws ${u}`);
      return new W(u, p);
    };
  });
  await newLocal('Local A');
  assert.match(await fullText('local-project-pill'), /On this computer/);
  await setMain(String.raw`\documentclass{article}` + '\n' + String.raw`\begin{document}` + '\nVersion A.\n' + String.raw`\end{document}` + '\n');
  await show('PDF');
  await until(async () => (await fullText('compiled-by')).length > 0, 'compiled locally', 300_000);
  await newLocal('Local B');
  await setMain(String.raw`\documentclass{article}` + '\n' + String.raw`\begin{document}` + '\nVersion B.\n' + String.raw`\end{document}` + '\n');
  const net = await b.execute(() => window.__net.filter((u) => u.includes(':3000') || u.includes('/api/') || u.startsWith('ws ')));
  assert.deepEqual(net, [], `local mode contacted: ${net.join(', ')}`);

  // sign in: both local projects are listed with Share / Merge
  await home();
  await click('[data-testid="local-sign-in"]');
  await (await b.$('#login-id')).setValue(deskUser);
  await (await b.$('#login-pw')).setValue(PW);
  await click("//button[normalize-space()='Sign in']");
  await b.$(PROJECTS_H1);
  await until(async () => (await b.findAll('[data-testid="local-project"]')).length === 2, 'two local projects listed');

  // share A: a shared project with its files
  let slug = uniq('shared-');
  const action = (name, testid) => b.$(`//div[@data-testid='local-project'][.//strong[normalize-space()='${name}']]//button[@data-testid='${testid}']`);
  await click(`//div[@data-testid='local-project'][.//strong[normalize-space()='${'Local A'}']]//button[@data-testid='${'publish-local'}']`);
  await (await byTestId('local-slug')).setValue(slug);
  await (await byTestId('local-password')).setValue(PROJECT_PW);
  await click('[data-testid="local-action-submit"]');
  await byTestId('workspace');
  await until(async () => (await fullText('project-slug')).startsWith(slug + '-'), 'shared project opened');
  slug = await fullText('project-slug');
  await until(async () => (await mainText())?.includes('Version A.'), 'files of A in the shared project');

  // merge B into it: main.tex differs, so it is a conflict; keep mine (B)
  await home();
  await until(async () => (await b.findAll('[data-testid="local-project"]')).length === 1, 'A no longer local');
  await click(`//div[@data-testid='local-project'][.//strong[normalize-space()='${'Local B'}']]//button[@data-testid='${'link-local'}']`);
  await (await byTestId('local-slug')).setValue(slug);
  await (await byTestId('local-password')).setValue(PROJECT_PW);
  await click('[data-testid="local-action-submit"]');
  await byTestId('workspace');
  await until(() => byTestId('conflict-dialog'), 'conflict to resolve', 120_000);
  await click('[data-testid="keep-mine"]');
  await click('[data-testid="apply-resolution"]');
  await byTestId('no-conflicts');
  await until(async () => (await mainText())?.includes('Version B.'), 'B kept after the merge');
  await home();
  assert.equal((await b.findAll('[data-testid="local-project"]')).length, 0, 'no local project left');
});

// Last: Quit ends the app this WebDriver session drives. (Close-to-background and second launch: lifecycle.mjs.)
test('launch at login is opt-in and removable; Quit flushes, stops the worker and exits', { timeout: 120_000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const invoke = (cmd, args = {}) => b.execute(async (c, a) => JSON.stringify((await window.__TAURI_INTERNALS__.invoke(c, a)) ?? null), cmd, args).then(JSON.parse);
  const ps = (script) => (spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).stdout ?? '').trim();
  const initial = await invoke('startup_get');
  assert.equal(initial.login, false, 'not registered until the user selects it');
  assert.equal(initial.tray, true, 'tray available on this desktop');
  if (process.platform !== 'win32') return;
  const runKey = () => ps("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' | Out-String -Width 400");
  await invoke('startup_set', { login: true, background: true });
  assert.match(runKey(), /hivetex-desktop.*--background/i);
  assert.equal((await invoke('startup_get')).background, true);
  await invoke('startup_set', { login: false, background: false });
  assert.doesNotMatch(runKey(), /hivetex-desktop/i, 'deselecting removes the registration');

  const pid = Number(ps('(Get-Process hivetex-desktop | Select-Object -First 1).Id'));
  const alive = () => ps(`Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`) !== '';
  const workers = () => Number(ps(`(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*hivetex-worker*' } | Measure-Object).Count`) || 0);
  assert.equal(workers(), 1);
  await b.execute(() => { void window.__TAURI_INTERNALS__.invoke('app_quit', { discard: false }); });
  const end = Date.now() + 30_000;
  while (Date.now() < end && alive()) await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(), false, 'the app exited after Quit');
  assert.equal(workers(), 0, 'the sync worker exited too');
});

