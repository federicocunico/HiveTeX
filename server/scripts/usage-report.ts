/**
 * Reproducible signaling/relay usage report (task 2.6, design D13). Runs real signal sessions and the real relay router and
 * budget client against a metered in-memory backend, counts every backend command per scenario, then extrapolates to a
 * 30-day window for always-on desktop seeds. Run: `pnpm --filter @hivetex/server exec tsx scripts/usage-report.ts`.
 *
 * What is measured: backend commands per heartbeat, per 300 s socket rotation, per relayed envelope (data and ACK), per
 * budget grant. What is assumed (printed in the report): Upstash bills every command including EVAL and each pub/sub
 * delivery; Vercel bills one invocation per WebSocket. CPU time, bandwidth pricing and provider-side overheads are not
 * measured here and must be checked on the real dashboards before enabling the relay profile.
 */
import { sign, toB64u } from '@hivetex/crypto';
import { APPLICATION_RELAY_CAPABILITY, signalAuthMessage } from '@hivetex/protocol';
import { ConnectionManager, MemoryPersistence, Mesh, ProjectModel, type WebSocketLike } from '@hivetex/sync';
import { FakeRtcNetwork, inProcessSocket } from '@hivetex/sync/testing';
import { identity, TestAuthority, type TestIdentity } from '@hivetex/sync/testkit';
import type { Deps } from '../src/deps.js';
import { createApplicationRelayRouter } from '../src/signal/application-relay.js';
import { createSignalSession, MemorySignalBackend, meterSignalBackend, type SignalBackend, UsageMeter } from '../src/signal/hub.js';
import { createRedisRelayAdmission, DEFAULT_RELAY_LIMITS, type EvalRedis } from '../src/signal/relay-budget.js';

const DAY = 24 * 3600;
const WINDOW_DAYS = 30;
const HEARTBEAT_S = 30;
const SOCKET_S = 300;
const UPSTASH_FREE_COMMANDS = 500_000; // per month, https://upstash.com/pricing/redis (checked 2026-10-11)
const VERCEL_HOBBY_INVOCATIONS = 1_000_000; // per month, Vercel Hobby
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** Counts pub/sub deliveries too: a published message costs one delivery per subscriber. */
function meteredBackend(meter: UsageMeter): SignalBackend {
  const inner = meterSignalBackend(new MemorySignalBackend(), meter);
  return { ...inner, subscribe: (channel, cb) => inner.subscribe(channel, m => { meter.add('signal.delivery'); cb(m); }) };
}
function meteredAdmission(meter: UsageMeter) {
  const grants: EvalRedis = {
    async eval(_s, _k, args) { meter.add('relay.budget.eval'); return args[0] === 'acquire' ? [1, 300_000] : [1, 5_000]; },
  };
  return createRedisRelayAdmission(grants, 'report', DEFAULT_RELAY_LIMITS);
}

interface Client { id: TestIdentity; inbox: Array<Record<string, unknown>>; say(m: unknown): Promise<void>; close(): Promise<void>; sid(): string }
async function client(auth: TestAuthority, deps: Deps, backend: SignalBackend, id: TestIdentity, pid: string, relay: boolean): Promise<Client> {
  const inbox: Array<Record<string, unknown>> = [];
  const s = createSignalSession({ bufferedAmount: 0, send: raw => { inbox.push(JSON.parse(raw)); }, close: () => {} }, deps, backend);
  const ticket = await auth.mint({ ...id, pid });
  const proof = await sign(id.keys, new TextEncoder().encode(signalAuthMessage(pid, id.dev, inbox[0]!.nonce as string)));
  await s.onMessage(JSON.stringify({ t: 'auth', ticket, sig: toB64u(proof), ...(relay ? { capabilities: [APPLICATION_RELAY_CAPABILITY] } : {}) }));
  await tick(5);
  const ready = inbox.find(m => m.t === 'ready');
  if (!ready) throw new Error('session did not become ready');
  return { id, inbox, say: m => s.onMessage(JSON.stringify(m)), close: () => s.onClose(), sid: () => String(ready.sid ?? '') };
}

