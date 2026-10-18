#!/usr/bin/env node
/**
 * Two-machine sync test (`make sandbox-sync`): the desktop test build runs on this PC and inside Windows Sandbox (its
 * own VM behind Hyper-V NAT), both sign in to one server, share a project and edit it; the script checks every edit
 * arrives on the other side and collects everything needed to say why when it does not. Phases (docs/testing.md):
 *
 *   1. preflight     free space, leftover test instances, isolated host profile, host firewall (recorded; a profile
 *                    facing the sandbox that could block the run stops it with `firewall:` before any sync step)
 *   2. sandbox       setup.ps1 runs as System, fail-fast: firewall off and verified (FAULT=no-udp: on, UDP blocked for
 *                    the app, verified); the verified state is in sandbox/setup.txt and summary.json
 *   3. reachability  before sign-in: sandbox -> host TCP :3000, UDP echo both ways (the app's own node.exe in the
 *                    sandbox); a failure stops the run with `reachability:` instead of a sync failure
 *   4. scenarios     SCENARIOS=basic,assets,rename-delete,offline,crash,author,recovery,folder,compile,mixed (default basic)
 *
 *   <out>/summary.json        preflight, firewall (host and sandbox), reachability, steps with pass/fail and timings,
 *                             routes, sync within 5 s, scenarios, hold; written also when build or staging fails
 *   <out>/timeline.txt        both apps' (and the browser's) connection traces and the server's signaling log, by time
 *   <out>/host|sandbox/       diagnostics, the full trace, console, app stderr, native.log, recovery exports
 *   <out>/server/             server output, signaling log (SIGNAL_LOG), request log (REQUEST_LOG)
 *
 * Needs Windows 11 with Windows Sandbox and its CLI (wsb). The sandbox window opens (the app needs a signed-in
 * desktop session); Windows Sandbox runs one instance, so a running one is stopped first.
 *
 *   SANDBOX_OUT=<dir>          results and the staged app (default <E2E target>/sandbox-sync); put it on a volume with
 *                              space (SANDBOX_MIN_FREE_GB, default 3, is checked first)
 *   E2E_TARGET_DIR=<dir>       the test build's Cargo target (default CARGO_TARGET_DIR, else src-tauri/target/e2e)
 *   SKIP_BUILD=1               reuse the last test build in that target
 *   SCENARIOS=a,b              data-safety scenarios after the basic checks (see SCENARIO_NAMES below)
 *   SABOTAGE=1                 both apps discard text edits and binary files received from the other side (on purpose):
 *                              every scenario must then fail
 *   SERVER=https://host        use that server (it must accept registrations) instead of starting the local one
 *   NO_APP_RELAY=0             the local server also offers the application relay (default: WebRTC only)
 *   KEEP=1                     leave the apps, the server and the sandbox running at the end
 *   TURN_USERNAME/TURN_CREDENTIAL/TURN_SERVER   the local server hands out this relay, like production
 *   FAULT=no-udp               the sandbox firewall stays on and blocks UDP for the app: WebRTC never works and the
 *                              application relay carries the session (checked: route relay, no UDP pair)
 *   FAULT=offline              the offline scenario cuts the sandbox off with its firewall (new connections to the host
 *                              and the Internet blocked, DevTools kept) instead of the app's offline mode; checked
 *   FAULT=deaf-silent | deaf   before the sandbox joins, the host's server subscription stops delivering: silently (the
 *                              production failure) or reported (the server then closes the session and the host reconnects)
 *   HOST_FIREWALL_ASSUME_ENABLED=1   treat the host profile facing the sandbox as enabled (checks the stop on missing rules)
 *   SYNC_TIMEOUT_MS=90000      how long each sync check waits
 *   HOLD_S=180                 then keep editing for that long (one edit every 5 s, alternating sides), each edit must
 *                              arrive within HOLD_MAX_MS (default 10000); halfway the server ends every signaling socket
 *                              (ROTATE=0: not); route changes are recorded in summary.json
 *   MATRIX=stun,turn,relay,relay-stun,deaf,no-udp   run these local-server scenarios one after the other and print a
 *                              table: stun (no TURN, no application relay), turn (TURN), relay (TURN + application relay),
 *                              relay-stun (application relay, no TURN), deaf (relay + FAULT=deaf), no-udp (relay +
 *                              FAULT=no-udp); without TURN_* the scenarios that need it are "not run: missing credentials"
 *   INTERRUPT_AFTER=<step>     act as if Ctrl+C came after that step (checks the interrupted cleanup)
 *
 *   node apps/desktop/e2e/sandbox-sync.mjs --firewall-rules   (`make sandbox-firewall`, elevated): inbound allow rules
 *                              for the exact app and server executables this run uses on the host
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { appExe, buildApp, debugDir, ensureNoTestInstance, freeBytes, gib, identifier, quitThroughPage, root, stopApp, targetDir } from './harness.mjs';

const base = resolve(process.env.SANDBOX_OUT || join(targetDir, 'sandbox-sync'));
const share = join(base, 'share'); // read-only in the sandbox: the app and the sandbox scripts
const hostAppPath = join(share, 'app', 'hivetex-desktop.exe');
const nodePath = process.execPath; // the local server runs on exactly this node.exe
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + (process.env.OUT_TAG ? `-${process.env.OUT_TAG}` : '');
const out = join(base, runId);
const SCENARIO_NAMES = ['basic', 'assets', 'rename-delete', 'offline', 'crash', 'author', 'recovery', 'folder', 'compile', 'mixed'];
const ps = (script, opts = {}) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, ...opts });
const psJson = (script) => {
  const r = ps(`$ErrorActionPreference = 'Stop'; ${script}`);
  if (r.status !== 0) throw new Error(`PowerShell: ${(r.stderr || r.stdout).trim()}`);
  return JSON.parse(r.stdout.trim() || 'null');
};
const psq = (s) => `'${String(s).replaceAll("'", "''")}'`;
const chromiumPath = async () => { try { return (await import('@playwright/test')).chromium.executablePath(); } catch { return null; } };

// ---- make sandbox-firewall: allow rules for the exact executables (elevated, run by the user) ----------------------
if (process.argv.includes('--firewall-rules')) {
  const programs = [['app', hostAppPath], ['server', nodePath]];
  const browser = await chromiumPath();
  if (browser) programs.push(['browser (mixed scenario)', browser]);
  const script = [
    "if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Error 'run this from an elevated (Administrator) shell'; exit 1 }",
    "Remove-NetFirewallRule -Group 'HiveTeX sandbox-sync' -ErrorAction SilentlyContinue",
    ...programs.map(([name, p]) => `New-NetFirewallRule -DisplayName ${psq(`HiveTeX sandbox-sync ${name}`)} -Group 'HiveTeX sandbox-sync' -Direction Inbound -Action Allow -Profile Any -Program ${psq(p)} | Out-Null; Write-Host ${psq(`allowed inbound: ${p}`)}`),
  ].join('; ');
  const r = ps(script, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

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
  mkdirSync(base, { recursive: true });
  const rows = [];
  let built = Boolean(process.env.SKIP_BUILD);
  let child = null;
  let stop = false;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { stop = true; }); // the child gets the same Ctrl+C and cleans up
  for (const name of process.env.MATRIX.split(',').filter(Boolean)) {
    const s = MATRIX[name];
    if (!s) throw new Error(`unknown MATRIX scenario ${name} (known: ${Object.keys(MATRIX).join(', ')})`);
    if (stop) { rows.push({ name, result: 'not run: interrupted' }); continue; }
    if (s.turn && !(process.env.TURN_SERVER && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL)) {
      rows.push({ name, result: 'not run: missing credentials (TURN_SERVER/TURN_USERNAME/TURN_CREDENTIAL)' });
      continue;
    }
    const env = { ...process.env, MATRIX: '', OUT_TAG: name, NO_APP_RELAY: s.relay ? '0' : '1', ...(built ? { SKIP_BUILD: '1' } : {}) };
    if (!s.turn) for (const k of ['TURN_SERVER', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'TURN_URLS']) delete env[k];
    if (s.fault) env.FAULT = s.fault;
    else delete env.FAULT;
    console.log(`\n=== scenario ${name}`);
    child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env });
    await new Promise((r) => child.once('exit', r));
    built = true;
    const dir = readdirSync(base).filter((d) => d.endsWith(`-${name}`)).sort().at(-1);
    const sum = dir && existsSync(join(base, dir, 'summary.json')) ? JSON.parse(readFileSync(join(base, dir, 'summary.json'), 'utf8')) : null;
    const routes = sum?.steps.find((x) => x.name.startsWith('peers'))?.value;
    rows.push({ name, result: sum?.result ?? 'no result', diagnosis: sum?.diagnosis, failed: (sum?.steps ?? []).filter((x) => !x.ok).map((x) => x.name), route: routes?.host?.map((p) => p.route).join(',') ?? '-', sync5s: sum?.sync5s ?? null, hold: sum?.hold ?? null, dir });
  }
  const ms = (v) => (v == null ? '-' : `${v}`);
  console.log('\nscenario     result  route    sync<=5s (h->s/s->h ms)  hold (late/edits, median ms, rotation)  failed steps');
  for (const r of rows) {
    if (!r.dir) { console.log(`${r.name.padEnd(12)} ${r.result}`); continue; }
    const sync = r.sync5s ? `${r.sync5s.ok ? 'yes' : 'NO '} ${ms(r.sync5s.hostToSandboxMs)}/${ms(r.sync5s.sandboxToHostMs)}` : '-';
    const hold = r.hold ? `${r.hold.late}/${r.hold.edits}, ${r.hold.medianMs}, ${r.hold.rotation ? (r.hold.rotation.lateAfter === 0 ? 'ok' : `late ${r.hold.rotation.lateAfter}`) : '-'}` : '-';
    console.log(`${r.name.padEnd(12)} ${r.result.padEnd(7)} ${String(r.route).padEnd(8)} ${sync.padEnd(24)} ${hold.padEnd(39)} ${r.diagnosis ?? (r.failed.join('; ') || '')}`);
  }
  writeFileSync(join(base, 'matrix-summary.json'), JSON.stringify(rows, null, 2));
  const ran = rows.filter((r) => r.dir);
  process.exit(stop ? 130 : ran.length && ran.every((r) => r.result === 'PASS') ? 0 : 1);
}

// ---- one run ---------------------------------------------------------------------------------------------------------
const sbLogs = join(out, 'sandbox'); // writable in the sandbox
const HOST_CDP = 9301;
const SB_CDP = 9302; // inside the sandbox, loopback only
const SB_CDP_PUBLIC = 9303; // forwarded to SB_CDP for this PC
const ECHO_HOST = 9310; // UDP echo on this PC (reachability)
const ECHO_SB = 9311; // UDP echo in the sandbox
const localServer = !process.env.SERVER;
const server = process.env.SERVER || 'http://localhost:3000';
const FAULT = process.env.FAULT ?? '';
const scenarios = (process.env.SCENARIOS || 'basic').split(',').map((s) => s.trim()).filter(Boolean);
for (const s of scenarios) if (!SCENARIO_NAMES.includes(s)) throw new Error(`unknown scenario ${s} (known: ${SCENARIO_NAMES.join(', ')})`);
const PW = 'sandbox-sync-pw-1';
const PROJECT_PW = 'sandbox-sync-project-1';
const children = [];
const summary = { runId, server, scenarios, fault: FAULT || null, sabotage: process.env.SABOTAGE === '1', out, targetDir, steps: [], startedAt: new Date().toISOString() };

mkdirSync(join(out, 'host'), { recursive: true });
mkdirSync(join(out, 'server'), { recursive: true });
mkdirSync(sbLogs, { recursive: true });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
/** An error that ends the run with a diagnosis (`firewall: …`, `reachability: …`, `disk: …`) instead of a sync failure. */
class Stop extends Error {}
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
let interrupted = null;
async function step(name, fn) {
  const t0 = Date.now();
  log(`▶ ${name}`);
  try {
    const value = await fn();
    summary.steps.push({ name, ok: true, ms: Date.now() - t0, ...(value && typeof value === 'object' ? { value } : {}) });
    log(`✓ ${name} (${Date.now() - t0} ms)`);
    if (process.env.INTERRUPT_AFTER && name.startsWith(process.env.INTERRUPT_AFTER)) await interrupt('INTERRUPT_AFTER');
    return value;
  } catch (e) {
    summary.steps.push({ name, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
    log(`✗ ${name}: ${e instanceof Error ? e.message : e}`);
    throw e;
  }
}
let failed = false;
const consoleLines = { host: [], sandbox: [], browser: [] };
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
let sandboxId;
let sandboxIp;
let gateway;
let hostApp;
let host;
let sb;
let browserSide;
let browserApp;
const sbExec = (cmd, user = 'ExistingLogin', opts = {}) => run('wsb', ['exec', '--id', sandboxId, '-c', cmd, '-r', user], opts);
const sbPs = (file, args = '', user = 'ExistingLogin', opts = {}) => sbExec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\hx-share\\${file} ${args}`, user, opts);
const readSb = (file) => { try { return JSON.parse(readFileSync(join(sbLogs, file), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

// ---- host profile: the run's own app profile (the E2E identity), the previous one is put back afterwards ----------
const profiles = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean).map((d) => join(d, identifier));
const asideProfiles = [];
let isolated = false;
function isolateProfile() {
  isolated = true;
  for (const p of profiles) {
    if (!existsSync(p)) continue;
    const aside = `${p}.before-${runId}`;
    renameSync(p, aside);
    asideProfiles.push([p, aside]);
  }
  return { profiles, setAside: asideProfiles.map(([, a]) => a) };
}
function restoreProfile() {
  if (!isolated) return;
  isolated = false;
  const nativeLog = join(profiles[0] ?? '', 'logs', 'native.log');
  if (existsSync(nativeLog)) try { cpSync(nativeLog, join(out, 'host', 'native.log')); } catch { /* best effort */ }
  // The run's own profile (created by this run) goes, so the previous one can come back.
  for (const p of profiles) if (existsSync(p)) {
    try { rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch (e) { log(`profile ${p} not removed: ${e.message}`); }
  }
  for (const [p, aside] of asideProfiles.splice(0)) {
    try { if (!existsSync(p)) renameSync(aside, p); } catch (e) { log(`previous profile left at ${aside}: ${e.message}`); }
  }
}

// ---- host firewall --------------------------------------------------------------------------------------------------
/** The host firewall as it applies to this run: active profiles, the profile of the interface facing the sandbox, the
 *  rules for the exact executables, and inbound block rules for app or node programs ("Query User" answers). */
async function hostFirewall(sandboxAddress) {
  const programs = { app: hostAppPath, server: nodePath };
  if (scenarios.includes('mixed')) programs.browser = await chromiumPath();
  const v = psJson(`
    $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object { [pscustomobject]@{ name = "$($_.Name)"; enabled = [bool]($_.Enabled -eq 'True' -or $_.Enabled -eq 1 -or $_.Enabled -eq $true); inbound = "$($_.DefaultInboundAction)"; allowInboundRules = "$($_.AllowInboundRules)" } })
    $ifs = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -like 'vEthernet*' } | ForEach-Object { $cp = Get-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue; [pscustomobject]@{ alias = $_.InterfaceAlias; ip = $_.IPAddress; prefix = $_.PrefixLength; category = $(if ($cp) { "$($cp.NetworkCategory)" } else { $null }) } })
    $want = @(${Object.values(programs).filter(Boolean).map(psq).join(', ')})
    $rules = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore | Where-Object { $want -contains $_.Program -or ($_.Program -like '*\\hivetex-desktop.exe') -or ($_.Program -like '*\\node.exe') } | ForEach-Object {
      $f = $_; Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $f -PolicyStore ActiveStore | ForEach-Object { [pscustomobject]@{ name = $_.DisplayName; program = $f.Program; enabled = "$($_.Enabled)" -eq 'True'; direction = "$($_.Direction)"; action = "$($_.Action)"; profile = "$($_.Profile)" } } })
    [pscustomobject]@{ profiles = $profiles; interfaces = $ifs; rules = $rules } | ConvertTo-Json -Depth 4 -Compress`);
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const fw = { programs, profiles: arr(v.profiles), interfaces: arr(v.interfaces), rules: arr(v.rules) };
  // The interface facing the sandbox: the one whose subnet holds the sandbox address, else the Default Switch.
  const inSubnet = (ip, net, prefix) => { const n = (a) => a.split('.').reduce((x, o) => (x << 8) + Number(o), 0) >>> 0; const m = prefix ? (~0 << (32 - prefix)) >>> 0 : 0; return (n(ip) & m) === (n(net) & m); };
  const facing = (sandboxAddress && fw.interfaces.find((i) => inSubnet(sandboxAddress, i.ip, i.prefix))) || fw.interfaces.find((i) => i.alias === 'vEthernet (Default Switch)') || null;
  // An interface without a network profile (Hyper-V's switches) gets the Public firewall profile.
  const profileName = facing?.category === 'DomainAuthenticated' ? 'Domain' : facing?.category === 'Private' ? 'Private' : 'Public';
  const profile = fw.profiles.find((p) => p.name === profileName);
  const enabled = process.env.HOST_FIREWALL_ASSUME_ENABLED === '1' || Boolean(profile?.enabled);
  const applies = (r) => r.enabled && r.direction === 'Inbound' && (r.profile === 'Any' || r.profile.split(/,\s*/).includes(profileName));
  const exact = (p) => (r) => p && r.program.toLowerCase() === p.toLowerCase();
  const missing = Object.entries(programs).filter(([, p]) => p && !fw.rules.some((r) => exact(p)(r) && applies(r) && r.action === 'Allow')).map(([k, p]) => `${k} ${p}`);
  const blocking = fw.rules.filter((r) => applies(r) && r.action === 'Block' && Object.values(programs).some((p) => exact(p)(r)));
  Object.assign(fw, { facing, facingProfile: profileName, facingProfileEnabled: enabled, assumed: process.env.HOST_FIREWALL_ASSUME_ENABLED === '1', missingAllow: enabled ? missing : [], blocking: enabled ? blocking : [] });
  fw.verdict = !enabled ? `profile ${profileName} facing the sandbox is disabled` : missing.length || blocking.length ? 'could block' : `profile ${profileName} enabled, exact allow rules present`;
  return fw;
}
function firewallStop(fw) {
  if (fw.missingAllow.length === 0 && fw.blocking.length === 0) return;
  throw new Stop(`firewall: the host profile ${fw.facingProfile} (interface ${fw.facing?.alias ?? 'facing the sandbox'})${fw.assumed ? ' (assumed enabled)' : ''} is enabled and `
    + [fw.missingAllow.length ? `has no inbound allow rule for ${fw.missingAllow.join('; ')}` : '', fw.blocking.length ? `blocks ${fw.blocking.map((r) => `${r.program} (rule "${r.name}")`).join('; ')}` : ''].filter(Boolean).join(' and ')
    + `. Allow them from an elevated shell: make sandbox-firewall (same SANDBOX_OUT/E2E_TARGET_DIR), or answer the firewall prompt for these programs. No sync step was run.`);
}

// ---- sandbox scripts -------------------------------------------------------------------------------------------------
function stageScripts() {
  const W = (name, lines) => writeFileSync(join(share, name), lines.join('\r\n'));
  // Fail-fast, as System. The firewall state is verified and written to setup.json / setup.txt before anything else.
  W('setup.ps1', [
    '$ErrorActionPreference = "Stop"',
    `$fault = ${psq(FAULT)}`,
    'function N { param([string]$exe, [string[]]$a) & $exe @a | Out-Null; if ($LASTEXITCODE -ne 0) { throw "$exe $($a -join \' \') failed ($LASTEXITCODE)" } }',
    '$state = [ordered]@{ fault = $fault; ok = $false }',
    'try {',
    '  $gw = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4DefaultGateway.NextHop',
    '  if (-not $gw) { throw "no default gateway" }',
    '  $state.gateway = $gw',
    '  Start-Service iphlpsvc',
    // WebView2 ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS in the sandbox; its policy key is honoured.
    `  N reg @('add', 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\AdditionalBrowserArguments', '/v', 'hivetex-desktop.exe', '/t', 'REG_SZ', '/d', '--remote-debugging-port=${SB_CDP}', '/f')`,
    "  N netsh @('interface', 'portproxy', 'add', 'v4tov4', 'listenaddress=127.0.0.1', 'listenport=3000', \"connectaddress=$gw\", 'connectport=3000')",
    `  N netsh @('interface', 'portproxy', 'add', 'v4tov4', 'listenaddress=0.0.0.0', 'listenport=${SB_CDP_PUBLIC}', 'connectaddress=127.0.0.1', 'connectport=${SB_CDP}')`,
    `  New-NetFirewallRule -DisplayName hivetex-cdp -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${SB_CDP_PUBLIC} | Out-Null`,
    `  New-NetFirewallRule -DisplayName hivetex-echo -Direction Inbound -Action Allow -Protocol UDP -LocalPort ${ECHO_SB} | Out-Null`,
    '  New-NetFirewallRule -DisplayName hivetex-app -Direction Inbound -Action Allow -Program C:\\hx-app\\hivetex-desktop.exe | Out-Null',
    '  Copy-Item -Recurse -Force C:\\hx-share\\app C:\\hx-app',
    '  New-Item -ItemType Directory -Force C:\\hx-folder | Out-Null',
    '  if ($fault -eq "no-udp") {',
    // No UDP for the app (no STUN, no TURN over UDP, no direct path), as on a network that blocks UDP.
    '    Set-NetFirewallProfile -All -Enabled True',
    '    New-NetFirewallRule -DisplayName hivetex-no-udp -Direction Outbound -Action Block -Protocol UDP -Program C:\\hx-app\\hivetex-desktop.exe | Out-Null',
    '    $off = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { -not $_.Enabled })',
    '    if ($off.Count) { throw "FAULT=no-udp: profiles still disabled: $($off.Name -join \', \')" }',
    '    $rule = Get-NetFirewallRule -DisplayName hivetex-no-udp -PolicyStore ActiveStore',
    '    if ("$($rule.Enabled)" -ne "True" -or "$($rule.Action)" -ne "Block") { throw "FAULT=no-udp: block rule not in effect" }',
    '  } else {',
    '    Set-NetFirewallProfile -All -Enabled False',
    '    $on = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { $_.Enabled })',
    '    if ($on.Count) { throw "sandbox firewall still enabled: $($on.Name -join \', \')" }',
    '  }',
    '  $state.ok = $true',
    '} catch { $state.error = "$_" }',
    '$state.profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object { [ordered]@{ name = "$($_.Name)"; enabled = [bool]$_.Enabled; inbound = "$($_.DefaultInboundAction)"; outbound = "$($_.DefaultOutboundAction)" } })',
    '$state.rules = @(Get-NetFirewallRule -DisplayName "hivetex*" -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ name = $_.DisplayName; enabled = "$($_.Enabled)"; direction = "$($_.Direction)"; action = "$($_.Action)" } })',
    '$state | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 C:\\hx-logs\\setup.json',
    '"setup ok=$($state.ok) fault=$fault gateway=$($state.gateway) error=$($state.error)" | Out-File -Encoding utf8 C:\\hx-logs\\setup.txt',
    'Get-NetFirewallProfile -PolicyStore ActiveStore | Format-Table Name, Enabled, DefaultInboundAction, DefaultOutboundAction | Out-File -Append -Encoding utf8 C:\\hx-logs\\setup.txt',
    'Get-NetFirewallRule -DisplayName "hivetex*" -ErrorAction SilentlyContinue | Format-Table DisplayName, Enabled, Direction, Action | Out-File -Append -Encoding utf8 C:\\hx-logs\\setup.txt',
    'netsh interface portproxy show all | Out-File -Append -Encoding utf8 C:\\hx-logs\\setup.txt',
    'ipconfig /all | Out-File -Append -Encoding utf8 C:\\hx-logs\\setup.txt',
    'if (-not $state.ok) { exit 1 }',
  ]);
  // Reachability from inside: TCP to the host server, UDP echo to the host with the app's own node.exe, and an echo
  // listener for the host's probe.
  W('reach.ps1', [
    'param([string]$Gw)',
    '$ErrorActionPreference = "Stop"',
    `Start-Process -FilePath C:\\hx-app\\node\\node.exe -ArgumentList 'C:\\hx-share\\echo.mjs', 'server', '${ECHO_SB}', '60' -WindowStyle Hidden`,
    '$t = Test-NetConnection -ComputerName $Gw -Port 3000 -WarningAction SilentlyContinue',
    `& C:\\hx-app\\node\\node.exe C:\\hx-share\\echo.mjs client $Gw ${ECHO_HOST} C:\\hx-logs\\reach-udp.json`,
    '[ordered]@{ tcp = [bool]$t.TcpTestSucceeded; gateway = $Gw } | ConvertTo-Json | Out-File -Encoding utf8 C:\\hx-logs\\reach-tcp.json',
  ]);
  writeFileSync(join(share, 'echo.mjs'), [
    "import dgram from 'node:dgram';",
    "import { writeFileSync } from 'node:fs';",
    'const [mode, a, b, c] = process.argv.slice(2);',
    "const s = dgram.createSocket('udp4');",
    "if (mode === 'server') {",
    "  s.on('message', (m, r) => s.send(m, r.port, r.address));",
    "  s.bind(Number(a), '0.0.0.0');",
    '  setTimeout(() => process.exit(0), Number(b ?? 60) * 1000);',
    '} else {',
    '  const t0 = Date.now();',
    "  const done = (v) => { writeFileSync(c, JSON.stringify(v)); process.exit(0); };",
    "  s.on('message', () => done({ ok: true, ms: Date.now() - t0 }));",
    "  const timer = setInterval(() => s.send(Buffer.from('hx-echo'), Number(b), a), 300);",
    "  setTimeout(() => { clearInterval(timer); done({ ok: false, error: 'no echo within 6 s' }); }, 6000);",
    '}',
  ].join('\n'));
  // A process of its own: one started from the exec'd console dies with it.
  W('launch.ps1', ['Start-Process -FilePath C:\\hx-app\\hivetex-desktop.exe -ArgumentList "--ignore-system-tex", "--test-pick-dir", "C:\\hx-folder" -RedirectStandardError C:\\hx-logs\\app-stderr.txt -RedirectStandardOutput C:\\hx-logs\\app-stdout.txt']);
  W('kill.cmd', ['@echo off', 'taskkill /F /T /IM hivetex-desktop.exe']);
  // FAULT=offline: new connections out of the sandbox are blocked (DevTools stays reachable: inbound rule, loopback proxy).
  W('net-offline.ps1', [
    'param([string]$Gw)',
    '$ErrorActionPreference = "Stop"',
    'Set-NetFirewallProfile -All -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Block',
    // The sandbox image allows all outbound traffic by rule ("Container: allow outbound"): only block rules win over it.
    // Loopback stays open for the DevTools proxy; connections the host opens (DevTools) are inbound and stay allowed.
    "New-NetFirewallRule -DisplayName hivetex-offline -Direction Outbound -Action Block -RemoteAddress '0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255' | Out-Null",
    "New-NetFirewallRule -DisplayName hivetex-offline6 -Direction Outbound -Action Block -RemoteAddress '::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' | Out-Null",
    '$t = Test-NetConnection -ComputerName $Gw -Port 3000 -WarningAction SilentlyContinue',
    '[ordered]@{ enabled = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { $_.Enabled }).Count; hostReachable = [bool]$t.TcpTestSucceeded } | ConvertTo-Json | Out-File -Encoding utf8 C:\\hx-logs\\offline.json',
  ]);
  W('net-online.ps1', [
    '$ErrorActionPreference = "Stop"',
    'Remove-NetFirewallRule -DisplayName hivetex-offline, hivetex-offline6 -ErrorAction SilentlyContinue',
    'Set-NetFirewallProfile -All -Enabled False -DefaultOutboundAction Allow',
    '[ordered]@{ enabled = @(Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { $_.Enabled }).Count } | ConvertTo-Json | Out-File -Encoding utf8 C:\\hx-logs\\online.json',
  ]);
  W('folder-hashes.ps1', [
    '$ErrorActionPreference = "Stop"',
    '$root = "C:\\hx-folder"',
    '@(Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.FullName.Substring($root.Length + 1) -notmatch "^\\.hivetex" } | ForEach-Object { [ordered]@{ path = $_.FullName.Substring($root.Length + 1).Replace("\\", "/"); sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower() } }) | ConvertTo-Json -Depth 3 | Out-File -Encoding utf8 C:\\hx-logs\\folder-hashes.json',
  ]);
  W('collect.cmd', [
    '@echo off',
    `copy /y "C:\\Users\\WDAGUtilityAccount\\AppData\\Roaming\\${identifier}\\logs\\native.log" C:\\hx-logs\\native.log`,
    'netstat -ano -p udp > C:\\hx-logs\\netstat-udp.txt',
    'powershell -NoProfile -Command "Get-NetFirewallProfile -PolicyStore ActiveStore | Format-Table Name, Enabled, DefaultOutboundAction" > C:\\hx-logs\\firewall-end.txt',
  ]);
}

