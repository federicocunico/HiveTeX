#!/usr/bin/env node
/**
 * WebRTC lab (`make rtc-lab`, Windows 11 with Windows Sandbox): the same two machines as `make sandbox-sync` (this PC
 * and the sandbox behind its own NAT), but no HiveTeX code between them — a minimal signaling server, and on each side
 * a WebRTC peer that connects, then exchanges a ping every second for HOLD_S seconds. It tells the network and the relay
 * apart from the WebRTC stack: run it with browser peers (libwebrtc) and with native peers (the desktop's Rust stack).
 *
 *   SCENARIOS=relay-udp,relay-tcp,all,stun   which runs (default: all four)
 *   PEERS=browser | native | native-browser | browser-native   stack on this PC - stack in the sandbox (default browser)
 *   HOLD_S=45                                 seconds of pings once connected
 *   NATIVE_INTERFACES=all|default|physical    native peers: which interfaces gather host candidates (rtc.rs)
 *   TURN_SERVER / TURN_USERNAME / TURN_CREDENTIAL   the relay under test (e.g. `set -a; . ./.env.setup; set +a`)
 *
 * A scenario passes when the offering side got at least 90% of its pongs. Results: apps/desktop/src-tauri/target/rtclab/
 * <run>/results.jsonl (every event of both peers) and summary.json; the exit code is 1 when a scenario failed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '../..');
const base = join(desktop, 'src-tauri/target/rtclab');
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = join(base, runId);
const share = join(base, 'share');
const PORT = 3999;
const HOLD_S = Number(process.env.HOLD_S ?? 45);
const SCENARIOS = {
  'relay-udp': { policy: 'relay', turn: 'udp' },
  'relay-tcp': { policy: 'relay', turn: 'tcp' },
  all: { policy: 'all', turn: 'both' },
  stun: { policy: 'all', turn: 'none' },
};
const scenarios = (process.env.SCENARIOS ?? Object.keys(SCENARIOS).join(',')).split(',').filter(Boolean);
const [hostKind, sandboxKind = hostKind] = (process.env.PEERS ?? 'browser').split('-');
mkdirSync(out, { recursive: true });
mkdirSync(share, { recursive: true });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const toInt = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
/** The IPv4 address of this PC on the same subnet as `ip` (the Hyper-V switch the sandbox sits behind). */
function hostAddressFacing(ip) {
  if (!ip) return null;
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const mask = toInt(a.netmask);
      if ((toInt(a.address) & mask) >>> 0 === (toInt(ip) & mask) >>> 0) return a.address;
    }
  }
  return null;
}
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const wsb = (args) => spawnSync('wsb', [...args, '--raw'], { encoding: 'utf8' });
const exec = (id, command, as = 'ExistingLogin') => spawnSync('wsb', ['exec', '--id', id, '-c', command, '-r', as], { encoding: 'utf8' });
const children = [];
const resultsFile = join(out, 'results.jsonl');
const results = () => (existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const kind of [hostKind, sandboxKind]) if (!['browser', 'native'].includes(kind)) throw new Error(`PEERS: unknown peer kind ${kind}`);
const native = await import('./native-peer.mjs').catch(() => null);
if ((hostKind === 'native' || sandboxKind === 'native') && !native) throw new Error('native peers need native-peer.mjs');

