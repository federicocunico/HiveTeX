#!/usr/bin/env node
/**
 * Router matrix (13.4) on Linux network namespaces, as root (CI runner or the netlab Docker image):
 *
 *   wanA 45.83.220.1 ─ routerA (NAT, filtering, miniupnpd) ─ lanA 192.168.10.0/24: hostA .2, hostA2 .3
 *   wanB 45.83.220.2 ─ routerB (symmetric NAT)             ─ lanB 10.20.0.0/24:    hostB .2
 *   coturn on the WAN at 45.83.220.50 (only in the TURN cases)
 *
 * The peers are `rtc_cli`, the app's own native stack (shared muxed listener, patched ICE, IGD client and mapping
 * manager), one per namespace; this script relays their signaling. For each case it records the selected candidate
 * pair (rtc_stats), the port-mapping status, and tcpdump counts on routerA's WAN interface, so a SOAP success is
 * told apart from working transport. Writes $NETLAB_OUT (default netlab-result.json).
 *
 * Usage: sudo node matrix.mjs <path to rtc_cli>
 */
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const cli = process.argv[2];
if (!cli) throw new Error('usage: matrix.mjs <rtc_cli>');
const OUT = process.env.NETLAB_OUT ?? 'netlab-result.json';
const sh = (cmd, opts = {}) => execFileSync('sh', ['-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const nsx = (ns, cmd) => sh(`ip netns exec ${ns} sh -c '${cmd.replace(/'/g, `'\\''`)}'`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function topology() {
  sh('ip -all netns delete 2>/dev/null || true');
  for (const ns of ['wan', 'routerA', 'routerB', 'hostA', 'hostA2', 'hostB']) sh(`ip netns add ${ns}`);
  // WAN bridge with both routers and the TURN server.
  sh('ip -n wan link add br0 type bridge && ip -n wan link set br0 up && ip -n wan addr add 45.83.220.50/24 dev br0');
  // Like the Internet: other destinations are routed (and lost), not unreachable. coturn closes an allocation when a
  // relayed send fails with ENETUNREACH (for example towards a peer's private host candidate).
  sh('ip -n wan neigh add 45.83.220.254 lladdr 02:00:00:00:00:fe dev br0 && ip -n wan route add default via 45.83.220.254');
  const veth = (a, an, b, bn) => sh(`ip link add ${an} netns ${a} type veth peer name ${bn} netns ${b}`);
  veth('routerA', 'wan0', 'wan', 'ra'); veth('routerB', 'wan0', 'wan', 'rb');
  sh('ip -n wan link set ra master br0 && ip -n wan link set rb master br0 && ip -n wan link set ra up && ip -n wan link set rb up');
  sh('ip -n routerA addr add 45.83.220.1/24 dev wan0 && ip -n routerA link set wan0 up');
  sh('ip -n routerB addr add 45.83.220.2/24 dev wan0 && ip -n routerB link set wan0 up');
  // LAN A: a bridge in routerA with hostA and hostA2.
  sh('ip -n routerA link add lan0 type bridge && ip -n routerA addr add 192.168.10.1/24 dev lan0 && ip -n routerA link set lan0 up');
  veth('hostA', 'ha0', 'routerA', 'pa'); veth('hostA2', 'ha20', 'routerA', 'pa2');
  for (const p of ['pa', 'pa2']) sh(`ip -n routerA link set ${p} master lan0 && ip -n routerA link set ${p} up`);
  sh('ip -n hostA addr add 192.168.10.2/24 dev ha0 && ip -n hostA link set ha0 up && ip -n hostA route add default via 192.168.10.1');
  sh('ip -n hostA2 addr add 192.168.10.3/24 dev ha20 && ip -n hostA2 link set ha20 up && ip -n hostA2 route add default via 192.168.10.1');
  // LAN B.
  veth('hostB', 'hb0', 'routerB', 'lan0');
  sh('ip -n routerB addr add 10.20.0.1/24 dev lan0 && ip -n routerB link set lan0 up');
  sh('ip -n hostB addr add 10.20.0.2/24 dev hb0 && ip -n hostB link set hb0 up && ip -n hostB route add default via 10.20.0.1');
  for (const ns of ['wan', 'routerA', 'routerB', 'hostA', 'hostA2', 'hostB']) sh(`ip -n ${ns} link set lo up`);
  for (const r of ['routerA', 'routerB']) nsx(r, 'sysctl -qw net.ipv4.ip_forward=1');
  // routerA: port-restricted cone NAT. Nothing enters from the WAN unless it is an answer or a UPnP mapping (DNAT).
  nsx('routerA', 'iptables -t nat -A POSTROUTING -o wan0 -j MASQUERADE');
  nsx('routerA', 'iptables -P FORWARD DROP && iptables -A FORWARD -i lan0 -o wan0 -j ACCEPT && iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT && iptables -A FORWARD -m conntrack --ctstate DNAT -j ACCEPT');
  // No hairpin: miniupnpd DNATs only on the WAN interface, so LAN traffic to the public address is not looped back.
  nsx('routerA', 'iptables -A FORWARD -i lan0 -o lan0 -j ACCEPT'); // the LAN switch (bridged frames pass FORWARD with br_netfilter)
  // routerB: symmetric NAT (random ports per destination), so only a reachable mapped endpoint can connect.
  nsx('routerB', 'iptables -t nat -A POSTROUTING -o wan0 -j MASQUERADE --random-fully');
  nsx('routerB', 'iptables -P FORWARD DROP && iptables -A FORWARD -i lan0 -o wan0 -j ACCEPT && iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
  // Learn the gateways (the IGD client finds the gateway from the neighbour table).
  for (const [h, gw] of [['hostA', '192.168.10.1'], ['hostA2', '192.168.10.1'], ['hostB', '10.20.0.1']]) nsx(h, `ping -c1 -W1 ${gw} >/dev/null`);
}

function startMiniupnpd() {
  writeFileSync('/tmp/netlab-miniupnpd.conf', [
    'ext_ifname=wan0', 'listening_ip=lan0', 'port=5000', 'enable_natpmp=no', 'enable_upnp=yes', 'secure_mode=yes',
    'system_uptime=yes', 'notify_interval=60', 'clean_ruleset_interval=600', 'uuid=3d3cec3a-8cf0-11e0-98ee-001a6bd2d07b',
    'allow 1024-65535 192.168.10.0/24 1024-65535', 'deny 0-65535 0.0.0.0/0 0-65535',
    'upnp_table_name=miniupnpd', 'upnp_nat_table_name=miniupnpd', 'upnp_forward_chain=miniupnpd',
    'upnp_nat_chain=prerouting_miniupnpd', 'upnp_nat_postrouting_chain=postrouting_miniupnpd', '',
  ].join('\n'));
  // The nftables structure miniupnpd fills in (its packaged init script is incomplete). DNAT'ed packets are then also
  // accepted by routerA's iptables FORWARD rule for --ctstate DNAT; everything else from the WAN stays dropped.
  writeFileSync('/tmp/netlab-miniupnpd.nft', `table inet miniupnpd {
  chain forward { type filter hook forward priority 0; policy accept; jump miniupnpd; }
  chain miniupnpd { }
  chain prerouting { type nat hook prerouting priority -100; policy accept; jump prerouting_miniupnpd; }
  chain postrouting { type nat hook postrouting priority 100; policy accept; jump postrouting_miniupnpd; }
  chain prerouting_miniupnpd { }
  chain postrouting_miniupnpd { }
}
`);
  nsx('routerA', 'nft delete table inet miniupnpd 2>/dev/null; nft -f /tmp/netlab-miniupnpd.nft');
  const p = spawn('ip', ['netns', 'exec', 'routerA', 'miniupnpd', '-d', '-f', '/tmp/netlab-miniupnpd.conf'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  p.stderr.on('data', (d) => { log += String(d); });
  p.log = () => log;
  children.push(p);
  return p;
}

function startTurn() {
  const p = spawn('ip', ['netns', 'exec', 'wan', 'turnserver', '-n', '--listening-ip=45.83.220.50', '--relay-ip=45.83.220.50', '--external-ip=45.83.220.50',
    '--listening-port=3478', '--lt-cred-mech', '--user=dev:dev-stack-turn', '--realm=netlab', '--no-tls', '--no-dtls',
    '--no-cli', '--min-port=49152', '--max-port=49300', '--log-file=stdout', '--simple-log', '-V'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (d) => { log += String(d); });
  p.stderr.on('data', (d) => { log += String(d); });
  p.log = () => log;
  children.push(p);
  return p;
}

/** One rtc_cli in a namespace, with request/response and events. */
function peer(ns) {
  const proc = spawn('ip', ['netns', 'exec', ns, cli], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(proc);
  let rid = 0, buf = '';
  const waiting = new Map();
  const listeners = new Set();
  proc.stdout.on('data', (d) => {
    buf += String(d);
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.event) for (const l of listeners) l(m.payload);
      else { const w = waiting.get(m.rid); waiting.delete(m.rid); m.error ? w?.err(new Error(m.error)) : w?.ok(m.result); }
    }
  });
  const call = (cmd, args = {}) => new Promise((ok, err) => { const id = ++rid; waiting.set(id, { ok, err }); proc.stdin.write(JSON.stringify({ rid: id, cmd, args }) + '\n'); });
  return { ns, proc, call, on: (cb) => listeners.add(cb), kill: () => proc.kill('SIGKILL') };
}

/** Connects a (offerer) and b over relayed signaling; resolves the selected pair of a, or null on timeout. */
async function connect(a, b, ice, ms = 20_000) {
  const id = `c${Date.now()}`;
  let open = false;
  const trace = [];
  a.on((e) => { if (e.kind === 'state' || e.kind === 'ice') trace.push('a:' + e.kind + ':' + (e.state ?? e.candidate?.candidate ?? '')); });
  b.on((e) => { if (e.kind === 'state' || e.kind === 'ice') trace.push('b:' + e.kind + ':' + (e.state ?? e.candidate?.candidate ?? '')); });
  a.on((e) => { if (e.kind === 'ice') void b.call('rtc_add_ice', { id, candidate: e.candidate }).catch(() => {}); if (e.kind === 'open') open = true; });
  b.on((e) => { if (e.kind === 'ice') void a.call('rtc_add_ice', { id, candidate: e.candidate }).catch(() => {}); });
  await a.call('rtc_create', { id, ice, muxed: true });
  await b.call('rtc_create', { id, ice, muxed: true });
  await a.call('rtc_create_data_channel', { id, label: 'sync' });
  const offer = await a.call('rtc_create_offer', { id });
  await a.call('rtc_set_local', { id, kind: 'offer', sdp: offer });
  await b.call('rtc_set_remote', { id, kind: 'offer', sdp: offer });
  const answer = await b.call('rtc_create_answer', { id });
  await b.call('rtc_set_local', { id, kind: 'answer', sdp: answer });
  await a.call('rtc_set_remote', { id, kind: 'answer', sdp: answer });
  const end = Date.now() + ms;
  while (Date.now() < end && !open) await sleep(200);
  const sdp = await a.call('rtc_local_sdp', { id }).catch((e) => 'error: ' + e.message);
  if (!open) return { connected: false, offerSdp: sdp, trace, id };
  await a.call('rtc_send', { id, label: 'sync', b64: Buffer.from('ping').toString('base64') });
  await sleep(500);
  const stats = await a.call('rtc_stats', { id });
  const by = (type) => stats.find((s) => s.type === type);
  return { connected: true, local: by('local-candidate'), remote: by('remote-candidate'), offerSdp: sdp, id };
}

/** Counts UDP packets on routerA's WAN to its public address and `port` while `fn` runs. */
async function captureWan(port, fn) {
  const file = `/tmp/netlab-${port}.pcap`;
  const cap = spawn('ip', ['netns', 'exec', 'routerA', 'tcpdump', '-n', '-i', 'wan0', '-w', file, `udp and dst host 45.83.220.1 and dst port ${port}`], { stdio: 'ignore' });
  children.push(cap);
  await sleep(800);
  const result = await fn();
  await sleep(500);
  cap.kill('SIGINT');
  await sleep(500);
  const count = Number(sh(`tcpdump -n -r ${file} 2>/dev/null | wc -l`).trim());
  return { result, packets: count };
}

async function upnpUntil(p, states, ms = 15_000) {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) { s = await p.call('upnp_status'); if (states.includes(s.state)) return s; await sleep(250); }
  return s;
}

const results = {};
const turn = [{ urls: ['turn:45.83.220.50:3478?transport=udp'], username: 'dev', credential: 'dev-stack-turn' }];
try {
  topology();

  // 1. Mapped direct, TURN disabled: only the verified same-port mapping can carry traffic.
  {
    const upnpd = startMiniupnpd();
    await sleep(1000);
    const a = peer('hostA'), b = peer('hostB');
    await a.call('upnp_enable');
    const mapping = await upnpUntil(a, ['mapped', 'unsupported', 'failed']);
    const port = Number(String(mapping.external ?? ':0').split(':')[1]);
    const local = (await a.call('listener'))?.local;
    const { result, packets } = await captureWan(port, () => connect(b, a, []));
    results.mappedDirect = { miniupnpdLog: upnpd.log().slice(-1500), mapping, listener: local, connected: result.connected, local: result.local, remote: result.remote, wanPacketsToMappedPort: packets,
      mappedCandidateOffered: /45.83.220.1 \d+ typ srflx/.test(String(result.offerSdp)) || null };
    // Negative control: same topology with the mapping withdrawn.
    await a.call('upnp_disable');
    const control = await connect(peer('hostB'), peer('hostA'), [], 12_000);
    results.mappedDirect.withoutMapping = { connected: control.connected };
    a.kill(); b.kill();
    upnpd.kill('SIGTERM');
    await sleep(500);
  }

  // 2. No-hairpin LAN: both devices behind routerA; the mapping exists but the host pair is used, nothing loops via WAN.
  {
    const upnpd = startMiniupnpd();
    await sleep(1000);
    const a = peer('hostA'), a2 = peer('hostA2');
    await a.call('upnp_enable');
    const mapping = await upnpUntil(a, ['mapped', 'unsupported', 'failed']);
    const port = Number(String(mapping.external ?? ':0').split(':')[1]);
    const { result, packets } = await captureWan(port, () => connect(a2, a, []));
    results.noHairpinLan = { mapping, connected: result.connected, local: result.local, remote: result.remote, wanPacketsToMappedPort: packets };
    a.kill(); a2.kill();
    upnpd.kill('SIGTERM');
    await sleep(500);
  }

  // 3. Unsupported UPnP (no IGD answers): reported as unsupported, TURN carries the connection.
  {
    const turnd = startTurn();
    await sleep(1500);
    const a = peer('hostA'), b = peer('hostB');
    await a.call('upnp_enable');
    const mapping = await upnpUntil(a, ['unsupported', 'failed', 'mapped'], 12_000);
    const result = await connect(b, a, turn, 45_000);
    results.unsupportedUpnp = { mapping, connected: result.connected, local: result.local, remote: result.remote, ...(result.connected ? {} : { offerSdp: result.offerSdp, trace: result.trace, turnLog: turnd.log().split('\n').filter((l) => /peer|permission|channel|forbid|denied|error|unreach|refus|40[0-9]/i.test(l)).slice(-40).join('\n') }) };
    a.kill(); b.kill();

    // 4. Relay only: every direct UDP path between the two sites is blocked; only TURN works.
    nsx('routerA', 'iptables -I FORWARD 1 -i lan0 -o wan0 -p udp ! -d 45.83.220.50 -j DROP');
    nsx('routerB', 'iptables -I FORWARD 1 -i lan0 -o wan0 -p udp ! -d 45.83.220.50 -j DROP');
    const c = peer('hostA'), d = peer('hostB');
    const relay = await connect(d, c, turn, 45_000);
    results.relayOnly = { connected: relay.connected, local: relay.local, remote: relay.remote, ...(relay.connected ? {} : { offerSdp: relay.offerSdp, trace: relay.trace, turnLog: turnd.log().slice(-2000) }) };
    c.kill(); d.kill();
    if (process.env.NETLAB_TURN_LOG) writeFileSync(process.env.NETLAB_TURN_LOG, turnd.log());
    turnd.kill('SIGTERM');
  }
} finally {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

const t = (c) => c?.candidateType;
const checks = [
  ['mapped direct: mapping verified', results.mappedDirect?.mapping?.state === 'mapped'],
  ['mapped direct: connected with TURN disabled', results.mappedDirect?.connected === true],
  ['mapped direct: packets reached the mapped public port', (results.mappedDirect?.wanPacketsToMappedPort ?? 0) > 0],
  ['mapped direct: the remote peer selected the mapped server-reflexive candidate or its peer-reflexive equivalent', ['srflx', 'prflx'].includes(t(results.mappedDirect?.remote)) || ['srflx', 'prflx'].includes(t(results.mappedDirect?.local))],
  ['mapped direct: no connection without the mapping (SOAP success alone is not transport)', results.mappedDirect?.withoutMapping?.connected === false],
  // A LAN peer may first be learned from its checks (prflx) before its host candidate arrives: same LAN address.
  ['no-hairpin LAN: connected over LAN addresses', results.noHairpinLan?.connected === true && [results.noHairpinLan?.local, results.noHairpinLan?.remote].every((c) => ['host', 'prflx'].includes(t(c)) && String(c?.address).startsWith('192.168.10.'))],
  ['no-hairpin LAN: nothing went through the WAN mapping', results.noHairpinLan?.wanPacketsToMappedPort === 0],
  ['unsupported UPnP: reported as not available', ['unsupported', 'failed'].includes(results.unsupportedUpnp?.mapping?.state)],
  ['unsupported UPnP: TURN carries the connection', results.unsupportedUpnp?.connected === true && [t(results.unsupportedUpnp?.local), t(results.unsupportedUpnp?.remote)].includes('relay')],
  ['relay only: connected through TURN', results.relayOnly?.connected === true && [t(results.relayOnly?.local), t(results.relayOnly?.remote)].includes('relay')],
];
let failed = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'ok' : 'not ok'} - ${name}`); if (!ok) failed++; }
process.exit(failed ? 1 : 0);
