#!/usr/bin/env node
/**
 * Desktop lifetime check without WebDriver (11.1): the driver ends the app when its only webview closes, so close and
 * reopen are verified on a directly launched debug build (`test-picker` feature, as built by run.mjs):
 *
 * 1. the window opens, then closes like the title-bar button (HIVETEX_TEST_CLOSE_MAIN_MS);
 * 2. the process and its sync worker keep running with no window;
 * 3. a second launch hands over to the running app and exits; the same process shows its window again.
 *
 * Windows only (process/window queries through PowerShell). Runs at the end of run.mjs, which provides the web dev
 * server and API the debug build loads its page from.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('# lifecycle.mjs: Windows only; skipped');
  process.exit(0);
}
const here = dirname(fileURLToPath(import.meta.url));
const exe = process.env.HIVETEX_APP ?? join(resolve(here, '../src-tauri/target/debug'), 'hivetex-desktop.exe');

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}
/** [{ id, title }] of running app processes. */
const apps = () => {
  const out = ps("Get-Process hivetex-desktop -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id)`t$($_.MainWindowTitle)\" }");
  return out ? out.split(/\r?\n/).map((l) => { const [id, title] = l.split('\t'); return { id: Number(id), title: title ?? '' }; }) : [];
};
const workers = (pid) => Number(ps(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid} AND Name='node.exe'" | Measure-Object).Count`) || 0);
async function until(fn, msg, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out: ${msg} (apps: ${JSON.stringify(apps())})`);
}
const killAll = () => ps("Get-Process hivetex-desktop -ErrorAction SilentlyContinue | Stop-Process -Force; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*hivetex-worker*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }");

// A debug build loads its page from the web dev server: without it every window shows an error page.
if (!(await fetch('http://localhost:1420').then((r) => r.ok).catch(() => false))) {
  console.error('lifecycle.mjs needs the web dev server on http://localhost:1420 and the API on :3000: run it through run.mjs');
  process.exit(1);
}
killAll();
try {
  const first = spawn(exe, [], { env: { ...process.env, HIVETEX_TEST_CLOSE_MAIN_MS: '6000' }, stdio: 'ignore', detached: false });
  const pid = first.pid;
  await until(() => apps().some((a) => a.id === pid && a.title === 'HiveTeX'), 'window shown');
  assert.equal(workers(pid), 1, 'one sync worker');
  await until(() => apps().some((a) => a.id === pid && a.title !== 'HiveTeX'), 'window closed');
  // Keeps running in the background with its worker.
  await new Promise((r) => setTimeout(r, 5000));
  assert.deepEqual(apps().map((a) => a.id), [pid], 'the app is still running with no window');
  assert.equal(workers(pid), 1, 'the sync worker kept running');
  console.log('ok - closing the window keeps the app and its sync worker running');

  const second = spawn(exe, [], { env: process.env, stdio: 'ignore' });
  const code = await new Promise((r) => { second.on('exit', r); setTimeout(() => r('running'), 20_000); });
  assert.notEqual(code, 'running', 'second launch did not hand over');
  await until(() => apps().some((a) => a.id === pid && a.title === 'HiveTeX'), 'existing app shows its window again');
  assert.deepEqual(apps().map((a) => a.id), [pid], 'still one app process');
  assert.equal(workers(pid), 1, 'still one sync worker (one network identity per project)');
  console.log('ok - a second launch reopens the running app instead of starting another');
  killAll();

  // A browser asks to pair (compile on this computer) while the window is closed: the window comes back for the
  // confirmation instead of waiting invisibly.
  const third = spawn(exe, [], { env: { ...process.env, HIVETEX_TEST_CLOSE_MAIN_MS: '6000', HIVETEX_HELPER_ORIGINS: 'http://pair.test' }, stdio: 'ignore' });
  await until(() => apps().some((a) => a.id === third.pid && a.title === 'HiveTeX'), 'window shown');
  await until(() => apps().some((a) => a.id === third.pid && a.title !== 'HiveTeX'), 'window closed');
  const ctl = new AbortController();
  let paired = false;
  for (const port of [47812, 47813, 47814, 47815]) {
    const r = fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', signal: ctl.signal, headers: { Origin: 'http://pair.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'e2e', server: 'http://localhost:3000' }) });
    r.catch(() => {});
    paired = true;
  }
  assert.ok(paired);
  await until(() => apps().some((a) => a.id === third.pid && a.title === 'HiveTeX'), 'pairing request shows the window', 20_000);
  ctl.abort();
  console.log('ok - a browser pairing request opens a visible window when the app runs in the background');
  killAll();

  // The post-update restart: durable quit, then exactly one new app with one worker (no duplicate seed).
  const old = spawn(exe, [], { env: { ...process.env, HIVETEX_TEST_RESTART_MS: '6000' }, stdio: 'ignore' });
  await until(() => apps().some((a) => a.id === old.pid && a.title === 'HiveTeX'), 'window shown');
  await until(() => !apps().some((a) => a.id === old.pid), 'old instance exited', 30_000);
  const next = await until(() => apps().find((a) => a.title === 'HiveTeX'), 'restarted app shows its window', 30_000);
  await new Promise((r) => setTimeout(r, 4000));
  assert.deepEqual(apps().map((a) => a.id), [next.id], 'exactly one app after the restart');
  assert.equal(workers(next.id), 1, 'exactly one sync worker after the restart');
  console.log('ok - restarting after an update leaves one app and one sync worker');
  killAll();

  // Login startup with "start in background": no window, the worker restores the projects.
  const settings = join(process.env.APPDATA ?? '', 'app.hivetex.desktop', 'startup.json');
  const { existsSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const saved = existsSync(settings) ? readFileSync(settings) : null;
  writeFileSync(settings, JSON.stringify({ background: true }));
  try {
    const login = spawn(exe, ['--background'], { env: process.env, stdio: 'ignore' });
    await until(() => workers(login.pid) === 1, 'worker started at login');
    await new Promise((r) => setTimeout(r, 5000));
    assert.equal(apps().find((a) => a.id === login.pid)?.title === 'HiveTeX', false, 'no window at a background login start');
    assert.equal(workers(login.pid), 1);
    killAll();
    // A manual launch with the same setting still opens the window.
    const manual = spawn(exe, [], { env: process.env, stdio: 'ignore' });
    await until(() => apps().some((a) => a.id === manual.pid && a.title === 'HiveTeX'), 'manual launch opens the window');
  } finally {
    if (saved) writeFileSync(settings, saved); else rmSync(settings, { force: true });
  }
  console.log('ok - a background login start restores sync without a window; a manual launch opens it');
} finally {
  killAll();
}
