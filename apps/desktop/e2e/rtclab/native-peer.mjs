/**
 * Native peer of the WebRTC lab: the desktop's Rust stack (`rtc_cli`, the same bridge the app uses, on the shared muxed
 * listener like the sync worker) speaking the lab protocol of peer.html, so a browser and a native peer can face each
 * other. Its report adds the stack's own log lines (masked, credential-free: src-tauri/src/rtc_log.rs).
 *
 * As a module (run.mjs): stage(), startHost(), writeSandboxLauncher(). As a program (inside the sandbox):
 *   node native-peer.mjs <json options>   {url, role, room, policy, turn, hold, cli}
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const debugDir = resolve(here, '../../src-tauri/target/debug');
const cliHere = join(debugDir, 'examples', process.platform === 'win32' ? 'rtc_cli.exe' : 'rtc_cli');

/** Copies what the sandbox needs to run a native peer into the shared folder: the bridge, Node and this script. */
export function stage(share) {
  if (!existsSync(cliHere)) throw new Error(`build the bridge first: cargo build --example rtc_cli (in apps/desktop/src-tauri); missing ${cliHere}`);
  const node = join(debugDir, 'node', 'node.exe');
  if (!existsSync(node)) throw new Error(`missing ${node}: build the desktop test app once (it brings the pinned Node runtime)`);
  mkdirSync(share, { recursive: true });
  copyFileSync(cliHere, join(share, 'rtc_cli.exe'));
  copyFileSync(node, join(share, 'node.exe'));
  copyFileSync(fileURLToPath(import.meta.url), join(share, 'native-peer.mjs'));
}