// ---- page helpers ------------------------------------------------------------------------------------------------------
/** An app that stops answering (a pending dialog, a stalled VM) fails the step in seconds instead of hanging it. */
const CALL_MS = 20_000;
const bounded = (side, what, p, ms = CALL_MS) => Promise.race([p, pause(ms).then(() => { throw new Error(`the ${side.label} app did not answer within ${ms / 1000} s (${what}): a dialog waiting for an answer, or the app stalled`); })]);
const ev = (side, what, fn, arg, ms) => bounded(side, what, side.page.evaluate(fn, arg).catch((e) => { throw new Error(`${side.label} (${what}): ${e instanceof Error ? e.message : e}`); }), ms);
const create = (side, path, text) => ev(side, 'create', async ([p, t]) => {
  const s = window.__p2p.session;
  const id = await s.model.createTextNow(p, t);
  await s.model.flush();
  return id;
}, [path, text]);
const append = (side, id, text) => ev(side, 'edit', async ([f, t]) => {
  const s = window.__p2p.session;
  const y = await s.model.openText(f);
  y.insert(y.length, t);
  await s.model.flush();
}, [id, text]);
const textOf = (side, id) => ev(side, 'read', async (f) => {
  const s = window.__p2p?.session;
  if (!s?.model.files.has(f)) return null;
  return (await s.model.openText(f)).toString();
}, id);
/** Text of a file that may have been deleted: the live file, else its document as kept for Recovery. */
const textAnywhere = (side, id) => ev(side, 'read', async (f) => {
  const s = window.__p2p?.session;
  if (!s) return null;
  const live = s.model.files.has(f);
  const kept = live ? null : (await s.model.recoveryFiles()).find((r) => r.id === f);
  if (!live && !kept) return null;
  return { live, recovery: kept ? { path: kept.path, conflict: Boolean(kept.conflict), orphan: Boolean(kept.orphan) } : null, text: (await s.model.openText(f)).toString() };
}, id);
const peers = (side) => ev(side, 'peers', () => (window.__p2p?.session?.peers ?? []).map((p) => ({ dev: p.dev, uname: p.uname, route: p.route, role: p.role, limited: p.limited })));
/** Every live entry with a content hash (sha256 of the text, of the asset bytes): the tree compared across machines. */
const tree = (side) => ev(side, 'tree', async () => {
  const s = window.__p2p.session;
  const hex = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const rows = [];
  for (const f of s.model.list()) {
    const row = { id: f.id, path: f.path, kind: f.kind };
    if (f.kind === 'text') row.sha256 = await hex(new TextEncoder().encode((await s.model.openText(f.id)).toString()));
    if (f.kind === 'binary') { row.hash = f.hash; row.sha256 = (await s.blobs.has(f.hash)) ? await hex(await s.blobs.get(f.hash)) : null; }
    rows.push(row);
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}, undefined, 60_000);
const recoveryList = (side) => ev(side, 'recovery list', async () => (await window.__p2p.session.model.recoveryFiles()).map((r) => ({ id: r.id, path: r.path, conflict: Boolean(r.conflict), orphan: Boolean(r.orphan), deletionId: r.deletionId ?? null })));
const SYNC_MS = Number(process.env.SYNC_TIMEOUT_MS ?? 90_000);
const sides = () => [host, sb, ...(browserSide ? [browserSide] : [])];
async function sameTrees(what, list = sides()) {
  let last = [];
  try {
    return await until(async () => {
      last = await Promise.all(list.map(tree));
      const j = last.map((t) => JSON.stringify(t));
      return j.every((x) => x === j[0]) && last[0].every((r) => r.kind !== 'binary' || r.sha256 === r.hash) ? last[0] : null;
    }, what, SYNC_MS, 1000);
  } catch (e) {
    throw new Error(`${e.message}\n${list.map((s, i) => `${s.label}: ${JSON.stringify(last[i])}`).join('\n')}`);
  }
}

// ---- sabotage (SABOTAGE=1): discard text and binary files received from the other side, so every scenario must fail ------------------
const sabotage = (side) => side.page.evaluate(() => {
  const s = window.__p2p.session;
  if (s.__sabotaged) return;
  s.__sabotaged = true;
  const hook = (t) => {
    if (t.__sabotaged) return;
    t.__sabotaged = true;
    t.observe((event, tr) => {
      if (tr.local) return;
      const cut = [];
      let i = 0;
      for (const d of event.delta) { if (d.retain) i += d.retain; else if (d.insert) { cut.push([i, d.insert.length]); i += d.insert.length; } }
      if (cut.length) setTimeout(() => t.doc.transact(() => { for (const [p, n] of cut.reverse()) t.delete(p, n); }));
    });
  };
  // Binary files created by the other side are removed again as they arrive (a lost creation, for `assets`).
  s.model.files.observe((event, tr) => {
    if (tr.local) return;
    const added = [...event.keys].filter(([id, c]) => c.action === 'add' && s.model.files.get(id)?.get?.('kind') === 'binary').map(([id]) => id);
    if (added.length) setTimeout(() => { for (const id of added) if (s.model.files.has(id)) s.model.delete(id); });
  });
  const open = s.model.openText.bind(s.model);
  s.model.openText = async (id) => { const t = await open(id); hook(t); return t; };
  for (const f of s.model.list()) if (f.kind === 'text') void s.model.openText(f.id);
});

// ---- ZIP (recovery exports): stored and deflated entries, central directory ----------------------------------------
function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a ZIP (no end of central directory)');
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const files = new Map();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const data = buf.subarray(off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28) + csize);
    files.set(name, method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null);
    p += 46 + nlen + xlen + clen;
  }
  return files;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** The document subject of a PDF (hyperref `pdfsubject`), in the clear or in a Flate object stream, decoded. */
