#!/usr/bin/env node
/** 13.1: two retained projects served by the real app after its only webview is destroyed.
 * Windows: run after the other desktop harnesses, with :3000/:1420 up and a test-picker debug build.
 * Uses WebView2's loopback CDP test port, not WebDriver (which terminates an app with no window).
 * No production IPC permission is added. The process/worker count, presence, hashes and current device IDs are checked.
 * Only processes of HIVETEX_APP (default: the E2E build, harness.mjs) count, so an installed app may stay open. The app
 * ends through `app_quit`; forced termination is the fallback. Report: BACKGROUND_OUT, default <E2E_OUT>/acceptance-background.json.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from '@playwright/test';
import { appExe, ensureNoTestInstance, quitThroughPage, stopApp, targetDir } from './harness.mjs';

assert.equal(process.platform, 'win32', 'this native harness requires Windows');
const exe = process.env.HIVETEX_APP ?? appExe;
const reportFile = process.env.BACKGROUND_OUT ?? join(process.env.E2E_OUT || join(targetDir, 'e2e-results'), 'acceptance-background.json');
const port = Number(process.env.HIVETEX_CDP_PORT ?? 9447);
const origin = 'http://localhost:1420';
const pw = 'correct horse battery staple';
const projectPw = 'project-secret-1';
const relayOnly = process.env.BACKGROUND_RELAY === '1';
const assetBytes = Number(process.env.BACKGROUND_ASSET_BYTES ?? 9 * 1024 * 1024 + 17);
const metrics = () => fetch('http://localhost:3000/api/__dev/acceptance').then((r) => { if (!r.ok) throw new Error('relay fixture unavailable'); return r.json(); });
const report = { windows: [], phases: [], bootstrapMs: [] };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (r.status) throw new Error(r.stderr);
  return r.stdout.trim();
};
const apps = () => {
  const value = JSON.parse(ps(`@(Get-Process hivetex-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replaceAll("'", "''")}' } | Select-Object Id,MainWindowTitle) | ConvertTo-Json -Compress`) || '[]');
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
};
const workerCount = (pid) => Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid} AND Name='node.exe'" | Measure-Object).Count`));
const workerPid = (pid) => Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid} AND Name='node.exe'" | Select-Object -First 1).ProcessId`));
async function until(fn, description, ms = 60_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await pause(200);
  }
  throw new Error(`${description}: ${String(last)}`);
}
const launch = () => spawn(exe, ['--ignore-system-tex'], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
} });
let cdp, page, browser;
const clients = [];
async function desktop() {
  await until(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false), 'CDP endpoint');
  cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(() => cdp.contexts().flatMap((c) => c.pages()).find((p) => !p.isClosed()), 'native page');
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__ && !!document.getElementById('app'));
  return page;
}
const invoke = (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const worker = (method, params = {}) => invoke('worker_request', { method, params: JSON.stringify(params) }).then((v) => typeof v === 'string' ? JSON.parse(v) : v);
async function register(p, username) {
  await p.goto(`${origin}/#/register`);
  await p.getByLabel('Username').fill(username);
  await p.getByLabel('Email').fill(`${username}@example.com`);
  await p.locator('input[type=password]').nth(0).fill(pw);
  await p.locator('input[type=password]').nth(1).fill(pw);
  await p.getByRole('button', { name: 'Create account' }).click();
  await p.getByRole('heading', { name: 'Your projects' }).waitFor();
}
async function noWindow(pid) {
  await until(() => page.isClosed(), 'webview destroyed');
  assert.deepEqual(apps().map((a) => a.Id), [pid]);
  assert.notEqual(apps()[0].MainWindowTitle, 'HiveTeX');
  assert.equal(workerCount(pid), 1);
  report.windows.push({ pid, webviewDestroyed: true, workers: 1 });
}
async function reopen(pid) {
  const second = launch();
  await until(() => second.exitCode !== null, 'second launch exits');
  await desktop();
  assert.deepEqual(apps().map((a) => a.Id), [pid]);
  assert.equal(workerCount(pid), 1);
}
async function replica(p, project, marker) {
  try {
  await until(() => p.evaluate(async ({ id, hash, marker }) => {
    const s = window.__p2p?.session;
    if (!s?.model.files.has(id)) return false;
    return (await s.model.openText(id)).toString().includes(marker) && await s.blobs.has(hash);
  }, { ...project, marker }), 'complete replica', 120_000);
  } catch (e) {
    console.log('# replica diagnostic ' + JSON.stringify(await p.evaluate(async ({ id, hash }) => {
      const s = window.__p2p?.session, pending = s?.blobs.pending?.get(hash);
      return { fileKnown: s?.model.files.has(id), text: s && (await s.model.openText(id)).toString(),
        asset: s && await s.blobs.has(hash), chunks: pending?.chunks.size, totalChunks: pending?.total,
        status: s?.syncStatus, routes: s?.peers.map((peer) => ({ route: peer.route, limited: peer.limited })),
        manager: s?.runtime.managerDiagnostics, rejected: s?.mesh.rejected?.slice(-5) };
    }, project).catch(() => null)));
    throw e;
  }
}

await ensureNoTestInstance();
assert.deepEqual(apps(), [], 'finish other desktop harnesses before this one');
try {
  const initialRelay = relayOnly ? await metrics() : null;
  const first = launch();
  let pid = first.pid;
  await desktop();
  // Registration redirects a restored signed-in profile: complete its account barrier before creating the fixture.
  await page.waitForTimeout(1500);
  if (await page.getByRole('button', { name: 'Account menu' }).isVisible()) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  }
  // Keep the native page origin; navigating to the browser origin would discard the Tauri initialization script.
  await page.evaluate(() => { localStorage.setItem('hivetex.test', '1'); localStorage.setItem('hivetex.fakeEngine', '1'); location.hash = '#/register'; });
  await page.getByLabel('Repeat password').waitFor();
  const username = `bg${Date.now().toString(36)}`;
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Email').fill(`${username}@example.com`);
  await page.locator('#reg-pw').fill(pw);
  await page.locator('#reg-pw2').fill(pw);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Your projects' }).waitFor();
  const projects = [];
  for (let i = 0; i < 2; i++) {
    const slug = `bg-${Date.now().toString(36)}-${i}`;
    await page.getByTestId('new-project-btn').click();
    await page.getByPlaceholder('my-paper-2026').fill(slug);
    await page.locator('form:has(h2:text("New project")) input[type=password]').fill(projectPw);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByTestId('workspace').waitFor();
    await page.getByTestId('settings-btn').click();
    await page.getByLabel('Default role').selectOption('editor');
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await page.getByTestId('settings-dialog').getByText('Saved', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close' }).click();
    const project = await page.evaluate(async ({ i, assetBytes }) => {
      const s = window.__p2p.session;
      const id = await s.model.createTextNow('main.tex', `native seed ${i}`);
      const bytes = new Uint8Array(i === 0 ? assetBytes : 200_000).map((_, k) => (k * 31 + i) % 251);
      const hash = await s.blobs.add(bytes);
      s.model.createBinary('fig.png', hash, bytes.length);
      await s.model.flush();
      return { project: s.project.id, id, hash, deviceId: s.runtime.deviceId };
    }, { i, assetBytes });
    projects.push({ ...project, slug });
    await page.evaluate(() => { location.hash = '#/'; });
    await page.getByRole('heading', { name: 'Your projects' }).waitFor();
  }
  await until(async () => {
    const list = await worker('catalog.list');
    return projects.every((p) => list.projects.some((r) => r.project.project === p.project && r.stage === 'dormant'));
  }, 'both dormant');
  await invoke('test_close_main');
  await noWindow(pid);
  console.log('ok - both retained projects have no webview and one native worker');
  browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: origin });
  await ctx.addInitScript(() => localStorage.setItem('hivetex.test', '1'));
  if (relayOnly) await ctx.addInitScript(() => {
    const timeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 280_000 ? 310_000 : ms, ...args);
    const Original = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Original {
      constructor(config) { super({ ...config, iceServers: [], iceTransportPolicy: 'relay' }); window.__pcs.push(this); }
    };
  });
  const member = await ctx.newPage();
  await register(member, `bgweb${Date.now().toString(36)}`);
  for (let i = 0; i < projects.length; i++) {
    const p = i ? await ctx.newPage() : member;
    if (i) await p.goto('/#/');
    const start = Date.now();
    await p.getByTestId('join-btn').click();
    await p.locator('form:has(h2:text("Join a project")) input[type=text]').fill(projects[i].slug);
    await p.locator('form:has(h2:text("Join a project")) input[type=password]').fill(projectPw);
    await p.getByRole('button', { name: 'Join', exact: true }).click();
    await p.getByTestId('workspace').waitFor();
    clients.push(p);
    await replica(p, projects[i], `native seed ${i}`);
    report.bootstrapMs.push(Date.now() - start);
    await until(() => p.evaluate(() => {
      const s = window.__p2p.session;
      return s.peers.length === 1 && s.peers[0].seed === true && [...s.mesh.awareness.getStates().values()].some((state) => state.seed && !state.user && !state.file && !state.cursor);
    }), 'seed availability without editor presence');
    await p.evaluate(async ({ id, i }) => { const s = window.__p2p.session; const t = await s.model.openText(id); t.insert(t.length, ` browser edit ${i}`); }, { id: projects[i].id, i });
  }
  assert.equal(workerCount(pid), 1);
  if (relayOnly) {
    const before = await Promise.all(clients.map((p) => p.evaluate(() => window.__p2p.session.mesh.peers[0]?.conn.transport.authenticationBinding.transcriptHash)));
    for (const p of clients) {
      assert.deepEqual(await p.evaluate(() => window.__p2p.session.peers.map((peer) => peer.route)), ['relay']);
      assert.equal(await p.evaluate(() => window.__pcs.filter((pc) => pc.connectionState === 'connected').length), 0);
    }
    await until(async () => (await metrics()).rotations > initialRelay.rotations, 'actual 300-second server cutoff', 360_000);
    for (let i = 0; i < clients.length; i++) {
      await clients[i].evaluate(async ({ id, i }) => { const t = await window.__p2p.session.model.openText(id); t.insert(t.length, ` rotation edit ${i}`); }, { id: projects[i].id, i });
      await until(() => clients[i].evaluate((old) => {
        const s = window.__p2p.session;
        return s.peers.length === 1 && s.peers[0].route === 'relay' && s.mesh.peers[0]?.conn.transport.authenticationBinding.transcriptHash !== old;
      }, before[i]), 'fresh relay keys after cutoff', 90_000);
    }
    report.relay = await metrics();
    assert.ok(report.relay.droppedPayloads > initialRelay.droppedPayloads);
    assert.ok(report.relay.connections.every((n, i) => n > initialRelay.connections[i]));
    assert.ok(report.relay.socketLifetimesMs.slice(initialRelay.socketLifetimesMs.length).some((ms) => ms >= 299_000));
    report.phases.push('no-renderer native/browser relay, payload loss, actual 300-second cutoff and fresh keys');
    console.log('ok - native/browser relay survives loss and the actual hosting cutoff on both scopes');
  }
  await reopen(pid);
  for (let i = 0; i < projects.length; i++) {
    await page.evaluate((id) => { location.hash = `#/p/${id}`; }, projects[i].project);
    await page.getByTestId('workspace').waitFor();
    await replica(page, projects[i], `browser edit ${i}`);
    if (relayOnly) await replica(page, projects[i], `rotation edit ${i}`);
    const nativeDevice = await page.evaluate(() => window.__p2p.session.runtime.deviceId);
    assert.equal(nativeDevice, projects[i].deviceId, 'reattach keeps the native network identity');
    await page.evaluate(() => { location.hash = '#/'; });
    await page.getByRole('heading', { name: 'Your projects' }).waitFor();
  }
  report.phases.push('two projects bootstrap and persist edits with no renderer; reattach preserves identity');
  console.log('ok - two projects bootstrap text/assets from the no-renderer seed and reattach to the same identity');
  // A real native-supervised worker crash, followed by a renderer reload and fresh attachment to durable replicas.
  const crashedWorker = workerPid(pid);
  assert.ok(crashedWorker > 0);
  ps(`Stop-Process -Id ${crashedWorker} -Force`);
  await until(() => workerPid(pid) > 0 && workerPid(pid) !== crashedWorker, 'worker restarted with a new process');
  await page.reload();
  for (let i = 0; i < projects.length; i++) {
    await page.evaluate((id) => { location.hash = `#/p/${id}`; }, projects[i].project);
    await page.getByTestId('workspace').waitFor();
    await replica(page, projects[i], `browser edit ${i}`);
    assert.equal(await page.evaluate(() => window.__p2p.session.runtime.deviceId), projects[i].deviceId);
    await page.evaluate(async () => { await window.__p2p.session.model.flush(); location.hash = '#/'; });
    await page.getByRole('heading', { name: 'Your projects' }).waitFor();
  }
  assert.equal(workerCount(pid), 1);
  report.phases.push('actual worker crash, new generation, renderer reload and durable reattach without duplicate identity');
  await worker('catalog.settings', { paused: true });
  await until(() => Promise.all(clients.map((p) => p.evaluate(() => window.__p2p.session.peers.length))).then((ns) => ns.every((n) => n === 0)), 'pause closes both peers');
  const before = pid;
  await invoke('app_restart').catch(() => {});
  await until(() => !apps().some((a) => a.Id === before), 'old app exited');
  pid = await until(() => apps().find((a) => a.MainWindowTitle === 'HiveTeX')?.Id, 'restarted app');
  await desktop();
  assert.equal(workerCount(pid), 1);
  await until(async () => (await worker('catalog.list')).paused === true, 'pause survives restart');
  await worker('catalog.settings', { paused: false });
  for (const p of clients) await p.reload();
  for (let i = 0; i < clients.length; i++) await replica(clients[i], projects[i], `browser edit ${i}`);
  report.phases.push('persistent global pause and native restart; complete replicas after resume');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await until(() => Promise.all(clients.map((p) => p.evaluate(() => window.__p2p.session.peers.length))).then((ns) => ns.every((n) => n === 0)), 'logout closes both peers');
  await pause(5000);
  assert.ok((await Promise.all(clients.map((p) => p.evaluate(() => window.__p2p.session.peers.length)))).every((n) => n === 0));
  report.phases.push('logout stops both scopes and no delayed callback resurrects them');
  await invoke('app_quit', { discard: false }).catch(() => {});
  await until(() => apps().length === 0, 'durable quit');
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log('ok - no-renderer two-project bootstrap, text/assets, presence, pause, restart and logout');
} finally {
  const states = await Promise.all(clients.map((p) => p.evaluate(() => {
    const s = window.__p2p?.session;
    return s && { stage: s.syncStatus?.stage, received: s.syncStatus?.received, total: s.syncStatus?.total,
      routes: s.peers.map((peer) => ({ route: peer.route, limited: peer.limited })), mergeError: s.mergeError && String(s.mergeError) };
  }).catch(() => null)));
  if (states.length) console.log('# final browser states ' + JSON.stringify(states));
  await browser?.close();
  // Only this harness's native app executable: quit through its page when it still has one, else forced.
  for (const a of apps()) console.log(`# app ${a.Id}: ${await stopApp(a.Id, page && !page.isClosed() ? () => quitThroughPage(page) : null)}`);
  await cdp?.close().catch(() => {});
}
