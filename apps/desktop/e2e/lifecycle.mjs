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
 * server and API the debug build loads its page from. Apps end through `app_quit` (WebView2 DevTools port
 * HIVETEX_CDP_PORT, loopback) while they have a page, and are killed only when that fails (harness.mjs).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { appExe, ensureNoTestInstance, identifier, quitThroughCdp, stopApp, targetDir } from './harness.mjs';

if (process.platform !== 'win32') {
  console.log('# lifecycle.mjs: Windows only; skipped');
  process.exit(0);
}
const here = dirname(fileURLToPath(import.meta.url));
const exe = process.env.HIVETEX_APP ?? appExe;
const CDP = Number(process.env.HIVETEX_CDP_PORT ?? 9448);
// Every launch can be asked to quit through its page (secondaries hand over before they create one).
const appEnv = (extra = {}) => ({ ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}`, HIVETEX_TEST_LIFECYCLE_REPORT: telemetry, ...extra });
const copyDir = mkdtempSync(join(tmpdir(), 'hivetex-instance-'));
assert.equal(dirname(resolve(copyDir)), resolve(tmpdir()), 'temporary executable directory stays within the test temp root');
const copy = join(copyDir, 'hivetex-desktop.exe');
const telemetry = join(copyDir, 'lifecycle.json');
const report = { identifier, exe, startedAt: new Date().toISOString(), scenarios: [],
  trayMeasurement: 'Registered native main tray icon, paired with all owning process counts; excludes stale Explorer icon ghosts',
  missingAcceptance: ['current packaged production identity', 'macOS', 'Linux'] };
copyFileSync(exe, copy);
// Only this harness's two executables: never kill an installed app while running local regression checks.
const pathFilter = [exe, copy].map((p) => `$_.Path -eq '${p.replaceAll("'", "''")}'`).join(' -or ');

function ps(script) {
  // Get-Process -ErrorAction SilentlyContinue returns $? = false when no app exists. That is an empty query,
  // not a harness failure; genuine terminating errors must still fail.
  const command = `$ErrorActionPreference = 'Stop'; ${script}; exit 0`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`process query failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}
/** [{ id, title }] of running app processes. */
const apps = () => {
  const out = ps(`Get-Process hivetex-desktop -ErrorAction SilentlyContinue | Where-Object { ${pathFilter} } | ForEach-Object { "$($_.Id)\u0060t$($_.MainWindowTitle)" }`);
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
async function record(label, pid, visibleWindows, windowCount = visibleWindows) {
  const native = await until(() => {
    try { const v = JSON.parse(readFileSync(telemetry, 'utf8')); return v.pid === pid && v.visibleWindows === visibleWindows && v.windows.length === windowCount && v; }
    catch { return false; }
  }, `native window counts for ${label}`);
  assert.equal(native.identifier, identifier);
  assert.equal(native.trayCount, 1, 'one registered native tray icon');
  const owners = apps(); assert.deepEqual(owners.map((p) => p.id), [pid], 'one app owning this profile');
  const ancestry = JSON.parse(ps(`@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress`) || '[]');
  const children = Array.isArray(ancestry) ? ancestry : [ancestry];
  assert.equal(children.filter((p) => p.Name === 'node.exe').length, 1, 'one direct sync worker');
  report.scenarios.push({ label, ...native, owners, children });
}
/** Quits every app of this harness (`app_quit`, then forced after 15 s); returns how each one ended. */
const killAll = async () => {
  const ended = [];
  for (const a of apps()) ended.push(await stopApp(a.id, () => quitThroughCdp(CDP), 15_000));
  (report.shutdown ??= []).push({ at: new Date().toISOString(), results: ended });
  return ended;
};
const exited = (child) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.kill(); reject(new Error('secondary launch did not exit within 15 seconds')); }, 15_000);
  child.once('error', (e) => { clearTimeout(timer); reject(e); });
  child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
});

// A debug build loads its page from the web dev server: without it every window shows an error page.
if (!(await fetch('http://localhost:1420').then((r) => r.ok).catch(() => false))) {
  console.error('lifecycle.mjs needs the web dev server on http://localhost:1420 and the API on :3000: run it through run.mjs');
  process.exit(1);
}
await ensureNoTestInstance([copyDir]);
try {
  for (const delay of ['5000', '0']) {
  const primary = spawn(exe, [], { env: appEnv({ HIVETEX_TEST_INSTANCE_WINDOW_MS: delay }), stdio: 'ignore' });
  await until(() => ps(`$m=$null; $held=[Threading.Mutex]::TryOpenExisting('${identifier}-sim', [ref]$m); if ($m) { $m.Dispose() }; $held`) === 'True', 'primary acquired its startup mutex');
  const burst = Array.from({ length: 12 }, (_, i) => spawn(i % 2 ? copy : exe, [], { env: appEnv(), stdio: 'ignore' }));
  assert.deepEqual(await Promise.all(burst.map(exited)), Array(12).fill(0), 'all simultaneous/cross-path secondaries hand over and exit');
  await until(() => apps().some((a) => a.id === primary.pid && a.title === 'HiveTeX'), 'primary window shown');
  assert.deepEqual(apps().map((a) => a.id), [primary.pid], 'delayed primary is the only app process');
  await until(() => workers(primary.pid) > 0, 'primary worker started after the window');
  assert.equal(workers(primary.pid), 1, 'the startup burst leaves one worker');
  await record(`12 concurrent cross-path launches (handover delay ${delay} ms)`, primary.pid, 1);
  console.log(`ok - 12 simultaneous launches across two paths leave one app and worker (handover delay ${delay} ms)`);
  console.log(`# ended: ${(await killAll()).join(', ')}`);
  }

  const first = spawn(exe, [], { env: appEnv({ HIVETEX_TEST_CLOSE_MAIN_MS: '6000' }), stdio: 'ignore', detached: false });
  const pid = first.pid;
  await until(() => apps().some((a) => a.id === pid && a.title === 'HiveTeX'), 'window shown');
  await until(() => workers(pid) > 0, 'sync worker started after the window');
  assert.equal(workers(pid), 1, 'one sync worker');
  await until(() => apps().some((a) => a.id === pid && a.title !== 'HiveTeX'), 'window closed');
  // Keeps running in the background with its worker.
  await new Promise((r) => setTimeout(r, 5000));
  assert.deepEqual(apps().map((a) => a.id), [pid], 'the app is still running with no window');
  assert.equal(workers(pid), 1, 'the sync worker kept running');
  await record('closed to tray', pid, 0);
  console.log('ok - closing the window keeps the app and its sync worker running');

  const second = spawn(exe, [], { env: appEnv(), stdio: 'ignore' });
  assert.equal(await exited(second), 0, 'second launch hands over');
  await until(() => apps().some((a) => a.id === pid && a.title === 'HiveTeX'), 'existing app shows its window again');
  assert.deepEqual(apps().map((a) => a.id), [pid], 'still one app process');
  assert.equal(workers(pid), 1, 'still one sync worker (one network identity per project)');
  await record('reopened by secondary launch', pid, 1);
  console.log('ok - a second launch reopens the running app instead of starting another');
  console.log(`# ended: ${(await killAll()).join(', ')}`);

  // A browser asks to pair (compile on this computer) while the window is closed: the window comes back for the
  // confirmation instead of waiting invisibly.
  const third = spawn(exe, [], { env: appEnv({ HIVETEX_TEST_CLOSE_MAIN_MS: '6000', HIVETEX_HELPER_ORIGINS: 'http://pair.test' }), stdio: 'ignore' });
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
  await record('browser pairing reopens window', third.pid, 1);
  console.log('ok - a browser pairing request opens a visible window when the app runs in the background');
  console.log(`# ended: ${(await killAll()).join(', ')}`);

  // The post-update restart: durable quit, then exactly one new app with one worker (no duplicate seed).
  const old = spawn(exe, [], { env: appEnv({ HIVETEX_TEST_RESTART_MS: '6000' }), stdio: 'ignore' });
  await until(() => apps().some((a) => a.id === old.pid && a.title === 'HiveTeX'), 'window shown');
  await until(() => !apps().some((a) => a.id === old.pid), 'old instance exited', 30_000);
  const next = await until(() => apps().find((a) => a.title === 'HiveTeX'), 'restarted app shows its window', 30_000);
  await new Promise((r) => setTimeout(r, 4000));
  assert.deepEqual(apps().map((a) => a.id), [next.id], 'exactly one app after the restart');
  assert.equal(workers(next.id), 1, 'exactly one sync worker after the restart');
  await record('post-update restart', next.id, 1);
  console.log('ok - restarting after an update leaves one app and one sync worker');
  console.log(`# ended: ${(await killAll()).join(', ')}`);

  // Login startup with "start in background": no window, the worker restores the projects.
  // The test build has its own identifier (tauri.e2e.conf.json), so the installed app's settings are untouched.
  const { existsSync } = await import('node:fs');
  const settings = join(process.env.APPDATA ?? '', identifier, 'startup.json');
  mkdirSync(dirname(settings), { recursive: true });
  const saved = existsSync(settings) ? readFileSync(settings) : null;
  writeFileSync(settings, JSON.stringify({ background: true }));
  try {
    const login = spawn(exe, ['--background'], { env: appEnv(), stdio: 'ignore' });
    await until(() => workers(login.pid) === 1, 'worker started at login');
    await new Promise((r) => setTimeout(r, 5000));
    assert.equal(apps().find((a) => a.id === login.pid)?.title === 'HiveTeX', false, 'no window at a background login start');
    assert.equal(workers(login.pid), 1);
    // Tauri creates the configured main webview hidden at startup; close-to-tray destroys it instead.
    await record('background login startup', login.pid, 0, 1);
    console.log(`# ended: ${(await killAll()).join(', ')}`);
    // A manual launch with the same setting still opens the window.
    const manual = spawn(exe, [], { env: appEnv(), stdio: 'ignore' });
    await until(() => apps().some((a) => a.id === manual.pid && a.title === 'HiveTeX'), 'manual launch opens the window');
    await until(() => workers(manual.pid) > 0, 'manual launch starts its worker');
    assert.equal(workers(manual.pid), 1, 'manual launch leaves one worker');
    await record('manual launch with background preference', manual.pid, 1);
  } finally {
    if (saved) writeFileSync(settings, saved); else rmSync(settings, { force: true });
  }
  console.log('ok - a background login start restores sync without a window; a manual launch opens it');
  const victim = apps()[0].id;
  const cleanup = spawn(exe, ['--uninstall-cleanup'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let cleanupLog = '';
  cleanup.stdout.on('data', chunk => { cleanupLog += chunk.toString(); });
  cleanup.stderr.on('data', chunk => { cleanupLog += chunk.toString(); });
  assert.equal(await exited(cleanup), 0, 'live maintenance cleanup failed: ' + cleanupLog);
  await until(() => apps().length === 0 && workers(victim) === 0, 'cleanup stopped app and worker');
  for (const profile of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    assert.equal(existsSync(join(profile, identifier)), false, 'cleanup removed the isolated app profile');
  }
  console.log('ok - maintenance stops a live app and worker and removes its isolated profiles');
  report.scenarios.push({ label: 'maintenance cleanup', owners: apps(), workers: workers(victim), trayCount: 0, windows: [] });
  report.passed = true;
} finally {
  await killAll();
  const out = process.env.E2E_OUT || join(targetDir, 'e2e-results');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'lifecycle.json'), JSON.stringify(report, null, 2));
  rmSync(copyDir, { recursive: true, force: true });
}
