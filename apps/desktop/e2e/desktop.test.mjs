/**
 * Desktop app UI tests over WebDriver (tauri-driver). Run through `run.mjs`: the app is a debug build with the
 * `test-picker` feature, so "choosing a folder" returns $P2PLATEX_TEST_PICK_DIR/<name written in .next-pick>.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { Keys, Session } from './webdriver.mjs';

const pickBase = process.env.P2PLATEX_TEST_PICK_DIR;
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
async function treeHas(name) {
  for (const it of await b.findAll('[role="treeitem"]')) {
    // text of an item: icon, name and a ★ on the main file; folders also contain their children
    // (WebView2 puts icon and name on separate lines, WebKitGTK on one: strip icons and markers)
    const lines = (await it.getText()).split(/\r?\n/).map((l) => l.replace(/[★📄📁▾▸]/gu, '').trim());
    if (lines.includes(name)) return it;
  }
  return null;
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
  b = await Session.create(`http://127.0.0.1:${process.env.P2PLATEX_DRIVER_PORT ?? 4446}`, {
    browserName: 'wry',
    'tauri:options': { application: process.env.P2PLATEX_APP, args: ['--test-pick-dir', pickBase] },
  });
  await until(async () => (await b.execute(() => document.readyState)) === 'complete', 'app loaded');
  await b.execute(() => {
    localStorage.setItem('p2platex.test', '1');
    localStorage.setItem('p2platex.fakeEngine', '1');
    location.hash = '#/register';
    location.reload();
  });
  await b.$("//label[contains(., 'Repeat password')]", 30_000);
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
  assert.match(readDisk(dir, '.p2platex.json') ?? '', new RegExp(slug));

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
  await until(() => JSON.parse(readDisk(dir, '.p2platex.json') ?? '{}').project?.slug === slug, 'marker written');

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