function pdfSubject(pdf) {
  const raw = pdf.toString('latin1');
  const texts = [raw];
  for (let at = raw.indexOf('stream'); at >= 0; at = raw.indexOf('stream', at + 6)) {
    let start = at + 6;
    if (raw[start] === '\r') start++;
    if (raw[start] === '\n') start++;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try { texts.push(inflateSync(pdf.subarray(start, end)).toString('latin1')); } catch { /* not Flate */ }
    at = end;
  }
  for (const t of texts) {
    const at = t.indexOf('/Subject');
    if (at < 0) continue;
    let i = at + 8;
    while (t[i] === ' ') i++;
    let bytes = '';
    if (t[i] === '<') bytes = Buffer.from(t.slice(i + 1, t.indexOf('>', i)).replace(/\s/g, ''), 'hex').toString('latin1');
    else if (t[i] === '(') {
      for (let depth = 1, j = i + 1; j < t.length && depth; j++) {
        const c = t[j];
        if (c === '\\') {
          const oct = /^[0-7]{1,3}/.exec(t.slice(j + 1, j + 4));
          if (oct) { bytes += String.fromCharCode(Number.parseInt(oct[0], 8)); j += oct[0].length; }
          else { const e = t[++j]; bytes += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[e] ?? e; }
        } else if (c === '(') { depth++; bytes += c; }
        else if (c === ')') { if (--depth) bytes += c; }
        else bytes += c;
      }
    }
    if (bytes.startsWith('\xfe\xff')) return Buffer.from(bytes.slice(2), 'latin1').swap16().toString('utf16le');
    return bytes;
  }
  return null;
}
/** Whether a PDF was built from a document whose `pdfsubject` is `text`. */
const pdfHas = (pdf, text) => pdfSubject(pdf) === text;