/** Writes the sandbox's launcher for role b (started detached: the exec'd console would otherwise end it). */
export function writeSandboxLauncher(share, opts) {
  const json = JSON.stringify({ ...opts, cli: 'C:\\lab\\rtc_cli.exe' }).replace(/"/g, '\\"');
  writeFileSync(join(share, 'peer-b.cmd'), `@echo off\r\nstart "" /min C:\\lab\\node.exe C:\\lab\\native-peer.mjs "${json}"\r\n`);
}

/** Runs a native peer on this PC; `stop()` ends it. */
export function startHost(opts) {
  const peer = runPeer({ ...opts, cli: cliHere });
  return { stop: () => peer.stop() };
}

function runPeer({ url, role, room, policy, turn, hold, cli, interfaces }) {
  const proc = spawn(cli, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const events = [];
  const note = (ev, data = {}) => events.push({ ms: now(), ev, ...data });
  let rid = 0;
  const waiting = new Map();
  let buf = '';
  let onEvent = () => {};
  proc.stdout.on('data', (d) => {
    buf += String(d);
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.event) onEvent(m.payload);
      else if (waiting.has(m.rid)) {
        const w = waiting.get(m.rid);
        waiting.delete(m.rid);
        if (m.error) w.err(new Error(m.error));
        else w.ok(m.result);
      }
    }
  });
  const call = (cmd, args = {}) =>
    new Promise((ok, err) => {
      const id = ++rid;
      waiting.set(id, { ok, err });
      proc.stdin.write(`${JSON.stringify({ rid: id, cmd, args: { id: 'lab', ...args } })}\n`);
    });
  const b64 = (s) => Buffer.from(s).toString('base64');

  const ws = new WebSocket(`${url}/?room=${encodeURIComponent(room)}`);
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
  let reported = false;
  const report = async (extra) => {
    if (reported) return;
    reported = true;
    const log = await call('rtc_log', { since: 0 }).catch(() => []);
    send({ t: 'result', role, kind: 'native', policy, turn, holdS: hold, events, nativeLog: log.map((l) => l.line).slice(-200), ...extra });
  };
  async function selectedPair() {
    const stats = await call('rtc_stats').catch(() => []);
    const byType = (t) => stats.find((s) => s.type === t);
    const l = byType('local-candidate');
    const r = byType('remote-candidate');
    return l ? { local: l.candidateType, remote: r?.candidateType ?? 'unknown', relayProtocol: l.relayProtocol ?? null } : null;
  }
  const rtts = [];
  let channelOpen = false;
  let pinger;
  let giveUp;
  let extendGiveUp = () => {};
  const startPings = () => {
    let n = 0;
    pinger = setInterval(() => channelOpen && void call('rtc_send', { label: 'lab', b64: b64(JSON.stringify({ ping: Date.now(), n: n++ })) }).catch(() => {}), 1000);
    setTimeout(async () => {
      clearInterval(pinger);
      rtts.sort((x, y) => x - y);
      await report({ connected: true, pongs: rtts.length, expectedPongs: hold, medianRttMs: rtts[Math.floor(rtts.length / 2)] ?? null, pair: await selectedPair() });
      send({ t: 'done' });
    }, hold * 1000);
  };
  onEvent = (e) => {
    if (e.kind === 'ice') {
      const c = e.candidate?.candidate ?? '';
      note('local', { type: / typ (\w+)/.exec(c)?.[1] ?? 'unknown', proto: / (udp|tcp) /i.exec(c)?.[1]?.toLowerCase() ?? 'unknown' });
      send({ t: 'ice', candidate: e.candidate });
    } else if (e.kind === 'state') note('state', { state: String(e.state).toLowerCase() });
    else if (e.kind === 'ice-state') note('ice-state', { state: String(e.state).toLowerCase() });
    else if (e.kind === 'pair') note('pair', { local: e.local, remote: e.remote, protocol: e.protocol });
    else if (e.kind === 'open' && e.label === 'lab') {
      channelOpen = true;
      extendGiveUp();
      void selectedPair().then((pair) => note('open', { pair }));
      if (role === 'a') startPings();
    } else if (e.kind === 'close') note('channel-closed');
    else if (e.kind === 'message') {
      const m = JSON.parse(Buffer.from(e.b64, 'base64').toString());
      if (m.ping !== undefined) void call('rtc_send', { label: 'lab', b64: b64(JSON.stringify({ pong: m.ping })) }).catch(() => {});
      else if (m.pong !== undefined) rtts.push(Date.now() - m.pong);
    }
  };

  ws.onmessage = async (msg) => {
    const m = JSON.parse(String(msg.data));
    if (m.t === 'hello' && role === 'a') {
      await call('rtc_create_data_channel', { label: 'lab' });
      const offer = await call('rtc_create_offer');
      await call('rtc_set_local', { kind: 'offer', sdp: offer });
      send({ t: 'sdp', type: 'offer', sdp: offer });
    } else if (m.t === 'sdp') {
      await call('rtc_set_remote', { kind: m.type, sdp: m.sdp });
      if (m.type === 'offer') {
        const answer = await call('rtc_create_answer');
        await call('rtc_set_local', { kind: 'answer', sdp: answer });
        send({ t: 'sdp', type: 'answer', sdp: answer });
      }
    } else if (m.t === 'ice') {
      await call('rtc_add_ice', { candidate: m.candidate }).catch((err) => note('add-ice-error', { message: String(err).slice(0, 80) }));
    } else if (m.t === 'done' && role === 'b') {
      await report({ connected: events.some((x) => x.ev === 'open'), pair: await selectedPair() });
    }
  };
  ws.onopen = async () => {
    const http = url.replace(/^ws/, 'http');
    const ice = await (await fetch(`${http}/ice?turn=${turn}`)).json();
    await call('rtc_create', { ice, muxed: true, ...(policy === 'relay' ? { policy } : {}), ...(interfaces ? { interfaces } : {}) });
    if (role === 'b') send({ t: 'hello' });
  };
  // Never connected (or the other side never finished): report what was seen; restarted when the channel opens.
  const fallback = async () => report({ connected: events.some((x) => x.ev === 'open'), timeout: true, pair: await selectedPair() });
  giveUp = setTimeout(fallback, (hold + 30) * 1000);
  extendGiveUp = () => {
    clearTimeout(giveUp);
    giveUp = setTimeout(fallback, (hold + 15) * 1000);
  };
  return {
    stop() {
      clearTimeout(giveUp);
      clearInterval(pinger);
      ws.close();
      proc.kill();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const opts = JSON.parse(process.argv[2]);
  const peer = runPeer(opts);
  setTimeout(() => {
    peer.stop();
    process.exit(0);
  }, (opts.hold + 60) * 1000);
}
