/**
 * Background soak (13.2), Windows: the real desktop app keeps a retained project with no editor for SOAK_MINUTES
 * (default 60) while a browser co-author repeatedly wakes it. Run through run.mjs:
 *
 *   REQUEST_LOG=<file> SOAK_MINUTES=60 HIVETEX_E2E_FILE=soak.test.mjs node apps/desktop/e2e/run.mjs
 *
 * Each cycle is a dormant phase (the worker must make no control-plane request and hold no socket), then a wake:
 * the browser opens the project (ring), checks text and image, types one numbered line, and leaves. One long wake
 * (16 min) spans a ticket refresh. Every third cycle signals a network change or a resume from sleep. Every 30 s the
 * app and worker processes are sampled (CPU time, working set, handles, threads), along with the catalog stage and
 * port mapping state. At the end the desktop editor must hold every line, and the samples must stay bounded.
 * Results go to $SOAK_OUT (JSON).
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { Session } from './webdriver.mjs';

const MINUTES = Number(process.env.SOAK_MINUTES ?? 60);
const LOG = process.env.REQUEST_LOG;
const OUT = process.env.SOAK_OUT ?? 'soak-result.json';
const PW = 'correct horse battery staple';
const PROJECT_PW = 'project-secret-1';
const web = process.env.SOAK_WEB_URL ?? 'http://localhost:1420';
let b;
const uniq = (p) => `${p}${Date.now().toString(36)}`.toLowerCase().slice(0, 28);
const byTestId = (id) => b.$(`[data-testid="${id}"]`);
const fullText = (id) => b.execute((i) => document.querySelector(`[data-testid="${i}"]`)?.textContent ?? '', id);
const click = (sel) => b.execute((q) => {
  const el = /^[/(]/.test(q) ? document.evaluate(q, document, null, 9, null).singleNodeValue : document.querySelector(q);
  el.click();
}, sel);
const invoke = (cmd, args = {}) => b.execute(async (c, a) => JSON.stringify((await window.__TAURI_INTERNALS__.invoke(c, a)) ?? null), cmd, args).then(JSON.parse);
const worker = (method, params = {}) => b.execute(async (m, p) => JSON.parse(await window.__TAURI_INTERNALS__.invoke('worker_request', { method: m, params: JSON.stringify(p) })), method, params);
const ps = (script) => (spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).stdout ?? '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, msg, ms = 30_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(`timed out: ${msg} (last: ${last})`);
}
async function home() {
  await b.execute(() => { location.hash = '#/'; });
  await b.$("//h1[normalize-space()='Your projects']");
}
/** App and worker process metrics. */
function sample() {
  const raw = ps(`$a = Get-Process hivetex-desktop -ErrorAction SilentlyContinue | Select-Object -First 1
$w = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*hivetex-worker*' } | Select-Object -First 1
$wp = if ($w) { Get-Process -Id $w.ProcessId -ErrorAction SilentlyContinue } else { $null }
@{ app = @{ cpu = $a.TotalProcessorTime.TotalSeconds; ws = $a.WorkingSet64; handles = $a.HandleCount; threads = $a.Threads.Count };
   worker = @{ pid = $w.ProcessId; cpu = $wp.TotalProcessorTime.TotalSeconds; ws = $wp.WorkingSet64; handles = $wp.HandleCount; threads = $wp.Threads.Count } } | ConvertTo-Json -Compress`);
  return JSON.parse(raw || '{}');
}
/** Requests in the server log within [from, to), split into worker (Node) and others. */
function requests(from, to) {
  if (!LOG) return null;
  const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.t >= from && r.t < to);
  // The worker's fetch/WebSocket identify as Node (or send no user agent); pages are browsers.
  const isWorker = (r) => /^node$|undici/i.test(r.ua ?? '') || (!r.ua && !r.origin);
  const controlPlane = (r) => r.path.startsWith('/api');
  return {
    worker: lines.filter((r) => isWorker(r) && controlPlane(r)),
    workerPush: lines.filter((r) => isWorker(r) && r.path.startsWith('/__dev/push')),
    other: lines.filter((r) => !isWorker(r)),
  };
}