// ---- launch / attach ---------------------------------------------------------------------------------------------------
async function attach(url, label) {
  const { chromium } = await import('@playwright/test');
  await until(() => fetch(`${url}/json/version`).then((r) => r.ok).catch(() => false), `${label} DevTools endpoint`, 120_000, 1000);
  const browser = await chromium.connectOverCDP(url);
  const page = await until(() => browser.contexts().flatMap((c) => c.pages()).find((p) => !p.isClosed() && !p.url().startsWith('devtools')), `${label} page`);
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__ && !!document.getElementById('app'), null, { timeout: 60_000 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLines[label].push(`${new Date().toISOString()} ${m.type()} ${m.text()}`); });
  return { browser, page, label };
}
const launchSandboxApp = () => sbPs('launch.ps1');
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
  await register(page, username);
}
async function register(page, username) {
  await page.getByLabel('Repeat password').waitFor();
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Email').fill(`${username}@example.com`);
  await page.locator('#reg-pw').fill(PW);
  await page.locator('#reg-pw2').fill(PW);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Your projects' }).waitFor({ timeout: 60_000 });
}
async function joinProject(page) {
  await page.getByTestId('join-btn').click();
  await page.locator('form:has(h2:text("Join a project")) input[type=text]').fill(slug);
  await page.locator('form:has(h2:text("Join a project")) input[type=password]').fill(PROJECT_PW);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByTestId('workspace').waitFor({ timeout: 60_000 });
}
const deviceOf = (side) => ev(side, 'device', () => window.__p2p.session.myDeviceId ?? window.__p2p.session.runtime?.deviceId);