async function measure(label: string, run: (env: { auth: TestAuthority; meter: UsageMeter; deps: (batchMs: number, relay?: boolean) => Deps; backend: SignalBackend }) => Promise<number>) {
  const auth = await TestAuthority.create();
  const meter = new UsageMeter();
  const backend = meteredBackend(meter);
  const deps = (batchMs: number, relay = false) => {
    const d = { now: () => new Date(), config: { ticketPublicJwks: auth.trusted }, presenceBatchMs: batchMs } as unknown as Deps;
    if (relay) d.applicationRelay = createApplicationRelayRouter({ namespace: 'report', backend, admission: meteredAdmission(meter), deps: d, meter });
    return d;
  };
  const units = await run({ auth, meter, deps, backend });
  const counts = meter.snapshot();
  const commands = Object.entries(counts).filter(([k]) => !k.endsWith('.entries') && !k.startsWith('relay.forwarded') && !k.startsWith('relay.delivered') && !k.startsWith('relay.error')).reduce((a, [, v]) => a + v, 0);
  return { label, units, counts, perUnit: commands / units };
}

/**
 * One doorbell introduction (D14) with the real connection managers and hub: a newcomer rings, a dormant device answers,
 * both link and close their sockets. Measures backend commands and socket-seconds (provisioned memory on Vercel).
 */
async function introduction() {
  const auth = await TestAuthority.create();
  const meter = new UsageMeter();
  const backend = meteredBackend(meter);
  const deps = { now: () => new Date(), config: { ticketPublicJwks: auth.trusted }, presenceBatchMs: 0 } as unknown as Deps;
  const rtc = new FakeRtcNetwork();
  let socketMs = 0, sockets = 0;
  const device = async (name: string) => {
    const id = await identity(name, 'editor');
    const ticket = await auth.mint({ ...id, pid: 'p' });
    const model = new ProjectModel(new MemoryPersistence(), { flushMs: 5 });
    await model.init();
    const mesh = new Mesh({ projectId: 'p', model, keys: id.keys, trusted: auth.trusted, getTicket: () => ticket });
    const peers: Array<() => void> = [];
    const mgr = new ConnectionManager({
      mesh, projectId: 'p', keys: id.keys, trusted: auth.trusted, getTicket: () => ticket, signalUrl: 'ws://report',
      wsFactory: () => {
        sockets++;
        const opened = Date.now();
        const ws: WebSocketLike = inProcessSocket((sock) => createSignalSession(sock, deps, backend));
        const close = ws.close.bind(ws);
        let done = false;
        ws.close = (...a) => { if (!done) { done = true; socketMs += Date.now() - opened; } close(...a); };
        return ws;
      },
      rtcFactory: rtc.factory, getIceServers: async () => [], idleCloseMs: 50,
      doorbell: { ring: async () => { for (const answer of peers) answer(); return true; } },
    });
    return { mesh, mgr, peers };
  };
  const seed = await device('seed');
  const newcomer = await device('newcomer');
  newcomer.peers.push(() => seed.mgr.answerRing()); // the push service delivering the ring
  seed.mgr.setDoorbellAvailable(true);
  newcomer.mgr.setDoorbellAvailable(true);
  seed.mgr.start();
  // The seed introduces itself once when it starts alone; measure only after it went dormant again.
  await tick(50);
  while (seed.mgr.socketOpen) await tick(50);
  meter.reset(); socketMs = 0; sockets = 0;
  const started = Date.now();
  newcomer.mgr.start();
  while (!(seed.mesh.peers.length === 1 && newcomer.mesh.peers.length === 1)) await tick(10);
  const linkedMs = Date.now() - started;
  while (seed.mgr.socketOpen || newcomer.mgr.socketOpen) await tick(20);
  const counts = meter.snapshot();
  seed.mgr.stop(); newcomer.mgr.stop(); seed.mesh.destroy(); newcomer.mesh.destroy();
  const commands = Object.entries(counts).filter(([k]) => !k.endsWith('.entries')).reduce((a, [, v]) => a + v, 0);
  return { counts, commands, sockets, socketSeconds: socketMs / 1000, linkedMs };
}