before(async () => {
  b = await Session.create(`http://127.0.0.1:${process.env.HIVETEX_DRIVER_PORT ?? 4446}`, {
    browserName: 'wry',
    'tauri:options': { application: process.env.HIVETEX_APP, args: ['--test-pick-dir', process.env.HIVETEX_TEST_PICK_DIR, '--ignore-system-tex'] },
  });
  await until(async () => (await b.execute(() => document.readyState === 'complete' && !!document.getElementById('app'))) === true, 'app loaded');
  await b.execute(() => { localStorage.setItem('hivetex.test', '1'); location.hash = '#/register'; location.reload(); });
  await b.$("//label[contains(., 'Repeat password')]", 30_000);
  const username = uniq('soak');
  await (await b.$('#reg-user')).setValue(username);
  await (await b.$('#reg-email')).setValue(`${username}@example.com`);
  await (await b.$('#reg-pw')).setValue(PW);
  await (await b.$('#reg-pw2')).setValue(PW);
  await (await b.$("//button[normalize-space()='Create account']")).click();
  await b.$("//h1[normalize-space()='Your projects']");
});
after(async () => { await b?.close().catch(() => {}); });

test(`background soak: ${MINUTES} minutes of dormant periods and wake cycles`, { timeout: (MINUTES + 20) * 60_000 }, async (t) => {
  if (!(await fetch(web).then((r) => r.ok).catch(() => false))) return t.skip('web dev server not running');
  const { chromium } = await import('@playwright/test');
  // A shared project with one text and one image, kept on the desktop.
  const slug = uniq('soak-');
  await home();
  await click('[data-testid="new-project-btn"]');
  await (await b.$("//input[@placeholder='my-paper-2026']")).setValue(slug);
  await (await b.$("//form[.//h2[normalize-space()='New project']]//input[@type='password']")).setValue(PROJECT_PW);
  await click("//button[normalize-space()='Create project']");
  await byTestId('workspace');
  await click('[data-testid="settings-btn"]');
  await b.execute(() => {
    const sel = [...document.querySelectorAll('select')].find((s) => s.closest('label')?.textContent?.includes('Default role') || document.querySelector(`label[for="${s.id}"]`)?.textContent?.includes('Default role'));
    sel.value = 'editor';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click("(//button[normalize-space()='Save'])[1]");
  await until(async () => (await fullText('settings-dialog')).includes('Saved'), 'role saved');
  await click("//div[@data-testid='settings-dialog']//button[@aria-label='Close' or normalize-space()='Close']");
  const projectId = await b.execute(() => window.__p2p.session.project.id);
  const { fileId, hash } = await b.execute(async () => {
    const s = window.__p2p.session;
    const fileId = await s.model.createTextNow('main.tex', 'soak start');
    const png = new Uint8Array(200_000).map((_, i) => (i * 31) % 251);
    const hash = await s.blobs.add(png);
    s.model.createBinary('fig.png', hash, png.length);
    await s.model.flush();
    return { fileId, hash };
  });
  await home();
  const entry = async () => (await worker('catalog.list')).projects.find((p) => p.project.project === projectId);
  await until(async () => (await entry())?.stage === 'dormant', 'dormant seed', 120_000);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: web });
  await ctx.addInitScript(() => localStorage.setItem('hivetex.test', '1'));
  const user = uniq('soakweb');
  {
    const page = await ctx.newPage();
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
    await page.close();
  }

  const samples = [];
  const sampler = setInterval(async () => {
    try {
      const e = await entry();
      samples.push({ t: Date.now(), ...sample(), stage: e?.stage ?? null, upnp: await invoke('upnp_status'), queues: await invoke('worker_diagnostics') });
    } catch { /* the page is busy; next tick */ }
  }, 30_000);
  const cycles = [];
  const started = Date.now();
  const deadline = started + MINUTES * 60_000;
  let n = 0;
  try {
    while (Date.now() < deadline - 3 * 60_000) {
      n++;
      // Dormant phase: the seed sleeps; the worker must not contact the control plane.
      const dormantStart = Date.now();
      await until(async () => (await entry())?.stage === 'dormant', `dormant before wake ${n}`, 180_000);
      const settled = Date.now();
      await sleep(n === 1 ? 60_000 : 150_000);
      const dormantEnd = Date.now();
      const dormant = requests(settled, dormantEnd);
      // Network change / resume from sleep while dormant (every third cycle): the seed stays asleep.
      if (n % 3 === 0) {
        await invoke('test_network_change', { resumed: n % 2 === 0 });
        await sleep(5000);
      }
      // Wake: the browser opens the project, rings, checks content and adds a line.
      const page = await ctx.newPage();
      const rang = Date.now();
      await page.goto(`/#/p/${projectId}`);
      await page.getByTestId('workspace').waitFor();
      await page.getByRole('treeitem', { name: 'main.tex' }).click({ timeout: 90_000 });
      await page.locator('.cm-content', { hasText: 'soak start' }).waitFor({ timeout: 90_000 });
      const contentMs = Date.now() - rang;
      await until(() => page.evaluate((h) => window.__p2p.session.blobs.has(h), hash), `image on the browser (wake ${n})`, 90_000);
      await until(() => page.evaluate(() => window.__p2p.session.peers.length > 0 && window.__p2p.session.syncStatus?.stage === 'synced'), `current authenticated seed (wake ${n})`, 90_000);
      // This is a sync soak, not a caret/keyboard test (realtime.spec.ts covers the editor DOM). A model edit cannot
      // lose focus during a reload or split the numbered marker across a concurrent selection restoration.
      const append = (text) => page.evaluate(async ({ file, text }) => {
        const s = window.__p2p.session;
        const doc = await s.model.openText(file);
        doc.insert(doc.length, text);
        await s.model.flush();
      }, { file: fileId, text });
      await append(` line${n}`);
      // One long wake spans a 15-minute ticket refresh while connected.
      const long = n === 4;
      if (long) {
        for (let m = 1; m <= 16; m++) {
          await sleep(60_000);
          await append(` l${n}m${m}`);
        }
      } else {
        await sleep(10_000);
      }
      const reconciled = await page.evaluate(async () => (await window.__p2p.session.mesh.resync({ timeoutMs: 30_000 })).docs.every((d) => d.outcome === 'confirmed'));
      assert.ok(reconciled, `wake ${n} reconciles with the current seed before its browser closes`);
      await page.close();
      cycles.push({ n, dormantMs: dormantEnd - dormantStart, dormantWorkerRequests: dormant?.worker.length ?? null,
        dormantWorkerPaths: dormant?.worker.map((r) => r.m + ' ' + r.path) ?? null, dormantPushRequests: dormant?.workerPush.length ?? null, dormantOtherRequests: dormant?.other.length ?? null,
        contentMs, long, network: n % 3 === 0 ? (n % 2 === 0 ? 'resume' : 'route change') : null });
      console.log(`# cycle ${n}: dormant worker requests ${dormant?.worker.length ?? 'n/a'}, content in ${contentMs} ms${long ? ' (long wake)' : ''}`);
      // Preserve the measured samples even if a later assertion fails, instead of losing an hour of evidence.
      writeFileSync(OUT, JSON.stringify({ phase: 'running', elapsedMs: Date.now() - started, cycles, samples }, null, 2));
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(remaining);
  } finally {
    clearInterval(sampler);
    await browser.close();
  }
  // The last wake starts before the deadline, so the cycling loop may end up to three minutes early.
  // Keep the app dormant for the remainder: "60 minutes" must mean elapsed time, not just the requested label.
  // Every line typed while the desktop slept reached it.
  await until(async () => (await entry())?.stage === 'dormant', 'dormant at the end', 180_000);
  await b.execute((pid) => { location.hash = '#/p/' + pid; }, projectId);
  await byTestId('workspace');
  const finalText = await until(async () => {
    const text = await b.execute(async (f) => (await window.__p2p.session.model.openText(f)).toString(), fileId);
    return Array.from({ length: n }, (_, i) => `line${i + 1}`).every((l) => text.includes(l)) && text;
  }, 'all lines on the desktop', 120_000);
  await home();

  const third = Math.max(1, Math.floor(samples.length / 3));
  const avg = (xs) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
  const firstThird = samples.slice(0, third), lastThird = samples.slice(-third);
  const summary = {
    minutes: MINUTES, elapsedMs: Date.now() - started, cycles: cycles.length, samples: samples.length,
    dormantWorkerRequests: cycles.reduce((a, c) => a + (c.dormantWorkerRequests ?? 0), 0),
    contentMs: { max: Math.max(...cycles.map((c) => c.contentMs)), avg: Math.round(avg(cycles.map((c) => c.contentMs))) },
    worker: {
      wsMiB: { first: Math.round(avg(firstThird.map((s) => s.worker?.ws ?? 0)) / 2 ** 20), last: Math.round(avg(lastThird.map((s) => s.worker?.ws ?? 0)) / 2 ** 20), max: Math.round(Math.max(...samples.map((s) => s.worker?.ws ?? 0)) / 2 ** 20) },
      handles: { first: Math.round(avg(firstThird.map((s) => s.worker?.handles ?? 0))), last: Math.round(avg(lastThird.map((s) => s.worker?.handles ?? 0))), max: Math.max(...samples.map((s) => s.worker?.handles ?? 0)) },
      cpuSeconds: (samples.at(-1)?.worker?.cpu ?? 0) - (samples[0]?.worker?.cpu ?? 0),
      pids: [...new Set(samples.map((s) => s.worker?.pid))],
    },
    app: {
      wsMiB: { first: Math.round(avg(firstThird.map((s) => s.app?.ws ?? 0)) / 2 ** 20), last: Math.round(avg(lastThird.map((s) => s.app?.ws ?? 0)) / 2 ** 20) },
      handles: { first: Math.round(avg(firstThird.map((s) => s.app?.handles ?? 0))), last: Math.round(avg(lastThird.map((s) => s.app?.handles ?? 0))) },
      cpuSeconds: (samples.at(-1)?.app?.cpu ?? 0) - (samples[0]?.app?.cpu ?? 0),
    },
    upnpStates: [...new Set(samples.map((s) => s.upnp?.state))],
    queues: { maxRtcEventBytes: Math.max(...samples.map((s) => s.queues?.rtcEventQueueBytes ?? 0)), maxPendingRequests: Math.max(...samples.map((s) => s.queues?.pendingRequests ?? 0)) },
    finalLength: finalText.length,
  };
  writeFileSync(OUT, JSON.stringify({ summary, cycles, samples }, null, 2));
  console.log('# soak summary ' + JSON.stringify(summary));
  assert.ok(summary.elapsedMs >= MINUTES * 60_000, 'the soak spans the full requested wall-clock duration');
  assert.ok(summary.queues.maxRtcEventBytes <= 4 * 1024 * 1024);
  assert.ok(summary.queues.maxPendingRequests <= 128);
  if (LOG) assert.equal(summary.dormantWorkerRequests, 0, 'no control-plane request from a dormant seed');
  assert.equal(summary.worker.pids.length, 1, 'one worker for the whole run (no crash or restart)');
  // Bounded: no steady growth between the first and last third of the run.
  assert.ok(summary.worker.handles.last <= summary.worker.handles.first * 1.25 + 50, `worker handles grew: ${JSON.stringify(summary.worker.handles)}`);
  assert.ok(summary.worker.wsMiB.last <= summary.worker.wsMiB.first * 1.5 + 64, `worker memory grew: ${JSON.stringify(summary.worker.wsMiB)}`);
  assert.ok(summary.app.handles.last <= summary.app.handles.first * 1.25 + 100, `app handles grew: ${JSON.stringify(summary.app.handles)}`);
});