// ---- scenarios ---------------------------------------------------------------------------------------------------------
const tag = Date.now().toString(36);
const userA = `hostA${tag}`;
const userB = `sbB${tag}`;
const userC = `webC${tag}`;
let slug;
let projectId;
let mainId;
const scenario = (name, fn) => tryStep(`scenario ${name}`, async () => {
  summary.scenarios ??= {};
  const t0 = Date.now();
  try {
    const value = await fn();
    summary.scenarios[name] = { ok: true, ms: Date.now() - t0 };
    return value;
  } catch (e) {
    summary.scenarios[name] = { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
    throw e;
  }
});
const hasMarker = (side, id, marker) => textOf(side, id).then((t) => Boolean(t?.includes(marker)));
const arrives = (side, id, marker, what) => until(() => hasMarker(side, id, marker), what, SYNC_MS);

const SCENARIOS = {
  // Binary assets: bytes hashed on both sides and the whole tree (id, path, kind, hash) compared.
  async assets() {
    const add = (side, path, size, seed) => ev(side, 'add asset', async ([p, n, k]) => {
      const s = window.__p2p.session;
      const bytes = new Uint8Array(n).map((_, i) => (i * 131 + k * 7 + (i >> 9)) % 251);
      const hash = await s.blobs.add(bytes);
      const id = s.model.createBinary(p, hash, bytes.length);
      await s.model.flush();
      return { id, hash };
    }, [path, size, seed], 60_000);
    const a = await add(host, `img/host-${tag}.bin`, 3 * 1024 * 1024 + 11, 1);
    const b = await add(sb, `img/sandbox-${tag}.bin`, 200_000, 2);
    const t = await sameTrees('identical trees and asset bytes on both sides');
    for (const x of [a, b]) if (!t.some((r) => r.id === x.id && r.sha256 === x.hash)) throw new Error(`asset ${x.id} missing or with other bytes: ${JSON.stringify(t)}`);
    return { files: t.length, assets: t.filter((r) => r.kind === 'binary').length };
  },
  // Concurrent rename vs delete and edit vs delete: trees converge and no content is lost on either side.
  async 'rename-delete'() {
    const r = await create(host, `rd-rename-${tag}.tex`, `rename me ${tag}\n`);
    const d = await create(host, `rd-edit-${tag}.tex`, `edit vs delete ${tag}\n`);
    const k = await create(host, `rd-keep-${tag}.tex`, `kept ${tag}\n`);
    await Promise.all([arrives(sb, r, `rename me ${tag}`, 'rename target on the sandbox'), arrives(sb, d, `edit vs delete ${tag}`, 'edit target on the sandbox')]);
    await Promise.all([
      ev(host, 'rename+edit', async ([a, b, c, t]) => {
        const s = window.__p2p.session;
        s.model.rename(a, `rd-renamed-${t}.tex`);
        const y = await s.model.openText(b); y.insert(y.length, `host edit after ${t}\n`);
        s.model.rename(c, `rd-kept-renamed-${t}.tex`);
        await s.model.flush();
      }, [r, d, k, tag]),
      ev(sb, 'delete both', async ([a, b]) => {
        const s = window.__p2p.session;
        s.model.delete(a); s.model.delete(b);
        await s.model.flush();
      }, [r, d]),
    ]);
    const t = await sameTrees('identical trees after concurrent rename/delete and edit/delete');
    if (!t.some((x) => x.id === k && x.path === `rd-kept-renamed-${tag}.tex`)) throw new Error('an uncontested rename was lost');
    // Each contested file is live or kept for Recovery on both sides, with every edit it received.
    for (const [id, marker] of [[r, `rename me ${tag}`], [d, `host edit after ${tag}`]]) {
      const got = await until(async () => {
        const v = await Promise.all([textAnywhere(host, id), textAnywhere(sb, id)]);
        return v.every((x) => x?.text.includes(marker)) && v[0].live === v[1].live ? v : null;
      }, `content of ${id} kept (live or in Recovery) on both sides`, SYNC_MS, 1000);
      summary.renameDelete ??= {};
      summary.renameDelete[id] = got.map((x) => ({ live: x.live, recovery: x.recovery }));
    }
    return { files: t.length, outcome: summary.renameDelete };
  },
  // Both sides offline (app offline mode, or FAULT=offline: the sandbox's firewall), each edits and deletes, then back.
  async offline() {
    // Three lines, edited offline in different places (the sandbox above the first, the host below the last): the merge
    // must apply on its own. Edits to the same lines would wait in Resolve conflicts by design (docs/offline.md).
    const shared = await create(host, `off-shared-${tag}.tex`, `shared ${tag}\nmiddle ${tag}\nend ${tag}\n`);
    const goneA = await create(host, `off-gone-host-${tag}.tex`, `deleted on the host ${tag}\n`);
    const goneB = await create(host, `off-gone-sb-${tag}.tex`, `deleted in the sandbox ${tag}\n`);
    await Promise.all([shared, goneA, goneB].map((id) => until(() => textOf(sb, id), `${id} on the sandbox`, SYNC_MS)));
    const setPaused = (side, p) => ev(side, 'offline mode', (v) => window.__p2p.session.setPaused(v), p);
    await setPaused(host, true);
    if (FAULT === 'offline') {
      sbPs('net-offline.ps1', `-Gw ${gateway}`, 'System');
      const o = readSb('offline.json');
      summary.offlineFault = o;
      if (!o || o.enabled < 3 || o.hostReachable) throw new Error(`FAULT=offline not in effect: ${JSON.stringify(o)}`);
    } else await setPaused(sb, true);
    await until(async () => (await peers(host)).length === 0 && (await peers(sb)).length === 0, 'both sides without peers while offline', 60_000, 1000).catch((e) => {
      throw new Error(FAULT === 'offline' ? `FAULT=offline not in effect (the link survived): ${e.message}` : e.message);
    });
    await append(host, shared, `offline on the host ${tag}\n`);
    await ev(sb, 'edit at the start', async ([f, t]) => {
      const s = window.__p2p.session;
      (await s.model.openText(f)).insert(0, t);
      await s.model.flush();
    }, [shared, `offline in the sandbox ${tag}\n`]);
    const hostNew = await create(host, `off-new-host-${tag}.tex`, `created offline on the host ${tag}\n`);
    const sbNew = await create(sb, `off-new-sb-${tag}.tex`, `created offline in the sandbox ${tag}\n`);
    await ev(host, 'delete', async (id) => { const s = window.__p2p.session; s.model.delete(id); await s.model.flush(); }, goneA);
    await ev(sb, 'delete', async (id) => { const s = window.__p2p.session; s.model.delete(id); await s.model.flush(); }, goneB);
    await setPaused(host, false);
    if (FAULT === 'offline') { sbPs('net-online.ps1', '', 'System'); if (readSb('online.json')?.enabled !== 0) throw new Error('sandbox firewall did not come back off'); }
    else await setPaused(sb, false);
    const t = await sameTrees('identical trees after both sides were offline');
    for (const id of [hostNew, sbNew]) if (!t.some((x) => x.id === id)) throw new Error(`file created offline ${id} missing`);
    const pendingMerge = (side) => ev(side, 'merge state', () => ({ unshared: window.__p2p.session.unsharedWork, conflicts: window.__p2p.session.conflicts.length }));
    const merged = await until(async () => {
      const [a, b] = await Promise.all([textOf(host, shared), textOf(sb, shared)]);
      return a?.includes(`offline on the host ${tag}`) && a.includes(`offline in the sandbox ${tag}`) && a === b ? a : null;
    }, 'offline edits merged on both sides', SYNC_MS, 1000).catch(async (e) => {
      throw new Error(`${e.message}: host ${JSON.stringify(await textOf(host, shared))} ${JSON.stringify(await pendingMerge(host))}, sandbox ${JSON.stringify(await textOf(sb, shared))} ${JSON.stringify(await pendingMerge(sb))}`);
    });
    const states = await Promise.all([pendingMerge(host), pendingMerge(sb)]);
    if (states.some((s) => s.conflicts)) throw new Error(`edits in different places left conflicts: ${JSON.stringify(states)}`);
    summary.offlineMerge = { length: merged.length, states };
    // Every deleted version is listed in Recovery on both sides.
    const rec = await until(async () => {
      const v = await Promise.all([recoveryList(host), recoveryList(sb)]);
      return v.every((l) => [goneA, goneB].every((id) => l.some((r) => r.id === id))) ? v : null;
    }, 'deleted files listed in Recovery on both sides', SYNC_MS, 1000);
    await authorsOf([[host, shared, userA], [sb, shared, userB], [host, sbNew, userB], [sb, hostNew, userA]]);
    return { files: t.length, recovery: rec.map((l) => l.length), fault: FAULT === 'offline' ? 'firewall' : 'app offline mode' };
  },
  // The sandbox app is killed during a burst of edits; every edit acknowledged before the kill survives on both sides.
  async crash() {
    const id = await create(sb, `crash-${tag}.tex`, `crash test ${tag}\n`);
    await until(() => textOf(host, id), 'crash file on the host', SYNC_MS);
    await ev(sb, 'burst', ([f, t]) => {
      const s = window.__p2p.session;
      window.__burst = { acked: -1, error: null };
      void (async () => {
        try {
          const y = await s.model.openText(f);
          for (let i = 0; i < 2000; i++) { y.insert(y.length, `burst ${i} ${t}\n`); await s.model.flush(); window.__burst.acked = i; }
        } catch (e) { window.__burst.error = String(e); }
      })();
    }, [id, tag]);
    const acked = await until(async () => { const b = await ev(sb, 'burst state', () => window.__burst); return b.acked >= 30 ? b.acked : null; }, 'burst under way', 60_000, 100);
    sbExec('C:\\hx-share\\kill.cmd', 'System', { allowFail: true });
    const killedAt = Date.now();
    await sb.browser.close().catch(() => {});
    await until(() => run('wsb', ['exec', '--id', sandboxId, '-c', 'C:\\Windows\\System32\\tasklist.exe /FI "IMAGENAME eq hivetex-desktop.exe" /NH', '-r', 'System'], { allowFail: true }).stdout?.includes('No tasks') ?? false, 'sandbox app gone', 30_000, 1000).catch(() => {});
    launchSandboxApp();
    sb = await attach(`http://${sandboxIp}:${SB_CDP_PUBLIC}`, 'sandbox');
    await sb.page.evaluate((p) => { location.hash = `#/p/${p}`; }, projectId);
    await sb.page.getByTestId('workspace').waitFor({ timeout: 90_000 });
    if (process.env.SABOTAGE === '1') await sabotage(sb);
    const want = Array.from({ length: acked + 1 }, (_, i) => `burst ${i} ${tag}\n`);
    const missing = async (side) => { const t = (await textOf(side, id)) ?? ''; return want.filter((m) => !t.includes(m)).length; };
    const res = await until(async () => { const m = await Promise.all([missing(sb), missing(host)]); return m.every((x) => x === 0) ? m : null; }, `all ${acked + 1} acknowledged edits after the restart on both sides`, SYNC_MS, 1000)
      .catch(async (e) => { throw new Error(`${e.message}; missing sandbox=${await missing(sb)} host=${await missing(host)}`); });
    return { acknowledged: acked + 1, restartMs: Date.now() - killedAt, missing: res };
  },
  // Author and device of each change on both sides.
  async author() {
    const a = await create(host, `author-host-${tag}.tex`, `by the host ${tag}\n`);
    await until(() => textOf(sb, a), 'host file on the sandbox', SYNC_MS);
    await append(sb, a, `by the sandbox ${tag}\n`);
    await arrives(host, a, `by the sandbox ${tag}`, 'sandbox edit on the host');
    return authorsOf([[host, a, userA], [sb, a, userA], [host, a, userB], [sb, a, userB]]);
  },
  // A full recovery export from each side: the ZIP opens, every live file is in it with its bytes, the manifest verifies.
  async recovery() {
    const marker = `recovery ${tag}`;
    const id = await create(sb, `recovery-${tag}.tex`, `${marker}\n`);
    await arrives(host, id, marker, 'recovery file on the host');
    const t = await sameTrees('identical trees before the export');
    const result = {};
    for (const side of [host, sb]) {
      const b64 = await ev(side, 'export', async () => {
        const r = await window.__p2p.session.exportRecovery();
        const zip = r?.zip ?? r;
        if (!(zip instanceof Uint8Array)) throw new Error(`exportRecovery returned ${Object.prototype.toString.call(zip)}`);
        let s = '';
        for (let i = 0; i < zip.length; i += 0x8000) s += String.fromCharCode(...zip.subarray(i, i + 0x8000));
        return { zip: btoa(s), missing: r?.missing ?? [] };
      }, undefined, 180_000);
      const buf = Buffer.from(b64.zip, 'base64');
      writeFileSync(join(side === host ? join(out, 'host') : sbLogs, 'recovery.zip'), buf);
      const files = unzip(buf);
      for (const f of t) if (f.sha256 && sha(files.get(f.path) ?? '') !== f.sha256) throw new Error(`${side.label} export: ${f.path} missing or different`);
      const mname = [...files.keys()].find((n) => /^\.hivetex-archive(-\d+)?\/manifest\.json$/.test(n));
      if (!mname) throw new Error(`${side.label} export has no manifest`);
      const manifest = JSON.parse(files.get(mname).toString('utf8'));
      if (manifest.format !== 'hivetex-full-recovery') throw new Error(`${side.label} manifest format ${manifest.format}`);
      const bad = manifest.entries.filter((e) => !files.has(e.file) || sha(files.get(e.file)) !== e.sha256);
      if (bad.length) throw new Error(`${side.label} manifest: ${bad.length} entries missing or altered (${bad.slice(0, 3).map((e) => e.file).join(', ')})`);
      // A healthy store exports completely: anything reported unreadable (the native store archive included) is a failure.
      if (b64.missing.length || manifest.missing?.length) throw new Error(`${side.label} export incomplete: ${JSON.stringify(b64.missing.length ? b64.missing : manifest.missing)}`);
      if (side === host || side === sb) if (!manifest.entries.some((e) => e.kind === 'native-store')) throw new Error(`${side.label} export has no native store archive`);
      result[side.label] = { bytes: buf.length, files: files.size, manifestEntries: manifest.entries.length, missing: b64.missing };
    }
    return result;
  },
  // A project bound to a folder on each machine (test picker): an outside write on the host reaches the sandbox folder,
  // a sandbox edit reaches the host folder; both folders hold the same bytes.
  async folder() {
    const hostDir = join(out, 'host', 'folder');
    mkdirSync(hostDir, { recursive: true });
    const bind = (side) => ev(side, 'bind folder', async () => {
      const dir = await window.__TAURI_INTERNALS__.invoke('mirror_pick', { title: 'test' });
      await window.__p2p.session.bindFolder({ desktopPath: dir });
      return dir;
    }, undefined, 60_000);
    summary.folders = { host: await bind(host), sandbox: await bind(sb) };
    const outside = `folder-host-${tag}.tex`;
    writeFileSync(join(hostDir, outside), `written outside the app on the host ${tag}\n`);
    const fid = await until(() => ev(sb, 'find', (p) => window.__p2p.session.model.find(p)?.id ?? null, outside), 'outside write in the sandbox model', SYNC_MS, 1000);
    await arrives(sb, fid, `written outside the app on the host ${tag}`, 'outside write content in the sandbox');
    await append(sb, fid, `edited in the sandbox editor ${tag}\n`);
    await until(() => existsSync(join(hostDir, outside)) && readFileSync(join(hostDir, outside), 'utf8').includes(`edited in the sandbox editor ${tag}`), 'sandbox edit in the host folder', SYNC_MS, 1000);
    const hostHashes = () => {
      const rows = [];
      const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); const rel = relative(hostDir, p).replaceAll('\\', '/'); if (rel.startsWith('.hivetex')) continue; if (e.isDirectory()) walk(p); else rows.push({ path: rel, sha256: sha(readFileSync(p)) }); } };
      walk(hostDir);
      return rows.sort((a, b) => (a.path < b.path ? -1 : 1));
    };
    let last;
    await until(() => {
      sbPs('folder-hashes.ps1');
      const s = readSb('folder-hashes.json');
      const sbRows = (Array.isArray(s) ? s : s ? [s] : []).sort((a, b) => (a.path < b.path ? -1 : 1));
      last = { host: hostHashes(), sandbox: sbRows };
      return JSON.stringify(last.host) === JSON.stringify(last.sandbox);
    }, 'identical folder contents on both machines', SYNC_MS, 3000).catch((e) => { throw new Error(`${e.message}\n${JSON.stringify(last)}`); });
    return { files: last.host.length };
  },
  // Real local builds (audit 8.4): this PC with its own TeX, the sandbox (no TeX) with the managed compiler it sets up
  // itself, then again offline from its package cache. Each side builds on its own; no output reaches the other.
  async compile() {
    const ready = (side) => until(() => ev(side, 'compiler', () => {
      const s = window.__p2p.session;
      return s.engine && s.compilerPhase === 'ready' ? { name: s.compilerName, kind: s.engine.kind } : null;
    }), `${side.label} compiler ready`, 15 * 60_000, 2000);
    const compilers = { host: await ready(host), sandbox: await ready(sb) };
    const doc = (marker, body = '') => `\\documentclass{article}\n\\usepackage{xcolor}\n\\usepackage[pdfsubject={${marker}}]{hyperref}\n\\begin{document}\n\\textcolor{blue}{${marker}}\n${body}\\end{document}\n`;
    const setMain = (side, text) => ev(side, 'set main.tex', async ([f, t]) => {
      const s = window.__p2p.session;
      const y = await s.model.openText(f);
      s.model.getLoadedDoc(`f:${f}`).transact(() => { y.delete(0, y.length); y.insert(0, t); });
      await s.model.flush();
    }, [mainId, text]);
    const build = (side) => ev(side, 'build state', async () => {
      const s = window.__p2p.session;
      const pdf = s.pdf;
      let b64 = null;
      if (pdf) { let x = ''; for (let i = 0; i < pdf.length; i += 0x8000) x += String.fromCharCode(...pdf.subarray(i, i + 0x8000)); b64 = btoa(x); }
      return { status: s.compileStatus, ok: s.result?.ok ?? null, errors: (s.result?.diagnostics ?? []).filter((d) => d.severity === 'error').length, rev: s.pdfRev, pdf: b64 };
    }, undefined, 60_000);
    /** Waits until `side` shows a PDF with `marker` (a build of the current text), returns its bytes. */
    const built = async (side, marker, what) => {
      let last = null;
      return until(async () => {
        last = await build(side);
        const bytes = last.pdf ? Buffer.from(last.pdf, 'base64') : null;
        return last.status === 'ok' && bytes && pdfHas(bytes, marker) ? { bytes, rev: last.rev } : null;
      }, what, 10 * 60_000, 2000).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify({ ...last, pdf: last?.pdf ? `${last.pdf.length} b64 chars` : null })}`); });
    };
// Start a build; it resolves only when done (a first build may fetch packages), so poll with built() instead.
    const start = (side) => ev(side, 'compile', () => { void window.__p2p.session.compileLocal().catch(() => {}); return null; });
    const m1 = `HiveTeX build ${tag}`;
    await setMain(host, doc(m1));
    await arrives(sb, mainId, m1, 'the document in the sandbox');
    for (const side of [host, sb]) await start(side);
    const [a, b] = [await built(host, m1, 'host PDF with the marker'), await built(sb, m1, 'sandbox PDF with the marker')];
    // Outputs stay local: neither side holds the other's PDF, and no output file entered the project.
    const holds = (side, hash) => ev(side, 'blob held', (h) => window.__p2p.session.blobs.has(h), hash);
    const ha = sha(a.bytes), hb = sha(b.bytes);
    if (await holds(sb, ha) || await holds(host, hb)) throw new Error('a PDF built on one side is held by the other');
    const pdfEntries = (await tree(host)).filter((f) => /\.(pdf|log|synctex(\.gz)?)$/.test(f.path));
    if (pdfEntries.length) throw new Error(`build outputs in the project: ${pdfEntries.map((f) => f.path).join(', ')}`);
    // An error is reported and the last good PDF stays.
    await setMain(sb, doc(m1, '\\undefinedcommandfortest\n'));
    const failed = await until(async () => { const s = await build(sb); return s.status === 'error' && s.ok === false ? s : null; }, 'sandbox reports the error', 10 * 60_000, 2000);
    if (!failed.errors) throw new Error(`error build without an error diagnostic: ${JSON.stringify({ ...failed, pdf: null })}`);
    if (failed.rev !== b.rev || !failed.pdf || !pdfHas(Buffer.from(failed.pdf, 'base64'), m1)) throw new Error('the last good PDF was not kept after a failed build');
    // Offline: the sandbox cut off from the host and the Internet builds from its package cache.
    const m2 = `HiveTeX offline ${tag}`;
    sbPs('net-offline.ps1', `-Gw ${gateway}`, 'System');
    const cut = readSb('offline.json');
    let offline;
    try {
      if (!cut || cut.hostReachable) throw new Error(`the sandbox could not be cut off: ${JSON.stringify(cut)}`);
      await setMain(sb, doc(m2));
      await start(sb);
      offline = await built(sb, m2, 'sandbox PDF built offline');
    } finally {
      sbPs('net-online.ps1', '', 'System');
    }
    await arrives(host, mainId, m2, 'the offline edit on the host after reconnecting');
    return { compilers, host: { bytes: a.bytes.length }, sandbox: { bytes: b.bytes.length, offlineBytes: offline.bytes.length }, errorDiagnostics: failed.errors };
  },
  // Chromium on this PC against the desktop app in the sandbox.
  async mixed() {
    const { chromium } = await import('@playwright/test');
    browserApp = await chromium.launch();
    const ctx = await browserApp.newContext({ baseURL: 'http://localhost:1420' });
    await ctx.addInitScript(() => localStorage.setItem('hivetex.test', '1'));
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.browser.push(`${new Date().toISOString()} ${m.type()} ${m.text()}`); });
    await page.goto('/#/register');
    await register(page, userC);
    await joinProject(page);
    browserSide = { browser: browserApp, page, label: 'browser' };
    if (process.env.SABOTAGE === '1') await sabotage(browserSide);
    const id = await create(browserSide, `browser-${tag}.tex`, `written in the browser ${tag}\n`);
    await arrives(sb, id, `written in the browser ${tag}`, 'browser file in the sandbox app');
    await append(sb, id, `sandbox answer ${tag}\n`);
    await arrives(browserSide, id, `sandbox answer ${tag}`, 'sandbox edit in the browser');
    const t = await sameTrees('identical trees in the browser and both apps');
    return { files: t.length, browserPeers: await peers(browserSide) };
  },
};
/** Each [side, file, author]: that side lists a change to the file by that author, with the author's device. */
async function authorsOf(checks) {
  const devices = { [userA]: await deviceOf(host), [userB]: await deviceOf(sb) };
  const out2 = [];
  for (const [side, id, user] of checks) {
    const found = await until(() => ev(side, 'changes', async ([f, u, dev]) => {
      const s = window.__p2p.session;
      const list = await s.changelog.list();
      const mine = s.myDeviceId === dev;
      const hit = list.find((c) => c.files.some((x) => x.fileId === f) && (mine ? ['editor', 'folder'].includes(c.source.kind) : c.source.kind === 'peer' && [c.source.actorName, c.source.name].some((n) => typeof n === 'string' && n.toLowerCase() === u.toLowerCase()) && c.source.device === dev));
      return hit ? { kind: hit.source.kind, name: hit.source.name, actorName: hit.source.actorName, device: hit.source.device, provenance: hit.source.provenance } : null;
    }, [id, user, devices[user]]), `${side.label} lists ${user}'s change to ${id}`, SYNC_MS, 1000).catch(async (e) => {
      const seen = await ev(side, 'changes', async (f) => (await window.__p2p.session.changelog.list()).filter((c) => c.files.some((x) => x.fileId === f)).map((c) => c.source), id).catch(() => null);
      throw new Error(`${e.message}; changes seen: ${JSON.stringify(seen)}`);
    });
    out2.push({ side: side.label, user, ...found });
  }
  return out2;
}

