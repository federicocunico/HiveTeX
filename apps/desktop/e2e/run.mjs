#!/usr/bin/env node
/**
 * Desktop UI tests (`make desktop-e2e`): builds a debug app with the `test-picker` feature (the native folder dialog
 * returns a test folder), starts the local server, then drives the real app through tauri-driver + WebDriver.
 *
 * Needs `tauri-driver` (cargo install tauri-driver --locked) and the platform driver: msedgedriver matching the
 * WebView2 runtime on Windows (MSEDGEDRIVER=path or on PATH), WebKitWebDriver on Linux (webkit2gtk-driver).
 * SKIP_BUILD=1 reuses the last build; SKIP_SERVER=1 uses a server already listening on :3000.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const root = resolve(desktop, '../..');
const win = process.platform === 'win32';
const exe = join(desktop, 'src-tauri/target/debug', win ? 'p2platex-desktop.exe' : 'p2platex-desktop');
const children = [];
// Not 4444 (tauri-driver's default; the Docker stack's Neon proxy listens there) nor 4445 (its native driver).
const DRIVER_PORT = process.env.P2PLATEX_DRIVER_PORT ?? '4446';

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

function start(cmd, args, env = {}) {
  const c = spawn(cmd, args, { stdio: 'inherit', shell: win, env: { ...process.env, ...env } });
  children.push(c);
  return c;
}

const pickDir = mkdtempSync(join(tmpdir(), 'p2platex-desktop-e2e-'));
let code = 1;
try {
  if (!process.env.SKIP_BUILD) {
    run('npx', ['tauri', 'build', '--debug', '--no-bundle', '--features', 'test-picker', '--config', join(here, 'tauri.e2e.conf.json')], {
      cwd: desktop,
      env: { ...process.env, VITE_API_BASE: 'http://localhost:3000' },
    });
  }
  if (!existsSync(exe)) throw new Error(`app not built: ${exe}`);
  if (!process.env.SKIP_SERVER) {
    start('npx', ['pnpm@10', '--filter', '@p2platex/server', 'dev'], { MEMORY_DB: '1', PORT: '3000', E2E_NO_LIMITS: '1' });
  }
  await waitFor('http://localhost:3000/api/health');
  const driverArgs = ['--port', DRIVER_PORT];
  if (win && process.env.MSEDGEDRIVER) driverArgs.push('--native-driver', process.env.MSEDGEDRIVER);
  start('tauri-driver', driverArgs, { P2PLATEX_TEST_PICK_DIR: pickDir });
  await waitFor(`http://127.0.0.1:${DRIVER_PORT}/status`, 30_000);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', join(here, 'desktop.test.mjs')], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, P2PLATEX_APP: exe, P2PLATEX_TEST_PICK_DIR: pickDir, P2PLATEX_DRIVER_PORT: DRIVER_PORT },
  });
  code = r.status ?? 1;
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
