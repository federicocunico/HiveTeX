#!/usr/bin/env node
/**
 * Desktop UI tests (`make desktop-e2e`): builds a debug app with the `test-picker` feature (the native folder dialog
 * returns a test folder), starts the local server, then drives the real app through tauri-driver + WebDriver.
 *
 * Needs `tauri-driver` (cargo install tauri-driver --locked) and the platform driver: on Windows the msedgedriver
 * matching the installed WebView2 runtime is downloaded once into src-tauri/target/msedgedriver/<version>/ (or set
 * MSEDGEDRIVER=path to use your own); on Linux, WebKitWebDriver (webkit2gtk-driver).
 * SKIP_BUILD=1 reuses the last build; SKIP_SERVER=1 uses a server already listening on :3000. Extra arguments go to
 * node --test (e.g. --test-name-pattern="application relay").
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const root = resolve(desktop, '../..');
const win = process.platform === 'win32';
const exe = join(desktop, 'src-tauri/target/debug', win ? 'hivetex-desktop.exe' : 'hivetex-desktop');
const children = [];
// Not 4444 (tauri-driver's default; the Docker stack's Neon proxy listens there) nor 4445 (its native driver).
const DRIVER_PORT = process.env.HIVETEX_DRIVER_PORT ?? '4446';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: win, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

async function waitFor(url, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}

/** The installed WebView2 runtime version (Windows), from the Edge updater's registry entry. */
function webview2Version() {
  const key = 'Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  for (const root of ['HKLM\\SOFTWARE\\WOW6432Node', 'HKCU\\Software', 'HKLM\\SOFTWARE']) {
    const r = spawnSync('reg', ['query', `${root}\\${key}`, '/v', 'pv'], { encoding: 'utf8' });
    const v = /pv\s+REG_SZ\s+([\d.]+)/.exec(r.stdout ?? '')?.[1];
    if (v && v !== '0.0.0.0') return v;
  }
  return null;
}

/** Windows: msedgedriver must match WebView2 exactly, so fetch that version once and keep it with the build output. */
async function edgeDriver() {
  if (process.env.MSEDGEDRIVER) return process.env.MSEDGEDRIVER;
  const manual = 'download it from https://developer.microsoft.com/microsoft-edge/tools/webdriver/ and set MSEDGEDRIVER=C:\\path\\msedgedriver.exe';
  const ver = webview2Version();
  if (!ver) throw new Error(`WebView2 runtime not found. Install it (https://go.microsoft.com/fwlink/p/?LinkId=2124703), or ${manual}`);
  const dir = join(desktop, 'src-tauri/target/msedgedriver', ver);
  const driver = join(dir, 'msedgedriver.exe');
  if (existsSync(driver)) return driver;
  console.log(`Downloading msedgedriver ${ver} to match the installed WebView2…`);
  const res = await fetch(`https://msedgedriver.microsoft.com/${ver}/edgedriver_win64.zip`).catch(() => null);
  if (!res?.ok) throw new Error(`Could not download msedgedriver ${ver} (${res ? `HTTP ${res.status}` : 'no connection'}); ${manual}`);
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, 'edgedriver.zip');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  // Windows' own tar (bsdtar) reads zip files; a GNU tar earlier on PATH (Git Bash) would not.
  run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir], { shell: false });
  rmSync(zip, { force: true });
  if (!existsSync(driver)) throw new Error(`msedgedriver.exe missing from the download; ${manual}`);
  return driver;
}

function start(cmd, args, env = {}) {
  const c = spawn(cmd, args, { stdio: 'inherit', shell: win, env: { ...process.env, ...env } });
  children.push(c);
  return c;
}

const pickDir = mkdtempSync(join(tmpdir(), 'hivetex-desktop-e2e-'));
let code = 1;
try {
  const nativeDriver = win ? await edgeDriver() : null;
  if (!process.env.SKIP_BUILD) {
    run('npx', ['tauri', 'build', '--debug', '--no-bundle', '--features', 'test-picker', '--config', join(here, 'tauri.e2e.conf.json')], {
      cwd: desktop,
      env: { ...process.env, VITE_API_BASE: 'http://localhost:3000', VITE_E2E: '1' },
    });
  }
  if (!existsSync(exe)) throw new Error(`app not built: ${exe}`);
  if (!process.env.SKIP_SERVER) {
    start('npx', ['pnpm@10', '--filter', '@hivetex/server', 'dev'], { MEMORY_DB: '1', PORT: '3000', E2E_NO_LIMITS: '1', APPLICATION_RELAY: '1' });
  }
  await waitFor('http://localhost:3000/api/health');
  // The application-relay test drives a browser against the web app as well.
  if (!process.env.SKIP_SERVER) {
    start('npx', ['pnpm@10', '--filter', '@hivetex/web', 'dev']);
    await waitFor('http://localhost:1420');
  }
  const driverArgs = ['--port', DRIVER_PORT];
  if (nativeDriver) driverArgs.push('--native-driver', nativeDriver);
  start('tauri-driver', driverArgs, { HIVETEX_TEST_PICK_DIR: pickDir });
  await waitFor(`http://127.0.0.1:${DRIVER_PORT}/status`, 30_000);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), join(here, process.env.HIVETEX_E2E_FILE ?? 'desktop.test.mjs')], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, HIVETEX_APP: exe, HIVETEX_TEST_PICK_DIR: pickDir, HIVETEX_DRIVER_PORT: DRIVER_PORT },
  });
  code = r.status ?? 1;
  // Close-to-background, second launch, pairing, restart and login start without WebDriver (the driver ends the
  // app when its only window closes). Same build, with the web dev server and API still running.
  if (code === 0 && win && !process.env.HIVETEX_E2E_FILE && !process.argv.some((x) => x.startsWith('--test-name-pattern'))) {
    const l = spawnSync(process.execPath, [join(here, 'lifecycle.mjs')], { stdio: 'inherit', cwd: root, env: { ...process.env, HIVETEX_APP: exe } });
    code = l.status ?? 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  for (const c of children) {
    if (win && c.pid) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  rmSync(pickDir, { recursive: true, force: true });
}
process.exit(code);
