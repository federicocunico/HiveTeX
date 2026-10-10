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
  throw new Error(`timed out: ${msg} (last: ${last})\n--- page ---\n${String(page).slice(0, 2000)}`);
}
/**
 * The tree item labelled `name`, or null. Matched inside the page on the item's own text (without nested items):
 * WebDriver "element text" differs between WebView2 and WebKitGTK, textContent does not.
 */
async function treeHas(name) {
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
const editorText = async () => (await b.$('.cm-content')).getText();
const PROJECTS_H1 = "//h1[normalize-space()='Your projects']";

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
  await until(async () => (await b.execute(() => document.readyState)) === 'complete', 'app loaded');
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
  await (await b.$("//label[contains(., 'Username')]//input")).setValue(username);
  await (await b.$("//label[contains(., 'Email')]//input")).setValue(`${username}@example.com`);
  const pws = await b.findAll('input[type=password]');
  await pws[0].setValue(PW);
  await pws[1].setValue(PW);
  await (await b.$("//button[normalize-space()='Create account']")).click();
  await b.$(PROJECTS_H1);
});

after(async () => {
  await b?.close().catch(() => {});
});

test('create a project from a cloned folder: the tree comes from disk and edits flow both ways', async () => {
  const dir = uniq('clone-');
  writeDisk(dir, 'paper.tex', '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n');
  writeDisk(dir, 'sections/intro.tex', 'Intro from the clone.\n');
  writeDisk(dir, '.git/HEAD', 'ref: refs/heads/main\n');
  pickNext(dir);
  await (await byTestId('open-folder')).click();
  await byTestId('from-folder');
  const slug = uniq('desk-');
  await (await byTestId('from-folder-slug')).setValue(slug);
  await (await byTestId('from-folder-password')).setValue(PROJECT_PW);
  await (await byTestId('from-folder-create')).click();
  await until(() => treeHas('intro.tex'), 'imported tree');
  assert.equal(await treeHas('HEAD'), null, 'tool folders are not imported');
  assert.match(readDisk(dir, '.hivetex.json') ?? '', new RegExp(slug));

  // an external tool edits the file on disk -> visible in the app
  await (await treeHas('intro.tex')).click();
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
  const slug = uniq('link-');
  await (await b.$('input[placeholder="my-paper-2026"]')).setValue(slug);
  await (await b.$("//form[.//h2[normalize-space()='New project']]//input[@type='password']")).setValue(PROJECT_PW);
  await (await b.$("//button[normalize-space()='Create project']")).click();
  await byTestId('workspace');

  const dir = uniq('linked-');
  pickNext(dir);
  await (await byTestId('location-btn')).click();
  await (await byTestId('link-folder')).click();
  await until(async () => (await textOf('location-btn')).includes(dir), 'folder in use');
  await until(() => JSON.parse(readDisk(dir, '.hivetex.json') ?? '{}').project?.slug === slug, 'marker written');

  // import a folder of sources into the project (also through the confined picker)
  const src = uniq('src-');
  writeDisk(src, 'figs/plot.tex', '% a figure\n');
  pickNext(src);
  await (await byTestId('import-btn')).click();
  await (await byTestId('import-pick-folder')).click();
  await (await byTestId('import-confirm')).click();
  await (await byTestId('import-done')).click();
  await until(() => treeHas('plot.tex'), 'imported file in tree');
  await until(() => readDisk(dir, 'figs/plot.tex') !== null, 'imported file mirrored to the folder');

  // stop using it here, then open the folder: its marker names the project
  await (await byTestId('location-btn')).click();
  await (await byTestId('unlink-folder')).click();
  await home();
  pickNext(dir);
  await (await byTestId('open-folder')).click();
  await until(async () => (await textOf('project-slug')) === slug, 'project opened from marker');
  await until(async () => (await textOf('location-btn')).includes(dir), 'folder bound again');
});

test('without any TeX installed, the first compile sets up the quick compiler and builds on this device', { timeout: 600_000 }, async () => {
  await home();
  const slug = uniq('quick-');
  await (await b.$('input[placeholder="my-paper-2026"]')).setValue(slug);
  await (await b.$("//form[.//h2[normalize-space()='New project']]//input[@type='password']")).setValue(PROJECT_PW);
  await (await b.$("//button[normalize-space()='Create project']")).click();
  await byTestId('workspace');
  // the compiler is set up (download with progress) without any installation step
  await until(async () => /quick compiler/.test(await textOf('compiler-state')), 'quick compiler ready', 300_000);
  await (await b.$('button[aria-label="New file"]')).click();
  await (await byTestId('new-name')).setValue('main.tex');
  await (await byTestId('new-name')).type(Keys.Enter);
  await until(() => treeHas('main.tex'), 'main.tex created');
  await (await treeHas('main.tex')).click();
  const editor = await b.$('.cm-content');
  await editor.click();
  await editor.type(String.raw`\documentclass{article}` + '\n' + String.raw`\begin{document}` + '\nQuick compiler works.\n' + String.raw`\end{document}` + '\n');
  // builds stay local: the PDF is this device's own
  await until(async () => (await textOf('compiled-by')).includes('(this device)'), 'local PDF from the quick compiler', 300_000);
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
  // (the app's data folder may keep pairings from earlier runs: revoke them all)
  await until(async () => {
    if (!(await textOf('compiler-panel')).includes('webuser')) return true;
    await (await byTestId('revoke-pairing')).click();
    return false;
  }, 'pairing revoked');
  const after = await fetch(`${base}/compile`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}` }, body: '{}' });
  assert.equal(after.status, 401);
});