const PROJECTS = 4;
async function main() {
  const rounds = 20;
  // Idle seed: one device, four projects, one remote peer per project, heartbeats only (after setup).
  const heartbeat = async (batchMs: number) => measure(`heartbeat (${batchMs ? 'co-located, batched' : 'distributed'})`, async ({ auth, meter, deps, backend }) => {
    const d = deps(batchMs);
    const seed = await identity('seed', 'owner');
    const sessions: Client[] = [];
    for (let p = 0; p < PROJECTS; p++) {
      // Distributed: each project's socket on its own instance, i.e. its own renewal batcher.
      const b = batchMs ? backend : meteredBackend(meter);
      sessions.push(await client(auth, d, b, seed, 'p' + p, false));
    }
    meter.reset();
    for (let r = 0; r < rounds; r++) {
      await Promise.all(sessions.map(s => s.say({ t: 'ping' })));
      await tick(batchMs + 5);
    }
    return rounds * PROJECTS;
  });
  const colocated = await heartbeat(20);
  const distributed = await heartbeat(0);

  // One 300 s socket rotation of a seed's project socket with one other peer online.
  const rotation = await measure('socket rotation (connect + close, one peer online)', async ({ auth, meter, deps, backend }) => {
    const d = deps(0, true);
    const peer = await client(auth, d, backend, await identity('peer', 'editor'), 'p', true);
    const seed = await identity('seed', 'owner');
    meter.reset();
    const n = 10;
    for (let i = 0; i < n; i++) { const c = await client(auth, d, backend, seed, 'p', true); await c.close(); }
    await peer.close();
    return n;
  });

  // Relayed traffic: data envelopes from seed to peer, each acknowledged by one ACK envelope.
  const relay = await measure('relayed envelope (data or ACK)', async ({ auth, meter, deps, backend }) => {
    const d = deps(0, true);
    const a = await client(auth, d, backend, await identity('a', 'editor'), 'p', true);
    const b = await client(auth, d, backend, await identity('b', 'editor'), 'p', true);
    meter.reset();
    const n = 200;
    const env = 'A'.repeat(22 * 1024); // ~16 KiB plaintext after AES-GCM + base64url
    for (let i = 0; i < n; i++) {
      await a.say({ t: 'app-relay', to: b.id.dev, sid: b.sid(), env });
      await b.say({ t: 'app-relay', to: a.id.dev, sid: a.sid(), env: 'A'.repeat(200) });
    }
    await tick(20);
    return 2 * n;
  });

  const perMonth = (perUnit: number, unitsPerMonth: number) => Math.round(perUnit * unitsPerMonth);
  const heartbeatsPerMonth = PROJECTS * (WINDOW_DAYS * DAY / HEARTBEAT_S);
  const rotationsPerMonth = PROJECTS * (WINDOW_DAYS * DAY / SOCKET_S);
  const idleColocated = perMonth(colocated.perUnit, heartbeatsPerMonth) + perMonth(rotation.perUnit, rotationsPerMonth);
  const idleDistributed = perMonth(distributed.perUnit, heartbeatsPerMonth) + perMonth(rotation.perUnit, rotationsPerMonth);
  const mib = 1024 * 1024;
  const envelopesPerMiB = Math.ceil(mib / (16 * 1024)) * 2; // data + ACK
  const relayPerMiB = relay.perUnit * envelopesPerMiB;

  const intro = await introduction();
  const GB = 2; // Vercel default function memory
  // Ring endpoint: one invocation; the in-memory limiter stands for Upstash Ratelimit (about 2 commands per limiter, 3 limiters).
  const ringCommands = 6;
  const perIntro = {
    invocations: 1 + intro.sockets,
    gbh: (intro.socketSeconds * GB) / 3600,
    commands: intro.commands + ringCommands,
    push: 1,
  };
  const free = { invocations: VERCEL_HOBBY_INVOCATIONS, gbh: 360, commands: UPSTASH_FREE_COMMANDS };
  const introsPerMonth = Math.floor(Math.min(free.invocations / perIntro.invocations, free.gbh / perIntro.gbh, free.commands / perIntro.commands));
  const gatekeeper = { invocations: WINDOW_DAYS * DAY / SOCKET_S, gbh: WINDOW_DAYS * 24 * GB, commands: perMonth(distributed.perUnit, WINDOW_DAYS * DAY / HEARTBEAT_S) + perMonth(rotation.perUnit, WINDOW_DAYS * DAY / SOCKET_S) };
  const lines = [
    '# Relay and idle-seed usage report',
    '',
    `Generated by \`server/scripts/usage-report.ts\` on ${new Date().toISOString().slice(0, 10)}. Counts are measured backend calls of the real`,
    'signal hub, relay router and budget client; monthly figures are extrapolations for a 30-day window.',
    '',
    '## Measured commands per unit',
    '',
    '| Scenario | Units | Commands per unit | Breakdown |',
    '| --- | ---: | ---: | --- |',
    ...[colocated, distributed, rotation, relay].map(m => `| ${m.label} | ${m.units} | ${m.perUnit.toFixed(2)} | ${Object.entries(m.counts).map(([k, v]) => `${k}=${v}`).join(', ')} |`),
    '',
    `## Four always-on projects, one desktop seed, ${WINDOW_DAYS} days, no content`,
    '',
    '| Item | Co-located sessions | Distributed sessions |',
    '| --- | ---: | ---: |',
    `| Heartbeats (${HEARTBEAT_S} s) | ${perMonth(colocated.perUnit, heartbeatsPerMonth).toLocaleString('en')} | ${perMonth(distributed.perUnit, heartbeatsPerMonth).toLocaleString('en')} |`,
    `| Socket rotations (${SOCKET_S} s) | ${perMonth(rotation.perUnit, rotationsPerMonth).toLocaleString('en')} | ${perMonth(rotation.perUnit, rotationsPerMonth).toLocaleString('en')} |`,
    `| **Redis commands** | **${idleColocated.toLocaleString('en')}** | **${idleDistributed.toLocaleString('en')}** |`,
    `| Share of Upstash free tier (${UPSTASH_FREE_COMMANDS.toLocaleString('en')}) | ${(100 * idleColocated / UPSTASH_FREE_COMMANDS).toFixed(0)} % | ${(100 * idleDistributed / UPSTASH_FREE_COMMANDS).toFixed(0)} % |`,
    `| Vercel WebSocket invocations | ${rotationsPerMonth.toLocaleString('en')} | ${rotationsPerMonth.toLocaleString('en')} |`,
    `| Share of Vercel Hobby invocations (${VERCEL_HOBBY_INVOCATIONS.toLocaleString('en')}) | ${(100 * rotationsPerMonth / VERCEL_HOBBY_INVOCATIONS).toFixed(1)} % | same |`,
    '',
    '## Relayed content',
    '',
    `- ${relay.perUnit.toFixed(2)} commands per relayed envelope (publish, recipient delivery, sender and recipient presence checks, budget grants amortised over four envelopes).`,
    `- 1 MiB of payload = ${envelopesPerMiB} envelopes including ACKs = **~${Math.round(relayPerMiB)} Redis commands** plus the encoded bytes on ingress, backend and egress (debited 3x).`,
    `- The shipped profile cap (${DEFAULT_RELAY_LIMITS.envelopes.toLocaleString('en')} envelopes / 30 days) alone allows ~${Math.round(DEFAULT_RELAY_LIMITS.envelopes * relay.perUnit).toLocaleString('en')} commands.`,
    '',
    '## Doorbell (D14) versus a held socket',
    '',
    `Measured introduction: ${intro.sockets} sockets open ${intro.socketSeconds.toFixed(1)} s in total, link after ${intro.linkedMs} ms (in-process, no network latency); backend commands: ${Object.entries(intro.counts).map(([k, v]) => `${k}=${v}`).join(', ')}.`,
    '',
    '| Per 30 days | Invocations | GB-hours (2 GB) | Redis commands | Push messages |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| One open project kept reachable by a gatekeeper socket (today) | ${Math.round(gatekeeper.invocations).toLocaleString('en')} | ${gatekeeper.gbh.toLocaleString('en')} (if no other socket shares the instance) | ${gatekeeper.commands.toLocaleString('en')} | 0 |`,
    '| One idle device in doorbell mode (any number of projects) | 0 | 0 | 0 | 0 (one subscription held at the push service) |',
    `| One introduction (ring, answer, link, sockets closed) | ${perIntro.invocations} | ${perIntro.gbh.toFixed(4)} | ${perIntro.commands} | ${perIntro.push} |`,
    '',
    `Free tier (${free.invocations.toLocaleString('en')} invocations, ${free.gbh} GB-h, ${free.commands.toLocaleString('en')} commands) ≈ **${introsPerMonth.toLocaleString('en')} introductions per month**, independent of how many devices are installed or idle. Tickets of connected peers (one request per ~12 minutes while connected), project API calls and relayed traffic come on top.`,
    '',
    '## Assumptions and limits of this report',
    '',
    '- Upstash counts every command, EVAL included, and each pub/sub delivery; the in-memory backend reproduces the command sequence, not network latency.',
    '- One WebSocket per project and device; the socket is replaced every 300 s (vercel.json). Vercel Active CPU and memory time are not measured here.',
    '- Ticket refreshes, joins of other peers, peer exchange, project API calls and the other application traffic come on top.',
    '- Co-location depends on the platform routing sockets of one device to one instance; it is not guaranteed. Size for the distributed column.',
    '- Provisioned memory: Vercel bills an instance for as long as any request on it is in flight (Fluid compute pricing, checked 2026-10-12). Sockets of different users can share an instance, so the gatekeeper figure is the cost of the first always-open socket, not of each one.',
    '- ntfy.sh is free; its own limits (about 30 subscriptions and 250 messages per day per IP) apply to the devices and ringers, not to this server.',
  ];
  console.log(lines.join('\n'));
}

await main();
// Open sessions keep ticket-expiry timers alive.
process.exit(0);