// ---- cleanup and summary -------------------------------------------------------------------------------------------
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (process.env.KEEP) return;
  await browserApp?.close().catch(() => {});
  // Orderly first: app_quit through each app's page, then forced termination.
  const ended = {};
  if (hostApp?.pid) ended.host = await stopApp(hostApp.pid, host ? () => quitThroughPage(host.page) : null, 20_000);
  if (sb && sandboxId) { await quitThroughPage(sb.page).catch(() => {}); await pause(3000); }
  for (const s of [host, sb]) await s?.browser.close().catch(() => {});
  for (const c of children) if (c.pid) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
  if (sandboxId) wsb(['stop', '--id', sandboxId], { allowFail: true });
  restoreProfile();
  summary.ended = ended;
}
function writeSummary() {
  summary.finishedAt = new Date().toISOString();
  summary.result = interrupted ? 'INTERRUPTED' : failed ? 'FAIL' : 'PASS';
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  log(`${summary.result}${summary.diagnosis ? ` — ${summary.diagnosis}` : ''} — results in ${out}`);
}
async function interrupt(signal) {
  if (interrupted) return;
  interrupted = signal;
  failed = true;
  log(`interrupted (${signal}): cleaning up`);
  await collect().catch(() => {});
  await cleanup().catch((e) => log(`cleanup: ${e.message}`));
  writeSummary();
  process.exit(130);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => void interrupt(sig));

