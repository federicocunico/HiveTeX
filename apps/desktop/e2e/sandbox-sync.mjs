#!/usr/bin/env node
/**
 * Two-machine sync test (`make sandbox-sync`): the desktop test build runs on this PC and inside Windows Sandbox (its
 * own VM behind its own NAT), both sign in to one server, share a project and edit it; the script checks every edit
 * arrives on the other side and collects everything needed to say why when it does not:
 *
 *   <out>/summary.json        steps with pass/fail and timings, routes, the connection tests from both sides
 *   <out>/timeline.txt        both apps' connection traces and the server's signaling log merged by time
 *   <out>/host|sandbox/       diagnostics (syncDiagnostics, peers, probe), the full trace, app stderr, native.log
 *   <out>/server/             server output, signaling log (SIGNAL_LOG), request log (REQUEST_LOG)
 *
 * Needs Windows 11 with Windows Sandbox and its CLI (wsb). The sandbox window opens (the app needs a signed-in
 * desktop session); Windows Sandbox runs one instance, so a running one is stopped first.
 *
 *   SKIP_BUILD=1               reuse the last test build (apps/desktop/src-tauri/target/debug)
 *   SERVER=https://host        use that server (it must accept registrations) instead of starting the local one
 *   NO_APP_RELAY=0             the local server also offers the application relay (default: WebRTC only)
 *   KEEP=1                     leave the apps, the server and the sandbox running at the end
 *   TURN_USERNAME/TURN_CREDENTIAL/TURN_SERVER   the local server hands out this relay, like production
 *   FAULT=no-udp               the sandbox app gets no UDP (its firewall blocks it): WebRTC never works and the
 *                              application relay carries the whole session (with HOLD_S: a long relay session)
 *   FAULT=deaf-silent | deaf   before the sandbox joins, the host's server subscription stops delivering: silently (the
 *                              production failure) or reported (the server then closes the session and the host reconnects)
 *   SYNC_TIMEOUT_MS=90000      how long each sync check waits
 *   HOLD_S=180                 then keep editing for that long (one edit every 5 s, alternating sides), each edit must
 *                              arrive within HOLD_MAX_MS (default 10000); route changes are recorded in summary.json
 *   MATRIX=stun,turn,relay,relay-stun,deaf   run these local-server scenarios one after the other and print a table:
 *                              stun (no TURN, no application relay), turn (TURN), relay (TURN + application relay),
 *                              relay-stun (application relay, no TURN), deaf (relay + FAULT=deaf); TURN_* must be set for
 *                              the scenarios that use it
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const root = resolve(desktop, '../..');
const debugDir = join(desktop, 'src-tauri/target/debug');
const base = join(desktop, 'src-tauri/target/sandbox-sync');
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (process.env.OUT_TAG ? `-${process.env.OUT_TAG}` : '');
const out = join(base, runId);

// ---- matrix: this script once per scenario -------------------------------------------------------------------------
const MATRIX = {
  stun: { turn: false, relay: false },
  turn: { turn: true, relay: false },
  relay: { turn: true, relay: true },
  'relay-stun': { turn: false, relay: true },
  deaf: { turn: true, relay: true, fault: 'deaf' },
  'no-udp': { turn: true, relay: true, fault: 'no-udp' },
};
if (process.env.MATRIX) {
  if (process.env.SERVER) throw new Error('MATRIX runs against the local server only (it switches its relay and faults)');
  const rows = [];
  let built = Boolean(process.env.SKIP_BUILD);
  for (const name of process.env.MATRIX.split(',').filter(Boolean)) {
    const s = MATRIX[name];
    if (!s) throw new Error(`unknown MATRIX scenario ${name} (known: ${Object.keys(MATRIX).join(', ')})`);
    if (s.turn && !process.env.TURN_SERVER) throw new Error(`scenario ${name} needs TURN_SERVER/TURN_USERNAME/TURN_CREDENTIAL`);
    const env = { ...process.env, MATRIX: '', OUT_TAG: name, NO_APP_RELAY: s.relay ? '0' : '1', ...(built ? { SKIP_BUILD: '1' } : {}) };
    if (!s.turn) for (const k of ['TURN_SERVER', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'TURN_URLS']) delete env[k];
    if (s.fault) env.FAULT = s.fault;
    else delete env.FAULT;
    console.log(`\n=== scenario ${name}`);
    spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env });
    built = true;
    const dir = readdirSync(base).filter((d) => d.endsWith(`-${name}`)).sort().at(-1);
    const sum = dir && existsSync(join(base, dir, 'summary.json')) ? JSON.parse(readFileSync(join(base, dir, 'summary.json'), 'utf8')) : null;
    const routes = sum?.steps.find((x) => x.name.startsWith('peers'))?.value;
    rows.push({ name, result: sum?.result ?? 'no result', failed: (sum?.steps ?? []).filter((x) => !x.ok).map((x) => x.name), route: routes?.host?.map((p) => p.route).join(',') ?? '-', hold: sum?.hold ?? null, dir });
  }
  console.log('\nscenario     result  route    hold (late/edits, median ms)  failed steps');
  for (const r of rows) console.log(`${r.name.padEnd(12)} ${r.result.padEnd(7)} ${String(r.route).padEnd(8)} ${r.hold ? `${r.hold.late}/${r.hold.edits}, ${r.hold.medianMs}` : '-'}`.padEnd(64) + (r.failed.join('; ') || ''));
  writeFileSync(join(base, 'matrix-summary.json'), JSON.stringify(rows, null, 2));
  process.exit(rows.every((r) => r.result === 'PASS') ? 0 : 1);
}
const share = join(base, 'share'); // read-only in the sandbox: the app and the sandbox scripts
const sbLogs = join(out, 'sandbox'); // writable in the sandbox
const HOST_CDP = 9301;
const SB_CDP = 9302; // inside the sandbox, loopback only
const SB_CDP_PUBLIC = 9303; // forwarded to SB_CDP for this PC
const localServer = !process.env.SERVER;
const server = process.env.SERVER || 'http://localhost:3000';
const PW = 'sandbox-sync-pw-1';
const PROJECT_PW = 'sandbox-sync-project-1';
const children = [];
const summary = { runId, server, steps: [], startedAt: new Date().toISOString() };

mkdirSync(join(out, 'host'), { recursive: true });
mkdirSync(join(out, 'server'), { recursive: true });
mkdirSync(sbLogs, { recursive: true });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
async function until(fn, what, ms = 60_000, every = 300) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await pause(every);
  }
  throw new Error(`${what}: timed out after ${ms} ms (${last instanceof Error ? last.message : JSON.stringify(last)})`);
}
async function step(name, fn) {
  const t0 = Date.now();
  log(`▶ ${name}`);
  try {
    const value = await fn();
    summary.steps.push({ name, ok: true, ms: Date.now() - t0, ...(value && typeof value === 'object' ? { value } : {}) });
    log(`✓ ${name} (${Date.now() - t0} ms)`);
    return value;
  } catch (e) {
    summary.steps.push({ name, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
    log(`✗ ${name}: ${e instanceof Error ? e.message : e}`);
    throw e;
  }
}
let failed = false;
const consoleLines = { host: [], sandbox: [] };
const tryStep = (name, fn) => step(name, fn).catch(() => { failed = true; });
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
  return r;
}
const wsb = (args, opts) => run('wsb', [...args, '--raw'], { shell: false, ...opts });
const wsbJson = (args, opts) => {
  const r = wsb(args, opts);
  try { return JSON.parse(r.stdout || 'null'); } catch { return null; }
};

// ---- build and stage ---------------------------------------------------------------------------------------------
if (!process.env.SKIP_BUILD) {
  await step('build the desktop test app', async () => {
    run(process.execPath, [join(desktop, 'prepare-worker.mjs')], { cwd: desktop, stdio: 'inherit' });
    run('npx', ['tauri', 'build', '--debug', '--no-bundle', '--features', 'test-picker', '--config', join(here, 'tauri.e2e.conf.json')], {
      cwd: desktop, stdio: 'inherit', shell: true, env: { ...process.env, VITE_API_BASE: 'http://localhost:3000', VITE_E2E: '1' },
    });
  });
}
await step('stage the app for both machines', async () => {
  rmSync(join(share, 'app'), { recursive: true, force: true });
  mkdirSync(join(share, 'app'), { recursive: true });
  for (const p of ['hivetex-desktop.exe', 'node', 'worker']) cpSync(join(debugDir, p), join(share, 'app', p), { recursive: true });
  // Sandbox side: forward the server and the DevTools port, copy the app out of the mapped folder.
  writeFileSync(join(share, 'setup.ps1'), [
    '$ErrorActionPreference = "Continue"',
    '$gw = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4DefaultGateway.NextHop',
    'Start-Service iphlpsvc',
    // WebView2 ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS in the sandbox; its policy key is honoured.
    `reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments /v hivetex-desktop.exe /t REG_SZ /d --remote-debugging-port=${SB_CDP} /f`,
    `netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=3000 connectaddress=$gw connectport=3000`,
    `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${SB_CDP_PUBLIC} connectaddress=127.0.0.1 connectport=${SB_CDP}`,
    `netsh advfirewall firewall add rule name=hivetex-cdp dir=in action=allow protocol=TCP localport=${SB_CDP_PUBLIC}`,
    // The answer a user gives once on a real PC: with a rule for the program, Windows asks nothing when the app binds
    // its UDP listener at launch, so runs need nobody at the sandbox.
    'netsh advfirewall firewall add rule name=hivetex-app dir=in action=allow program=C:\\hx-app\\hivetex-desktop.exe enable=yes',
    // FAULT=no-udp: the sandbox app gets no UDP at all (no STUN, no TURN over UDP, no direct path), as on a network that
    // blocks UDP: WebRTC attempts keep failing and the application relay stays the route for the whole session.
    ...(process.env.FAULT === 'no-udp'
      ? ['netsh advfirewall firewall add rule name=hivetex-no-udp dir=out action=block protocol=UDP program=C:\\hx-app\\hivetex-desktop.exe']
      : []),
    'Copy-Item -Recurse -Force C:\\hx-share\\app C:\\hx-app',
    '"gateway=$gw" | Out-File -Encoding utf8 C:\\hx-logs\\setup.txt',
    'netsh interface portproxy show all | Out-File -Append -Encoding utf8 C:\\hx-logs\\setup.txt',
    'ipconfig /all | Out-File -Append -Encoding utf8 C:\\hx-logs\\setup.txt',
  ].join('\r\n'));
  // A process of its own: one started from the exec'd console dies with it.
  writeFileSync(join(share, 'launch.ps1'), 'Start-Process -FilePath C:\\hx-app\\hivetex-desktop.exe -ArgumentList "--ignore-system-tex" -RedirectStandardError C:\\hx-logs\\app-stderr.txt -RedirectStandardOutput C:\\hx-logs\\app-stdout.txt\r\n');
  writeFileSync(join(share, 'collect.cmd'), [
    '@echo off',
    'copy /y "C:\\Users\\WDAGUtilityAccount\\AppData\\Roaming\\app.hivetex.desktop.e2e\\logs\\native.log" C:\\hx-logs\\native.log',
    'netstat -ano -p udp > C:\\hx-logs\\netstat-udp.txt',
  ].join('\r\n'));
});

let sandboxId;
let sandboxIp;
let hostApp;
let host;
let sb;
try {
// ---- server ------------------------------------------------------------------------------------------------------
async function healthy(url) {
  return fetch(`${url}/api/health`).then((r) => r.ok).catch(() => false);
}
if (localServer) {
  await step('start the local server with signaling and request logs', async () => {
    if (await healthy('http://localhost:3000')) throw new Error('something already listens on :3000; stop it first');
    const env = {
      ...process.env, MEMORY_DB: '1', PORT: '3000', E2E_NO_LIMITS: '1',
      SIGNAL_LOG: join(out, 'server', 'signal.jsonl'), REQUEST_LOG: join(out, 'server', 'requests.jsonl'),
      ...(process.env.NO_APP_RELAY === '0' ? { APPLICATION_RELAY: '1' } : {}),
    };
    const { openSync } = await import('node:fs');
    const fd = openSync(join(out, 'server', 'server.log'), 'a');
    const c = spawn('npx', ['pnpm@10', '--filter', '@hivetex/server', 'dev'], { cwd: root, shell: true, env, stdio: ['ignore', fd, fd] });
    children.push(c);
    await until(() => healthy('http://localhost:3000'), 'local server /api/health', 90_000, 500);
    return { relay: Boolean(env.TURN_USERNAME || env.CF_TURN_KEY_ID), applicationRelay: env.APPLICATION_RELAY === '1' };
  });
}

// ---- sandbox -----------------------------------------------------------------------------------------------------
await step('start Windows Sandbox', async () => {
  for (const e of wsbJson(['list'])?.WindowsSandboxEnvironments ?? []) wsb(['stop', '--id', e.Id], { allowFail: true });
  const config = `<Configuration><Networking>Enable</Networking><MappedFolders>`
    + `<MappedFolder><HostFolder>${share}</HostFolder><SandboxFolder>C:\\hx-share</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>`
    + `<MappedFolder><HostFolder>${sbLogs}</HostFolder><SandboxFolder>C:\\hx-logs</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>`
    + `</MappedFolders></Configuration>`;
  sandboxId = wsbJson(['start', '--config', config])?.Id;
  if (!sandboxId) throw new Error('wsb start returned no id');
  sandboxIp = await until(() => wsbJson(['ip', '--id', sandboxId], { allowFail: true })?.Networks?.[0]?.IpV4Address, 'sandbox IP', 120_000, 1000);
  // A signed-in session is needed for a window: the sandbox's own remote desktop opens it.
  spawn('wsb', ['connect', '--id', sandboxId], { detached: true, stdio: 'ignore' }).unref();
  await until(() => run('wsb', ['exec', '--id', sandboxId, '-c', 'C:\\Windows\\System32\\whoami.exe', '-r', 'ExistingLogin'], { allowFail: true }).status === 0, 'sandbox user session', 180_000, 2000);
  run('wsb', ['exec', '--id', sandboxId, '-c', 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\hx-share\\setup.ps1', '-r', 'System']);
  return { id: sandboxId, ip: sandboxIp };
});

// ---- apps --------------------------------------------------------------------------------------------------------
await step('launch the app on both machines', async () => {
  const { openSync } = await import('node:fs');
  const err = openSync(join(out, 'host', 'app-stderr.txt'), 'a');
  hostApp = spawn(join(share, 'app', 'hivetex-desktop.exe'), ['--ignore-system-tex'], {
    stdio: ['ignore', err, err], env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${HOST_CDP}` },
  });
  children.push(hostApp);
  run('wsb', ['exec', '--id', sandboxId, '-c', 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\hx-share\\launch.ps1', '-r', 'ExistingLogin']);
});

const { chromium } = await import('@playwright/test');
async function attach(url, label) {
  await until(() => fetch(`${url}/json/version`).then((r) => r.ok).catch(() => false), `${label} DevTools endpoint`, 120_000, 1000);
  const browser = await chromium.connectOverCDP(url);
  const page = await until(() => browser.contexts().flatMap((c) => c.pages()).find((p) => !p.isClosed() && !p.url().startsWith('devtools')), `${label} page`);
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__ && !!document.getElementById('app'), null, { timeout: 60_000 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLines[label].push(`${new Date().toISOString()} ${m.type()} ${m.text()}`); });
  return { browser, page, label };
}
const A = await step('attach to both apps (DevTools)', async () => ({ host: await attach(`http://127.0.0.1:${HOST_CDP}`, 'host'), sandbox: await attach(`http://${sandboxIp}:${SB_CDP_PUBLIC}`, 'sandbox') }));
host = A.host;
sb = A.sandbox;
delete summary.steps.at(-1).value;

async function signUp({ page }, username) {
  await page.waitForTimeout(1500);
  if (await page.getByRole('button', { name: 'Account menu' }).isVisible()) {
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  }
  await page.evaluate((srv) => {
    localStorage.setItem('hivetex.test', '1');
    if (srv !== 'http://localhost:3000') localStorage.setItem('serverUrl', srv);
    else localStorage.removeItem('serverUrl');
  }, server);
  await page.evaluate(() => location.reload());
  await page.waitForFunction(() => !!document.getElementById('app'));
  await page.evaluate(() => { location.hash = '#/register'; });
  await page.getByLabel('Repeat password').waitFor();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Email').fill(`${username}@example.com`);
  await page.locator('#reg-pw').fill(PW);
  await page.locator('#reg-pw2').fill(PW);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Your projects' }).waitFor({ timeout: 60_000 });
}
const tag = Date.now().toString(36);
const userA = `hostA${tag}`;
const userB = `sbB${tag}`;
await step('register an account on each machine', async () => {
  await Promise.all([signUp(host, userA), signUp(sb, userB)]);
  return { host: userA, sandbox: userB };
});

let slug;
await step('host creates the project; joiners become editors', async () => {
  const { page } = host;
  await page.getByTestId('new-project-btn').click();
  await page.getByPlaceholder('my-paper-2026').fill(`sync-${tag}`);
  await page.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByTestId('workspace').waitFor({ timeout: 60_000 });
  slug = (await page.getByTestId('project-slug').textContent())?.trim();
  await page.getByTestId('settings-btn').click();
  const dialog = page.getByTestId('settings-dialog');
  const role = dialog.getByLabel('Default role for new members');
  await role.selectOption('editor');
  await role.locator('xpath=..').getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByText('Saved').waitFor();
  await page.keyboard.press('Escape');
  return { slug };
});
// FAULT=deaf-silent: the host's server subscription stops delivering while its socket stays open and present (what a
// silently ended Upstash stream did in production); FAULT=deaf: the same loss, reported, as the server now handles it.
if (process.env.FAULT === 'deaf' || process.env.FAULT === 'deaf-silent') {
  await step(`inject fault ${process.env.FAULT} on the server`, async () => {
    if (!localServer) throw new Error('faults need the local server');
    const silent = process.env.FAULT === 'deaf-silent' ? '?silent=1' : '';
    const r = await (await fetch(`http://localhost:3000/api/__dev/signal/lose-subscriptions${silent}`)).json();
    if (!r.lost) throw new Error('no subscription to lose: the host is not connected to the server');
    return r;
  });
}
await step('sandbox joins the project', async () => {
  const { page } = sb;
  await page.getByTestId('join-btn').click();
  await page.locator('form:has(h2:text("Join a project")) input[type=text]').fill(slug);
  await page.locator('form:has(h2:text("Join a project")) input[type=password]').fill(PROJECT_PW);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByTestId('workspace').waitFor({ timeout: 60_000 });
});
await tryStep('the sandbox joined as editor', async () => {
  const role = await until(() => sb.page.evaluate(() => window.__p2p?.session?.project?.role), 'joined role');
  if (role !== 'editor') throw new Error(`joined as ${role}: the default role was not saved (its edits will be refused)`);
});

// ---- sync checks -------------------------------------------------------------------------------------------------
/** An app that stops answering (a pending dialog, a stalled VM) fails the step in seconds instead of hanging it. */
const CALL_MS = 20_000;
const bounded = (side, what, p, ms = CALL_MS) => Promise.race([p, pause(ms).then(() => { throw new Error(`the ${side.label} app did not answer within ${ms / 1000} s (${what}): a dialog waiting for an answer, or the app stalled`); })]);
const create = (side, path, text) => bounded(side, 'create', side.page.evaluate(async ([p, t]) => {
  const s = window.__p2p.session;
  const id = await s.model.createTextNow(p, t);
  await s.model.flush();
  return id;
}, [path, text]));
const append = (side, id, text) => bounded(side, 'edit', side.page.evaluate(async ([f, t]) => {
  const s = window.__p2p.session;
  const y = await s.model.openText(f);
  y.insert(y.length, t);
  await s.model.flush();
}, [id, text]));
const textOf = (side, id) => bounded(side, 'read', side.page.evaluate(async (f) => {
  const s = window.__p2p?.session;
  if (!s?.model.files.has(f)) return null;
  return (await s.model.openText(f)).toString();
}, id));
const peers = (side) => bounded(side, 'peers', side.page.evaluate(() => (window.__p2p?.session?.peers ?? []).map((p) => ({ dev: p.dev, uname: p.uname, route: p.route, role: p.role, limited: p.limited }))));
const SYNC_MS = Number(process.env.SYNC_TIMEOUT_MS ?? 90_000);

