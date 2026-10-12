/**
 * CPU of the desktop app while a co-author keeps a project awake (diagnostic for 13.2). Run through run.mjs:
 *   HIVETEX_E2E_FILE=cpu.test.mjs node apps/desktop/e2e/run.mjs
 * Counts worker events by name in the webview and samples the app process CPU, first on the projects page (which
 * lists background projects), then on the account page (which does not).
 */
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { Session } from './webdriver.mjs';

const PW = 'correct horse battery staple';
const PROJECT_PW = 'project-secret-1';
const web = 'http://localhost:1420';
let b;
const uniq = (p) => `${p}${Date.now().toString(36)}`.toLowerCase().slice(0, 28);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (sel) => b.execute((q) => {
  const el = /^[/(]/.test(q) ? document.evaluate(q, document, null, 9, null).singleNodeValue : document.querySelector(q);
  el.click();
}, sel);
const ps = (script) => (spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).stdout ?? '').trim();
const appCpu = () => Number(ps('(Get-Process hivetex-desktop | Select-Object -First 1).TotalProcessorTime.TotalSeconds'));
async function until(fn, msg, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(250); }
  throw new Error(`timed out: ${msg}`);
}

before(async () => {
  b = await Session.create(`http://127.0.0.1:${process.env.HIVETEX_DRIVER_PORT ?? 4446}`, {
    browserName: 'wry',
    'tauri:options': { application: process.env.HIVETEX_APP, args: ['--test-pick-dir', process.env.HIVETEX_TEST_PICK_DIR, '--ignore-system-tex'] },
  });
  await until(async () => (await b.execute(() => document.readyState === 'complete' && !!document.getElementById('app'))) === true, 'app loaded');
  await b.execute(() => { localStorage.setItem('hivetex.test', '1'); location.hash = '#/register'; location.reload(); });
  await b.$("//label[contains(., 'Repeat password')]", 30_000);
  const u = uniq('cpu');
  await (await b.$('#reg-user')).setValue(u);
  await (await b.$('#reg-email')).setValue(`${u}@example.com`);
  await (await b.$('#reg-pw')).setValue(PW);
  await (await b.$('#reg-pw2')).setValue(PW);
  await (await b.$("//button[normalize-space()='Create account']")).click();
  await b.$("//h1[normalize-space()='Your projects']");
});
after(async () => { await b?.close().catch(() => {}); });

test('app CPU and worker event rate while a co-author keeps a project awake', { timeout: 600_000 }, async () => {
  const { chromium } = await import('@playwright/test');
  const slug = uniq('cpu-');
  await click('[data-testid="new-project-btn"]');
  await (await b.$("//input[@placeholder='my-paper-2026']")).setValue(slug);
  await (await b.$("//form[.//h2[normalize-space()='New project']]//input[@type='password']")).setValue(PROJECT_PW);
  await click("//button[normalize-space()='Create project']");
  await b.$('[data-testid="workspace"]');
  await b.execute(async () => { const s = window.__p2p.session; await s.model.createTextNow('main.tex', 'cpu'); await s.model.flush(); });
  await b.execute(() => { location.hash = '#/'; });
  await b.$("//h1[normalize-space()='Your projects']");
  // Count worker events in the page.
  await b.execute(() => {
    window.__ev = {};
    const T = window.__TAURI_INTERNALS__;
    const handler = T.transformCallback((e) => { const n = e?.payload?.event ?? '?'; window.__ev[n] = (window.__ev[n] ?? 0) + 1; });
    return T.invoke('plugin:event|listen', { event: 'worker://event', target: { kind: 'Any' }, handler });
  });
  await b.execute(() => {
    const T = window.__TAURI_INTERNALS__;
    window.__calls = {};
    const orig = T.invoke.bind(T);
    T.invoke = (cmd, args, opts) => {
      const k = cmd === 'worker_request' ? `worker:${args?.method}` : cmd;
      window.__calls[k] = (window.__calls[k] ?? 0) + 1;
      return orig(cmd, args, opts);
    };
  });
  const events = () => b.execute(() => { const e = { ...window.__ev, calls: window.__calls }; window.__ev = {}; window.__calls = {}; return e; });
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ baseURL: web });
    await ctx.addInitScript(() => localStorage.setItem('hivetex.test', '1'));
    const page = await ctx.newPage();
    const u = uniq('cpuweb');
    await page.goto('/#/register');
    await page.getByLabel('Username').fill(u);
    await page.getByLabel('Email').fill(`${u}@example.com`);
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
    await page.locator('.cm-content', { hasText: 'cpu' }).waitFor({ timeout: 60_000 });
    await sleep(10_000);
    const threads = () => Object.fromEntries(ps('(Get-Process hivetex-desktop | Select-Object -First 1).Threads | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalSeconds)" }').split(/\r?\n/).map((l) => l.trim().split(' ')).map(([i, s]) => [i, Number(s)]));
    // The module that contains each thread's start address (Rust/tokio threads start in the exe, WebView2 ones in its DLLs).
    const modules = () => Object.fromEntries(ps(`$p = Get-Process hivetex-desktop | Select-Object -First 1
$mods = $p.Modules | ForEach-Object { [pscustomobject]@{ n = $_.ModuleName; b = [int64]$_.BaseAddress; e = [int64]$_.BaseAddress + $_.ModuleMemorySize } }
$p.Threads | ForEach-Object { $a = [int64]$_.StartAddress; $m = ($mods | Where-Object { $a -ge $_.b -and $a -lt $_.e } | Select-Object -First 1).n; "$($_.Id) $m" }`).split(/\r?\n/).map((l) => l.trim().split(' ')));
    const measure = async (label) => {
      await events();
      const c0 = appCpu();
      const th0 = threads();
      const t0 = Date.now();
      await sleep(30_000);
      const th1 = threads();
      const pct = ((appCpu() - c0) / ((Date.now() - t0) / 1000)) * 100;
      const ids = Object.keys(th1);
      const mods = modules();
      const hot = ids.map((i) => [i, (th1[i] - (th0[i] ?? 0)) / 30 * 100, ids.indexOf(i)]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([i, p, idx]) => `thread ${i} (#${idx}, ${mods[i] ?? '?'}) ${p.toFixed(1)}%`);
      console.log(`# ${label}: app CPU ${pct.toFixed(1)}% of one core; worker events in 30 s: ${JSON.stringify(await events())}; hottest: ${hot.join(', ')}`);
      return pct;
    };
    await b.execute(() => { location.hash = '#/account'; });
    await sleep(3000);
    for (const [label, cmd, args] of [['startup_get', 'startup_get', {}], ['upnp_status', 'upnp_status', {}], ['catalog.list', 'worker_request', { method: 'catalog.list', params: '{}' }]]) {
      const c0 = appCpu();
      const t0 = Date.now();
      const size = await b.execute(async (c, a) => { let n = 0; for (let i = 0; i < 20; i++) n = JSON.stringify(await window.__TAURI_INTERNALS__.invoke(c, a)).length; return n; }, cmd, args);
      console.log(`# 20 x ${label}: ${(appCpu() - c0).toFixed(2)} s app CPU in ${Date.now() - t0} ms, reply ${size} bytes`);
    }
    await measure('awake, account page');
    await b.execute(() => { location.hash = '#/'; });
    await sleep(3000);
    await measure('awake, projects page');
    await b.execute(() => { const d = document.querySelector('[data-testid=background-seeds]'); if (d) d.remove(); });
    await measure('awake, projects page without the background panel');
    await page.close();
    await sleep(60_000);
    await measure('dormant, projects page');
  } finally {
    await browser.close();
  }
});