const diagnostics = (side) => !side ? Promise.resolve(null) : Promise.race([side.page.evaluate(() => {
  const s = window.__p2p?.session;
  return s ? { status: s.syncStatus, peers: s.peers, files: [...s.model.files.keys()], diagnostics: s.syncDiagnostics() } : null;
}), pause(30_000).then(() => { throw new Error(`the ${side.label} app did not answer within 30 s`); })]).catch((e) => ({ error: String(e) }));
let collected = false;
async function collect() {
  if (collected || !(host || sb)) return;
  collected = true;
  await step('collect diagnostics and logs', async () => {
    const [a, b, c] = await Promise.all([diagnostics(host), diagnostics(sb), diagnostics(browserSide)]);
    writeFileSync(join(out, 'host', 'diagnostics.json'), JSON.stringify(a, null, 2));
    writeFileSync(join(sbLogs, 'diagnostics.json'), JSON.stringify(b, null, 2));
    if (c) writeFileSync(join(out, 'host', 'browser-diagnostics.json'), JSON.stringify(c, null, 2));
    writeFileSync(join(out, 'host', 'console.txt'), consoleLines.host.join('\n'));
    writeFileSync(join(sbLogs, 'console.txt'), consoleLines.sandbox.join('\n'));
    if (consoleLines.browser.length) writeFileSync(join(out, 'host', 'browser-console.txt'), consoleLines.browser.join('\n'));
    const nativeLog = join(profiles[0] ?? '', 'logs', 'native.log');
    if (existsSync(nativeLog)) cpSync(nativeLog, join(out, 'host', 'native.log'));
    if (sandboxId) run('wsb', ['exec', '--id', sandboxId, '-c', 'C:\\hx-share\\collect.cmd', '-r', 'System'], { allowFail: true });
    // One timeline: the apps' traces and what the server routed, by time.
    const rows = [];
    const short = (d) => (d ? String(d).slice(0, 8) : '');
    const fmtData = (o) => (o ? Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ') : '');
    for (const [who, d, dir] of [['HOST   ', a, join(out, 'host')], ['SANDBOX', b, sbLogs], ['BROWSER', c, join(out, 'host')]]) {
      const trace = d?.diagnostics?.trace ?? [];
      if (!d) continue;
      writeFileSync(join(dir, who === 'BROWSER' ? 'browser-trace.jsonl' : 'trace.jsonl'), trace.map((e) => JSON.stringify(e)).join('\n'));
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
    const lines = rows.map(([t, s]) => `${new Date(t).toISOString().slice(11, 23)} +${String(t - t0).padStart(7)} ${s}`);
    writeFileSync(join(out, 'timeline.txt'), lines.join('\n'));
    // A failed sync step shows where connecting and syncing stopped without opening the files.
    if (failed && lines.length) console.log(`--- merged trace (last ${Math.min(80, lines.length)} of ${lines.length} lines, full: timeline.txt) ---\n${lines.slice(-80).join('\n')}`);
    return { traceSteps: { host: a?.diagnostics?.trace?.length ?? 0, sandbox: b?.diagnostics?.trace?.length ?? 0, browser: c?.diagnostics?.trace?.length ?? 0 }, routes: { host: a?.peers?.map((p) => p.route), sandbox: b?.peers?.map((p) => p.route) } };
  }).catch(() => { failed = true; });
}

// ---- the run -------------------------------------------------------------------------------------------------------------
async function main() {
  // 1. preflight
  await step('preflight: disk, leftover instances, host profile, host firewall', async () => {
    const minFree = Number(process.env.SANDBOX_MIN_FREE_GB ?? 3) * 1024 ** 3;
    const disk = { out: { dir: base, free: freeBytes(base) }, target: { dir: targetDir, free: freeBytes(targetDir) } };
    summary.preflight = { disk: { out: { ...disk.out, freeGiB: gib(disk.out.free) }, target: { ...disk.target, freeGiB: gib(disk.target.free) } } };
    if (disk.out.free < minFree) throw new Stop(`disk: ${gib(disk.out.free)} free for the results and staged app (${base}); need ${gib(minFree)}: set SANDBOX_OUT to a volume with space`);
    if (!process.env.SKIP_BUILD && disk.target.free < 2 * minFree) throw new Stop(`disk: ${gib(disk.target.free)} free for the build (${targetDir}); need ${gib(2 * minFree)}: set E2E_TARGET_DIR to a volume with space`);
    if (run('wsb', ['--help'], { allowFail: true, shell: false }).error) throw new Stop('environment: the Windows Sandbox CLI (wsb) is not available');
    summary.preflight.leftover = (await ensureNoTestInstance([share])).leftover;
    summary.preflight.profile = isolateProfile();
    const fw = await hostFirewall(null);
    summary.hostFirewall = fw;
    firewallStop(fw);
    return { freeOut: gib(disk.out.free), firewall: fw.verdict };
  });
  // 2. build and stage
  if (!process.env.SKIP_BUILD) await step('build the desktop test app', async () => buildApp((cmd, args, opts) => run(cmd, args, { stdio: 'inherit', ...opts })));
  await step('stage the app for both machines', async () => {
    if (!existsSync(appExe)) throw new Error(`app not built: ${appExe} (run without SKIP_BUILD)`);
    rmSync(join(share, 'app'), { recursive: true, force: true });
    mkdirSync(join(share, 'app'), { recursive: true });
    cpSync(appExe, hostAppPath);
    for (const p of ['node', 'worker']) cpSync(join(debugDir, p), join(share, 'app', p), { recursive: true });
    stageScripts();
    return { app: hostAppPath, built: statSync(appExe).mtime.toISOString() };
  });
  // server
  if (localServer) {
    await step('start the local server with signaling and request logs', async () => {
      if (await healthy('http://localhost:3000')) throw new Error('something already listens on :3000; stop it first');
      const env = {
        ...process.env, MEMORY_DB: '1', HOST: '0.0.0.0', PORT: '3000', E2E_NO_LIMITS: '1', // every interface: the sandbox connects
        SIGNAL_LOG: join(out, 'server', 'signal.jsonl'), REQUEST_LOG: join(out, 'server', 'requests.jsonl'),
        ...(process.env.NO_APP_RELAY === '0' ? { APPLICATION_RELAY: '1' } : {}),
      };
      const fd = openSync(join(out, 'server', 'server.log'), 'a');
      // node.exe itself (no shell, no pnpm): the executable the firewall rule names.
      const c = spawn(nodePath, ['--import', 'tsx', 'src/local.ts'], { cwd: join(root, 'server'), env, stdio: ['ignore', fd, fd] });
      children.push(c);
      await until(() => healthy('http://localhost:3000'), 'local server /api/health', 90_000, 500);
      return { node: nodePath, relay: Boolean(env.TURN_USERNAME || env.CF_TURN_KEY_ID), applicationRelay: env.APPLICATION_RELAY === '1' };
    });
  }
  if (scenarios.includes('mixed')) {
    await step('start the web app for the browser (mixed)', async () => {
      if (!(await fetch('http://localhost:1420').then((r) => r.ok).catch(() => false))) {
        const fd = openSync(join(out, 'server', 'web.log'), 'a');
        const c = spawn('pnpm', ['--filter', '@hivetex/web', 'dev'], { cwd: root, shell: true, stdio: ['ignore', fd, fd] });
        children.push(c);
      }
      await until(() => fetch('http://localhost:1420').then((r) => r.ok).catch(() => false), 'web dev server', 120_000, 1000);
    });
  }
  // 3. sandbox, its firewall
  await step('start Windows Sandbox and verify its firewall', async () => {
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
    sbPs('setup.ps1', '', 'System', { allowFail: true });
    const st = readSb('setup.json');
    summary.sandboxFirewall = st;
    if (!st?.ok) throw new Stop(`firewall: sandbox setup failed${FAULT === 'no-udp' ? ' (FAULT=no-udp not in effect)' : ' (the sandbox firewall could not be disabled)'}: ${st?.error ?? 'no setup.json'}`);
    gateway = st.gateway;
    // The host interface facing this sandbox, now that its address is known.
    const fw = await hostFirewall(sandboxIp);
    summary.hostFirewall = fw;
    firewallStop(fw);
    return { id: sandboxId, ip: sandboxIp, gateway, sandboxFirewall: st.profiles?.map((p) => `${p.name}=${p.enabled ? 'on' : 'off'}`).join(' '), hostFacing: `${fw.facing?.alias} ${fw.facingProfile} ${fw.facingProfileEnabled ? 'enabled' : 'disabled'}` };
  });
  // 4. reachability before sign-in
  await step('reachability: sandbox -> host TCP :3000, UDP echo both ways', async () => {
    // The host echo runs in its own process (the same node.exe as the server, which the firewall rule names): sbPs below
    // is synchronous and would block an echo socket of this process for its whole duration.
    const echo = spawn(nodePath, [join(share, 'echo.mjs'), 'server', String(ECHO_HOST), '120'], { stdio: 'ignore' });
    children.push(echo);
    await pause(500);
    try {
      sbPs('reach.ps1', `-Gw ${gateway}`);
      const toSb = await new Promise((ok) => {
        const s = dgram.createSocket('udp4');
        const t0 = Date.now();
        const timer = setInterval(() => s.send(Buffer.from('hx-echo'), ECHO_SB, sandboxIp), 300);
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; clearInterval(timer); clearTimeout(limit); s.close(); ok(v); };
        s.on('message', () => done({ ok: true, ms: Date.now() - t0 }));
        const limit = setTimeout(() => done({ ok: false, error: 'no echo within 6 s' }), 6000);
      });
      const r = { tcp: readSb('reach-tcp.json'), udpSandboxToHost: readSb('reach-udp.json'), udpHostToSandbox: toSb };
      summary.reachability = r;
      const bad = [!r.tcp?.tcp && `TCP from the sandbox to ${gateway}:3000 failed`, !r.udpSandboxToHost?.ok && `UDP sandbox -> host ${gateway}:${ECHO_HOST}: ${r.udpSandboxToHost?.error ?? 'no result'}`, !toSb.ok && `UDP host -> sandbox ${sandboxIp}:${ECHO_SB}: ${toSb.error}`].filter(Boolean);
      if (bad.length) {
        const fw = summary.hostFirewall;
        throw new Stop(`reachability: ${bad.join('; ')}. Host firewall: ${fw.verdict} (${fw.facing?.alias ?? '?'}, profile ${fw.facingProfile}); sandbox firewall: ${summary.sandboxFirewall?.profiles?.map((p) => `${p.name}=${p.enabled ? 'on' : 'off'}`).join(' ')}. No sync step was run.`);
      }
      return r;
    } finally { echo.kill(); }
  });
  // apps
  await step('launch the app on both machines', async () => {
    const err = openSync(join(out, 'host', 'app-stderr.txt'), 'a');
    mkdirSync(join(out, 'host', 'folder'), { recursive: true });
    // The compile scenario builds with this PC's own TeX; otherwise the host behaves as a computer without TeX.
    hostApp = spawn(hostAppPath, [...(scenarios.includes('compile') ? [] : ['--ignore-system-tex']), '--test-pick-dir', join(out, 'host', 'folder')], {
      stdio: ['ignore', err, err], env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${HOST_CDP}` },
    });
    children.push(hostApp);
    launchSandboxApp();
  });
  const A = await step('attach to both apps (DevTools)', async () => ({ host: await attach(`http://127.0.0.1:${HOST_CDP}`, 'host'), sandbox: await attach(`http://${sandboxIp}:${SB_CDP_PUBLIC}`, 'sandbox') }));
  host = A.host;
  sb = A.sandbox;
  delete summary.steps.at(-1).value;
  await step('register an account on each machine', async () => {
    await Promise.all([signUp(host, userA), signUp(sb, userB)]);
    return { host: userA, sandbox: userB };
  });
  await step('host creates the project; joiners become editors', async () => {
    const { page } = host;
    await page.getByTestId('new-project-btn').click();
    await page.getByPlaceholder('my-paper-2026').fill(`sync-${tag}`);
    await page.locator('form:has(h2:text("New project")) input[type=password]').fill(PROJECT_PW);
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByTestId('workspace').waitFor({ timeout: 60_000 });
    slug = (await page.getByTestId('project-slug').textContent())?.trim();
    projectId = await page.evaluate(() => window.__p2p.session.project.id);
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
  if (FAULT === 'deaf' || FAULT === 'deaf-silent') {
    await step(`inject fault ${FAULT} on the server`, async () => {
      if (!localServer) throw new Error('faults need the local server');
      const silent = FAULT === 'deaf-silent' ? '?silent=1' : '';
      const r = await (await fetch(`http://localhost:3000/api/__dev/signal/lose-subscriptions${silent}`)).json();
      if (!r.lost) throw new Error('no subscription to lose: the host is not connected to the server');
      return r;
    });
  }
  await step('sandbox joins the project', () => joinProject(sb.page));
  await tryStep('the sandbox joined as editor', async () => {
    const role = await until(() => sb.page.evaluate(() => window.__p2p?.session?.project?.role), 'joined role');
    if (role !== 'editor') throw new Error(`joined as ${role}: the default role was not saved (its edits will be refused)`);
  });
  if (process.env.SABOTAGE === '1') await step('SABOTAGE: both apps discard text and binary files received from the other', async () => { await sabotage(host); await sabotage(sb); });

  // ---- basic sync checks ----
  await tryStep('peers see each other with a route', async () => {
    const [a, b] = await until(async () => {
      const x = await Promise.all([peers(host), peers(sb)]);
      return x[0].some((p) => p.route) && x[1].some((p) => p.route) ? x : null;
    }, 'a route on both sides', SYNC_MS, 1000);
    return { host: a, sandbox: b };
  });
  if (FAULT === 'no-udp') {
    await tryStep('FAULT=no-udp in effect: relay route, no UDP pair in the sandbox', async () => {
      const [a, b] = await Promise.all([peers(host), peers(sb)]);
      const pairs = ((await diagnostics(sb))?.diagnostics?.trace ?? []).filter((e) => e.ev === 'pair' && /udp/i.test(JSON.stringify(e.data ?? {})));
      if (![...a, ...b].every((p) => p.route === 'relay') || pairs.length) throw new Error(`fault not effective: routes host=${a.map((p) => p.route)} sandbox=${b.map((p) => p.route)}, UDP pairs in the sandbox trace: ${pairs.length}`);
      return { routes: [...a, ...b].map((p) => p.route) };
    });
  }
  await tryStep('host → sandbox: a new file arrives', async () => {
    mainId = await create(host, 'main.tex', `\\documentclass{article}\n% written on the host ${tag}\n`);
    await arrives(sb, mainId, `written on the host ${tag}`, 'main.tex on the sandbox');
  });
  let notesId;
  await tryStep('sandbox → host: a new file arrives', async () => {
    notesId = await create(sb, 'notes.tex', `written in the sandbox ${tag}\n`);
    await arrives(host, notesId, `written in the sandbox ${tag}`, 'notes.tex on the host');
  });
  await tryStep('sandbox → host: an edit to the host’s file arrives', async () => {
    if (!mainId || !(await textOf(sb, mainId))) throw new Error('main.tex never reached the sandbox');
    await append(sb, mainId, `% edited in the sandbox ${tag}\n`);
    await arrives(host, mainId, `edited in the sandbox ${tag}`, 'sandbox edit on the host');
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
  // Sync within 5 s once linked (transport spec): one edit each way, timed.
  await tryStep('an edit arrives within 5 s each way', async () => {
    if (!mainId || !(await textOf(sb, mainId))) throw new Error('main.tex never reached the sandbox');
    const timed = async (from, to, marker) => {
      const t = Date.now();
      await append(from, mainId, `${marker}\n`);
      return until(() => hasMarker(to, mainId, marker), marker, 30_000, 100).then(() => Date.now() - t).catch(() => null);
    };
    const r = { hostToSandboxMs: await timed(host, sb, `% 5s host ${tag}`), sandboxToHostMs: await timed(sb, host, `% 5s sandbox ${tag}`) };
    r.ok = r.hostToSandboxMs !== null && r.sandboxToHostMs !== null && r.hostToSandboxMs <= 5000 && r.sandboxToHostMs <= 5000;
    summary.sync5s = r;
    if (!r.ok) throw new Error(`not within 5 s: ${JSON.stringify(r)}`);
    return r;
  });

  // ---- data-safety scenarios ----
  for (const name of scenarios.filter((s) => s !== 'basic')) await scenario(name, SCENARIOS[name]);

  // ---- hold: keep editing for a while; halfway the server ends every signaling socket ----
  // One edit every 5 s, alternating sides; each must reach the other side within HOLD_MAX_MS. Catches links that connect
  // and then die (the route is sampled on every edit and route changes are recorded).
  const HOLD_S = Number(process.env.HOLD_S ?? 0);
  const HOLD_MAX_MS = Number(process.env.HOLD_MAX_MS ?? 10_000);
  if (HOLD_S > 0) {
    await tryStep(`hold: edits both ways for ${HOLD_S} s, each arriving within ${HOLD_MAX_MS / 1000} s`, async () => {
      if (!mainId || !(await textOf(sb, mainId))) throw new Error('main.tex never reached the sandbox');
      const start = Date.now();
      const end = start + HOLD_S * 1000;
      const rotateAt = localServer && process.env.ROTATE !== '0' ? start + HOLD_S * 500 : Infinity;
      let rotation = null;
      const latencies = [];
      const late = [];
      const routes = [];
      let lastRoutes = '';
      let n = 0;
      while (Date.now() < end) {
        if (!rotation && Date.now() >= rotateAt) {
          const r = await fetch('http://localhost:3000/api/__dev/signal/terminate').then((x) => x.json()).catch((e) => ({ error: String(e) }));
          rotation = { at: new Date().toISOString(), atEdit: n, ...r };
          log(`hold: signaling sockets ended (${JSON.stringify(r)})`);
        }
        const [from, to] = n % 2 === 0 ? [host, sb] : [sb, host];
        const marker = `% hold ${n} from ${from.label} ${tag}`;
        const t = Date.now();
        await append(from, mainId, `${marker}\n`);
        const ms = await until(() => hasMarker(to, mainId, marker), `hold edit ${n}`, HOLD_MAX_MS, 200).then(() => Date.now() - t).catch(() => null);
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
      if (rotation) rotation.lateAfter = late.filter((l) => l.n >= rotation.atEdit).length;
      const result = { edits: n, late: late.length, medianMs: latencies[Math.floor(latencies.length / 2)] ?? null, maxMs: latencies.at(-1) ?? null, rotation, routes, lateEdits: late.slice(0, 20) };
      summary.hold = result;
      if (late.length) throw new Error(`${late.length} of ${n} edits did not arrive within ${HOLD_MAX_MS} ms; routes (host | sandbox): ${routes.map((r) => r.routes).join(' -> ')}`);
      return result;
    });
  }

  // ---- connection test from both sides at once ----
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
}
async function healthy(url) {
  return fetch(`${url}/api/health`).then((r) => r.ok).catch(() => false);
}

try {
  await main();
} catch (e) {
  failed = true;
  if (e instanceof Stop) summary.diagnosis = e.message;
  else if (!summary.steps.some((s) => !s.ok)) summary.error = e instanceof Error ? e.message : String(e);
} finally {
  if (!interrupted) {
    await collect();
    await cleanup().catch((e) => log(`cleanup: ${e.message}`));
    writeSummary();
  }
}
process.exit(failed ? 1 : 0);