await tryStep('peers see each other with a route', async () => {
  const [a, b] = await until(async () => {
    const x = await Promise.all([peers(host), peers(sb)]);
    return x[0].some((p) => p.route) && x[1].some((p) => p.route) ? x : null;
  }, 'a route on both sides', SYNC_MS, 1000);
  return { host: a, sandbox: b };
});
let mainId;
await tryStep('host → sandbox: a new file arrives', async () => {
  mainId = await create(host, 'main.tex', `\\documentclass{article}\n% written on the host ${tag}\n`);
  await until(async () => (await textOf(sb, mainId))?.includes(`written on the host ${tag}`), 'main.tex on the sandbox', SYNC_MS);
});
let notesId;
await tryStep('sandbox → host: a new file arrives', async () => {
  notesId = await create(sb, 'notes.tex', `written in the sandbox ${tag}\n`);
  await until(async () => (await textOf(host, notesId))?.includes(`written in the sandbox ${tag}`), 'notes.tex on the host', SYNC_MS);
});
await tryStep('sandbox → host: an edit to the host’s file arrives', async () => {
  if (!mainId || !(await textOf(sb, mainId))) throw new Error('main.tex never reached the sandbox');
  await append(sb, mainId, `% edited in the sandbox ${tag}\n`);
  await until(async () => (await textOf(host, mainId))?.includes(`edited in the sandbox ${tag}`), 'sandbox edit on the host', SYNC_MS);
});
await tryStep('concurrent edits on both sides converge', async () => {
  if (!mainId || !(await textOf(sb, mainId))) throw new Error('main.tex never reached the sandbox');
  await Promise.all([append(host, mainId, `% both: host ${tag}\n`), append(sb, mainId, `% both: sandbox ${tag}\n`)]);
  const [a, b] = await until(async () => {
    const x = await Promise.all([textOf(host, mainId), textOf(sb, mainId)]);
    return x[0] === x[1] && x[0]?.includes(`both: host ${tag}`) && x[0]?.includes(`both: sandbox ${tag}`) ? x : null;
  }, 'identical main.tex on both sides', SYNC_MS);
  return { length: a.length, identical: a === b };
});

