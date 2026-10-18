/**
 * Shared by the desktop harnesses (run.mjs, lifecycle.mjs, background.mjs, sandbox-sync.mjs): the E2E build's own
 * target directory and app identity, the leftover-instance check, and an orderly `app_quit` before forced termination.
 *
 *   E2E_TARGET_DIR    Cargo target of the E2E build; default CARGO_TARGET_DIR, else apps/desktop/src-tauri/target/e2e.
 *                     Never target/debug, which `tauri dev` uses: the test build must not replace the development app.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const win = process.platform === 'win32';
export const here = dirname(fileURLToPath(import.meta.url));
export const desktop = resolve(here, '..');
export const root = resolve(desktop, '../..');
export const srcTauri = join(desktop, 'src-tauri');
export const e2eConfig = join(here, 'tauri.e2e.conf.json');
export const identifier = JSON.parse(readFileSync(e2eConfig, 'utf8')).identifier;

const inside = (child, parent) => { const r = relative(resolve(parent), resolve(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const devTarget = join(srcTauri, 'target');
let target = resolve(process.env.E2E_TARGET_DIR || process.env.CARGO_TARGET_DIR || join(devTarget, 'e2e'));
// The development target itself would put the test build on target/debug/hivetex-desktop.exe.
if (resolve(target).toLowerCase() === resolve(devTarget).toLowerCase()) target = join(devTarget, 'e2e');
export const targetDir = target;
export const debugDir = join(targetDir, 'debug');
export const appExe = join(debugDir, win ? 'hivetex-desktop.exe' : 'hivetex-desktop');

/** Free bytes on the volume holding `dir` (or its nearest existing parent). */
export function freeBytes(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    try { const s = statfsSync(d); return Number(s.bavail) * Number(s.bsize); } catch (e) { if (dirname(d) === d) throw e; }
  }
}
export const gib = (n) => `${(n / 1024 ** 3).toFixed(1)} GiB`;

/** Builds the test app (test-picker feature, E2E identity) into `targetDir`. `run(cmd, args, opts)` must throw on failure. */
export function buildApp(run, extra = {}) {
  run(process.execPath, [join(desktop, 'prepare-worker.mjs')], { cwd: desktop, shell: false, ...extra });
  run('pnpm', ['exec', 'tauri', 'build', '--debug', '--no-bundle', '--features', 'test-picker', '--config', e2eConfig], {
    cwd: desktop, shell: win, ...extra,
    env: { ...process.env, CARGO_TARGET_DIR: targetDir, VITE_API_BASE: 'http://localhost:3000', VITE_E2E: '1', ...(extra.env ?? {}) },
  });
}

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`PowerShell failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Whether a test instance holds the single-instance mutex, and every running hivetex-desktop process. */
export function instances() {
  if (!win) return { held: false, apps: [] };
  const v = JSON.parse(ps(`$m = $null; $held = [System.Threading.Mutex]::TryOpenExisting('${identifier}-sim', [ref]$m); if ($m) { $m.Dispose() }; `
    + `[pscustomobject]@{ held = $held; apps = @(Get-Process hivetex-desktop -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ id = $_.Id; path = $_.Path } }) } | ConvertTo-Json -Compress -Depth 3`));
  return { held: Boolean(v.held), apps: (Array.isArray(v.apps) ? v.apps : v.apps ? [v.apps] : []).filter(Boolean) };
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export const forceKill = (pid) => (win ? spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) : (() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } })());
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Before a launch: no test instance may be running, or the new launch would hand over to it (single instance) and the
 * harness would drive an old build. A leftover test build (under the E2E target, a sandbox share or the temp folder) is
 * stopped; otherwise the run fails naming the processes.
 */
export async function ensureNoTestInstance(extraDirs = []) {
  let s = instances();
  if (!s.held) return { leftover: [] };
  // target/debug is not ours to stop: it may be the developer's `tauri dev` app (another identity).
  const ours = (p) => p.path && [targetDir, tmpdir(), ...extraDirs].some((d) => inside(p.path, d));
  const stopped = s.apps.filter(ours);
  for (const p of stopped) forceKill(p.id);
  for (let i = 0; i < 50 && s.held; i++) { await pause(200); s = instances(); }
  if (s.held) {
    throw new Error(`a previous ${identifier} test instance is still running (it would receive this launch and the test would drive an old build); `
      + `running hivetex-desktop processes: ${s.apps.map((p) => `${p.id} ${p.path ?? '?'}`).join(', ') || 'none visible'}. Quit it (tray > Quit) or Stop-Process -Id <id>`);
  }
  if (stopped.length) console.log(`# stopped leftover test instance(s): ${stopped.map((p) => `${p.id} ${p.path}`).join(', ')}`);
  return { leftover: stopped };
}

/** `app_quit` through a page that has the Tauri bridge (Playwright page or CDP target). */
export const quitThroughPage = (page) => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_quit', { discard: false }));

/** `app_quit` through WebView2's DevTools port, without Playwright (lifecycle.mjs). Rejects when no page answers. */
export async function quitThroughCdp(port, ms = 5000) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(ms) }).then((r) => r.json());
  const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('no page');
  await new Promise((ok, fail) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => { ws.close(); fail(new Error('CDP timeout')); }, ms);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "window.__TAURI_INTERNALS__.invoke('app_quit', { discard: false })", awaitPromise: false } }));
    ws.onmessage = () => { clearTimeout(timer); ws.close(); ok(); };
    ws.onerror = () => { clearTimeout(timer); fail(new Error('CDP error')); };
  });
}

/** Asks the app to quit (`quit`, when given), waits up to `ms`, then forces termination. Returns how it ended. */
export async function stopApp(pid, quit, ms = 20_000) {
  if (!pid || !alive(pid)) return 'gone';
  if (quit) {
    try { await quit(); } catch { /* no page: force below */ }
    for (const end = Date.now() + ms; Date.now() < end && alive(pid); ) await pause(200);
    if (!alive(pid)) return 'quit';
  }
  forceKill(pid);
  for (let i = 0; i < 25 && alive(pid); i++) await pause(200);
  return alive(pid) ? 'stuck' : 'killed';
}