let sandboxId;
let browser;
let failed = false;
const summary = { runId, hold: HOLD_S, nativeInterfaces: process.env.NATIVE_INTERFACES ?? 'all', peers: `${hostKind}-${sandboxKind}`, relay: Boolean(process.env.TURN_SERVER), scenarios: [] };
try {
  const server = spawn(process.execPath, [join(here, 'server.mjs'), String(PORT), out], { stdio: 'inherit', env: process.env });
  children.push(server);
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok).catch(() => false)); i++) await pause(200);

  if (sandboxKind === 'native') native.stage(share);
  for (const e of JSON.parse(wsb(['list']).stdout || '{}').WindowsSandboxEnvironments ?? []) wsb(['stop', '--id', e.Id]);
  const config = `<Configuration><Networking>Enable</Networking><MappedFolders><MappedFolder><HostFolder>${share}</HostFolder><SandboxFolder>C:\\lab</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder></MappedFolders></Configuration>`;
  sandboxId = JSON.parse(wsb(['start', '--config', config]).stdout).Id;
  // A signed-in session for the sandbox's browser or app: the sandbox's own remote desktop opens it.
  spawn('wsb', ['connect', '--id', sandboxId], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 90 && exec(sandboxId, 'C:\\Windows\\System32\\whoami.exe').status !== 0; i++) await pause(2000);
  // This PC as the sandbox sees it: its address on the sandbox's network (wsb exec returns no command output).
  const sandboxIp = JSON.parse(wsb(['ip', '--id', sandboxId]).stdout || '{}').Networks?.[0]?.IpV4Address;
  const gateway = hostAddressFacing(sandboxIp);
  if (!gateway) throw new Error(`no address of this PC on the sandbox's network (sandbox ${sandboxIp ?? 'without address'})`);
  log(`sandbox ${sandboxId} at ${sandboxIp}; this PC is ${gateway} from inside`);
  if (hostKind === 'browser') {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
  }

  for (const name of scenarios) {
    const s = SCENARIOS[name];
    if (!s) throw new Error(`unknown scenario ${name}`);
    const room = `${name}-${Date.now().toString(36)}`;
    const query = `room=${room}&policy=${s.policy}&turn=${s.turn}&hold=${HOLD_S}`;
    const before = results().length;
    // Role a (offers, pings) on this PC first, then role b in the sandbox says hello.
    let page;
    let hostPeer;
    if (hostKind === 'browser') {
      page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${PORT}/peer.html?role=a&${query}`);
    } else hostPeer = native.startHost({ url: `ws://127.0.0.1:${PORT}`, role: 'a', room, policy: s.policy, turn: s.turn, hold: HOLD_S, interfaces: process.env.NATIVE_INTERFACES ?? null });
    await pause(500);
    if (sandboxKind === 'browser') {
      writeFileSync(join(share, 'peer-b.cmd'), `@echo off\r\nstart "" "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --headless=new --disable-gpu --no-first-run --user-data-dir=C:\\edge-${room} "http://${gateway}:${PORT}/peer.html?role=b&${query}"\r\n`);
    } else native.writeSandboxLauncher(share, { url: `ws://${gateway}:${PORT}`, role: 'b', room, policy: s.policy, turn: s.turn, hold: HOLD_S, interfaces: process.env.NATIVE_INTERFACES ?? null });
    exec(sandboxId, 'C:\\lab\\peer-b.cmd');
    log(`${name}: started (${hostKind} here, ${sandboxKind} in the sandbox)`);
    const end = Date.now() + (HOLD_S + 45) * 1000;
    while (Date.now() < end && results().length < before + 2) await pause(1000);
    await page?.close();
    hostPeer?.stop();
    exec(sandboxId, `C:\\Windows\\System32\\taskkill.exe /f /im ${sandboxKind === 'browser' ? 'msedge.exe' : 'rtc_cli.exe'}`);
    exec(sandboxId, 'C:\\Windows\\System32\\taskkill.exe /f /im node.exe');
    const rows = results().slice(before);
    const a = rows.find((r) => r.role === 'a');
    const b = rows.find((r) => r.role === 'b');
    const ok = Boolean(a?.connected && a.pongs >= Math.floor(0.9 * HOLD_S));
    if (!ok) failed = true;
    const local = (r) => {
      const n = {};
      for (const e of r?.events ?? []) if (e.ev === 'local') n[`${e.type}/${e.proto}`] = (n[`${e.type}/${e.proto}`] ?? 0) + 1;
      return n;
    };
    const firstConnected = (r) => r?.events?.find((e) => e.ev === 'state' && e.state === 'connected')?.ms ?? null;
    const row = {
      scenario: name, ok, pongs: a?.pongs ?? 0, expected: HOLD_S, pair: a?.pair ?? null, medianRttMs: a?.medianRttMs ?? null,
      connectedAtMs: { a: firstConnected(a), b: firstConnected(b) },
      states: { a: (a?.events ?? []).filter((e) => e.ev === 'state').map((e) => `${e.ms}:${e.state}`), b: (b?.events ?? []).filter((e) => e.ev === 'state').map((e) => `${e.ms}:${e.state}`) },
      localCandidates: { a: local(a), b: local(b) },
      reported: { a: Boolean(a), b: Boolean(b) },
    };
    summary.scenarios.push(row);
    log(`${name}: ${ok ? 'PASS' : 'FAIL'} pongs ${row.pongs}/${HOLD_S} pair ${JSON.stringify(row.pair)} states a=[${row.states.a.join(' ')}] b=[${row.states.b.join(' ')}]`);
  }
} catch (e) {
  failed = true;
  log(`error: ${e instanceof Error ? e.message : e}`);
} finally {
  await browser?.close();
  if (sandboxId) wsb(['stop', '--id', sandboxId]);
  for (const c of children) if (c.pid) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
  summary.result = failed ? 'FAIL' : 'PASS';
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  log(`${summary.result} — ${out}`);
  cpSync(join(out, 'summary.json'), join(base, 'latest-summary.json'));
}
process.exit(failed ? 1 : 0);