// ---- hold: keep editing for a while ------------------------------------------------------------------------------
// One edit every 5 s, alternating sides; each must reach the other side within HOLD_MAX_MS. Catches links that connect
// and then die (the route is sampled on every edit and route changes are recorded).
const HOLD_S = Number(process.env.HOLD_S ?? 0);
const HOLD_MAX_MS = Number(process.env.HOLD_MAX_MS ?? 10_000);
if (HOLD_S > 0) {
  await tryStep(`hold: edits both ways for ${HOLD_S} s, each arriving within ${HOLD_MAX_MS / 1000} s`, async () => {
    if (!mainId || !(await textOf(sb, mainId))) throw new Error('main.tex never reached the sandbox');
    const end = Date.now() + HOLD_S * 1000;
    const latencies = [];
    const late = [];
    const routes = [];
    let lastRoutes = '';
    let n = 0;
    while (Date.now() < end) {
      const [from, to] = n % 2 === 0 ? [host, sb] : [sb, host];
      const marker = `% hold ${n} from ${from.label} ${tag}`;
      const t = Date.now();
      await append(from, mainId, `${marker}\n`);
      const ms = await until(async () => (await textOf(to, mainId))?.includes(marker), `hold edit ${n}`, HOLD_MAX_MS, 200).then(() => Date.now() - t).catch(() => null);
      if (ms === null) late.push({ n, from: from.label, at: new Date(t).toISOString() });
      else latencies.push(ms);
      const now = `${(await peers(host).catch(() => [])).map((p) => p.route).join(',') || '-'} | ${(await peers(sb).catch(() => [])).map((p) => p.route).join(',') || '-'}`;
      if (now !== lastRoutes) {
        routes.push({ at: new Date().toISOString(), routes: now });
        lastRoutes = now;
      }
      n++;
      await pause(Math.max(0, 5000 - (Date.now() - t)));
    }
    latencies.sort((x, y) => x - y);
    const result = { edits: n, late: late.length, medianMs: latencies[Math.floor(latencies.length / 2)] ?? null, maxMs: latencies.at(-1) ?? null, routes, lateEdits: late.slice(0, 20) };
    summary.hold = result;
    if (late.length) throw new Error(`${late.length} of ${n} edits did not arrive within ${HOLD_MAX_MS} ms; routes (host | sandbox): ${routes.map((r) => r.routes).join(' -> ')}`);
    return result;
  });
}

// ---- connection test from both sides at once ---------------------------------------------------------------------
const probe = (side) => bounded(side, 'connection test', side.page.evaluate(async () => {
  const s = window.__p2p.session;
  const other = s.peers[0]?.dev ?? Object.keys(s.syncDiagnostics()?.stages ?? {})[0];
  if (!other) return { error: 'no co-author device known' };
  return s.probePeer(other);
}), 90_000).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
await tryStep('connection test (Test connection) on both sides at once', async () => {
  const [a, b] = await Promise.all([probe(host), probe(sb)]);
  writeFileSync(join(out, 'host', 'probe.json'), JSON.stringify(a, null, 2));
  writeFileSync(join(sbLogs, 'probe.json'), JSON.stringify(b, null, 2));
  summary.probe = { host: a?.verdict ?? a?.error ?? a, sandbox: b?.verdict ?? b?.error ?? b };
  const ok = (p) => /^Connected/.test(p?.verdict ?? '');
  if (!ok(a) || !ok(b)) throw new Error(`host: ${a?.verdict ?? a?.error}; sandbox: ${b?.verdict ?? b?.error}`);
});

} catch {
  failed = true;
}

// ---- collect -----------------------------------------------------------------------------------------------------
const diagnostics = (side) => !side ? Promise.resolve(null) : Promise.race([side.page.evaluate(() => {
  const s = window.__p2p?.session;
  return s ? { status: s.syncStatus, peers: s.peers, files: [...s.model.files.keys()], diagnostics: s.syncDiagnostics() } : null;
}), pause(30_000).then(() => { throw new Error(`the ${side.label} app did not answer within 30 s`); })]).catch((e) => ({ error: String(e) }));
await step('collect diagnostics and logs', async () => {
  const [a, b] = await Promise.all([diagnostics(host), diagnostics(sb)]);
  writeFileSync(join(out, 'host', 'diagnostics.json'), JSON.stringify(a, null, 2));
  writeFileSync(join(sbLogs, 'diagnostics.json'), JSON.stringify(b, null, 2));
  writeFileSync(join(out, 'host', 'console.txt'), consoleLines.host.join('\n'));
  writeFileSync(join(sbLogs, 'console.txt'), consoleLines.sandbox.join('\n'));
  const nativeLog = join(process.env.APPDATA ?? '', 'app.hivetex.desktop.e2e', 'logs', 'native.log');
  if (existsSync(nativeLog)) cpSync(nativeLog, join(out, 'host', 'native.log'));
  if (sandboxId) run('wsb', ['exec', '--id', sandboxId, '-c', 'C:\\hx-share\\collect.cmd', '-r', 'ExistingLogin'], { allowFail: true });
  // One timeline: both apps' traces and what the server routed, by time.
  const rows = [];
  const short = (d) => (d ? String(d).slice(0, 8) : '');
  const fmtData = (o) => (o ? Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ') : '');
  for (const [who, d] of [['HOST   ', a], ['SANDBOX', b]]) {
    const trace = d?.diagnostics?.trace ?? [];
    writeFileSync(join(who.trim() === 'HOST' ? join(out, 'host') : sbLogs, 'trace.jsonl'), trace.map((e) => JSON.stringify(e)).join('\n'));
    for (const e of trace) rows.push([e.t, `${who} ${short(e.self)}${e.dev ? ` -> ${short(e.dev)}` : ''} ${e.ev} ${fmtData(e.data)}`]);
  }
  const sig = join(out, 'server', 'signal.jsonl');
  if (existsSync(sig)) {
    for (const line of readFileSync(sig, 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(line);
      if (e.type === 'pong' || e.type === 'ping') continue;
      const { t, conn, dir, ...rest } = e;
      rows.push([t, `SERVER  conn${conn} ${dir} ${fmtData(rest)}`]);
    }
  }
  rows.sort((x, y) => x[0] - y[0]);
  const t0 = rows[0]?.[0] ?? Date.now();
  writeFileSync(join(out, 'timeline.txt'), rows.map(([t, s]) => `${new Date(t).toISOString().slice(11, 23)} +${String(t - t0).padStart(7)} ${s}`).join('\n'));
  return { traceSteps: { host: a?.diagnostics?.trace?.length ?? 0, sandbox: b?.diagnostics?.trace?.length ?? 0 }, routes: { host: a?.peers?.map((p) => p.route), sandbox: b?.peers?.map((p) => p.route) } };
}).catch(() => { failed = true; });

summary.finishedAt = new Date().toISOString();
summary.result = failed ? 'FAIL' : 'PASS';
summary.out = out;
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
log(`${summary.result} — results in ${out}`);

if (!process.env.KEEP) {
  for (const s of [host, sb]) await s?.browser.close().catch(() => {});
  for (const c of children) if (c.pid) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
  if (sandboxId) wsb(['stop', '--id', sandboxId], { allowFail: true });
}
process.exit(failed ? 1 : 0);
