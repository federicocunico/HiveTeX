/**
 * Local development / e2e server: embedded Postgres (PGlite, persisted under .data/), in-memory rate limiter,
 * console mailer. Never used in production (Vercel uses ./production.ts).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { exportJWK, generateKeyPair } from 'jose';
import { buildApp } from './app.js';
import type { Config } from './config.js';
import { type Db, schema } from './db/client.js';
import type { Deps } from './deps.js';
import type { Mailer } from './mail.js';
import { MemoryRateLimiter, UnlimitedRateLimiter } from './ratelimit.js';
import { MemoryKv } from './kv.js';
import { createDevPush } from './dev-push.js';
import { createApplicationRelayRouter } from './signal/application-relay.js';
import { MemorySignalBackend, createSignalSession } from './signal/hub.js';
import { createMemoryRelayAdmission } from './signal/relay-budget.js';
import { turnFromEnv } from './signal/turn.js';
import { WebSocketServer } from 'ws';

/** Dev/e2e fault knobs, set through GET /__dev/faults?relayDrop=0.2 on the local server only. */
export const devFaults = { relayDrop: 0 };

export interface LocalOptions {
  dataDir?: string | undefined; // undefined => in-memory
  port?: number;
  appOrigin?: string;
  log?: boolean;
}

export async function localDeps(opts: LocalOptions = {}): Promise<Deps & { mailbox: { to: string; subject: string; text: string }[] }> {
  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });
  const client = new PGlite(opts.dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  // APP_ORIGIN lets a second checkout run its dev page (and e2e) on another port alongside the default one.
  const appOrigin = opts.appOrigin ?? process.env.APP_ORIGIN ?? 'http://localhost:1420';
  const config: Config = {
    appOrigin,
    extraOrigins: ['tauri://localhost', 'http://tauri.localhost', 'http://localhost:1420', appOrigin],
    cookieSecure: false,
    ticketPrivateJwk: JSON.stringify(await exportJWK(privateKey)),
    ticketKid: 'dev',
    ticketPublicJwks: [{ kid: 'dev', jwk: { ...(await exportJWK(publicKey)), alg: 'EdDSA', use: 'sig', kid: 'dev' } }],
    argon: { memoryCost: 8192, timeCost: 2, parallelism: 1 },
    breachedCheck: false,
    // Rings stay on this machine: the dev server's own push endpoint, unless DOORBELL_URL names another (or is 'off').
    ...(process.env.DOORBELL_URL === 'off' ? {} : { doorbellUrl: process.env.DOORBELL_URL || `http://localhost:${opts.port ?? Number(process.env.PORT ?? 3000)}/__dev/push` }),
  };
  const mailbox: { to: string; subject: string; text: string }[] = [];
  const mailer: Mailer = {
    async send(m) {
      mailbox.push(m);
      if (opts.log !== false) console.log(`[mail] to=${m.to} subject=${m.subject}\n${m.text}\n`);
    },
  };
  const out: Deps & { mailbox: typeof mailbox } = {
    db: db as unknown as Db,
    limiter: process.env.E2E_NO_LIMITS ? new UnlimitedRateLimiter() : new MemoryRateLimiter(),
    mailer,
    config,
    now: () => new Date(),
    mailbox,
    signal: new MemorySignalBackend(),
    kv: new MemoryKv(),
  };
  // TURN_USERNAME/TURN_CREDENTIAL/TURN_SERVER (or CF_TURN_*) give the local server the same relay as production.
  const turn = turnFromEnv(process.env);
  if (turn) out.turn = turn;
  if (process.env.APPLICATION_RELAY === '1') {
    // Dev/e2e only: in-process budget with the shipped limits (deployments use the Redis budget, see production.ts).
    const router = createApplicationRelayRouter({ namespace: 'local', backend: out.signal as MemorySignalBackend, admission: createMemoryRelayAdmission(), deps: out });
    // Dev/e2e fault injection (13.7): `devFaults.relayDrop` silently loses that share of relayed ciphertext frames.
    out.applicationRelay = {
      async attach(ctx) {
        const r = await router.attach(ctx);
        return { forward: (m) => (Math.random() < devFaults.relayDrop ? Promise.resolve() : r.forward(m)), close: () => r.close() };
      },
    };
  }
  if (process.env.E2E_FAKE_GITHUB) {
    // End-to-end tests: pretend to be GitHub's OAuth endpoints so the whole connect flow can run offline.
    out.github = { clientId: 'e2e-client', clientSecret: 'e2e-secret' };
    out.fetch = (async (url: string) => {
      if (url === 'https://github.com/login/oauth/access_token')
        return new Response(JSON.stringify({ access_token: 'ghu_E2E_TOKEN', refresh_token: 'ghr_E2E_REFRESH', expires_in: 28800 }));
      if (url === 'https://api.github.com/user') return new Response(JSON.stringify({ login: 'e2e-user', id: 4242 }));
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;
  }
  return out;
}

export async function startLocal(opts: LocalOptions = {}) {
  const deps = await localDeps(opts);
  const app = buildApp(deps);
  // Dev-only: expose the mailbox so e2e tests can read verification/reset links.
  app.get('/__dev/mailbox', (c) => c.json(deps.mailbox));
  app.get('/__dev/faults', (c) => {
    const drop = Number(c.req.query('relayDrop'));
    if (Number.isFinite(drop) && drop >= 0 && drop < 1) devFaults.relayDrop = drop;
    return c.json(devFaults);
  });
  // Every signaling subscription stops receiving, as an Upstash stream that ended; `?silent=1` hides it from the sessions
  // (the production failure before subscriptions reported their loss: sockets stay open, nothing arrives).
  app.get('/__dev/signal/lose-subscriptions', (c) =>
    c.json({ lost: (deps.signal as MemorySignalBackend).loseSubscriptions(c.req.query('silent') !== '1') }));
  // Ends every signaling socket abruptly, as the platform does at the 300 s rotation or when an instance goes away.
  app.get('/__dev/signal/terminate', (c) => {
    let n = 0;
    for (const ws of wss.clients) { ws.terminate(); n++; }
    return c.json({ terminated: n });
  });
  const port = opts.port ?? 3000;
  // Dev-only push service for doorbell rings (dev-push.ts), outside the /api app (no CSRF guard, like ntfy); localDeps
  // points config.doorbellUrl at it.
  const push = createDevPush().app;
  // Dev/soak only: REQUEST_LOG=<file> appends one JSON line per request and WebSocket upgrade (time, method, path,
  // origin, user agent), to measure control-plane traffic from idle devices (verification 13.2). No bodies or tokens.
  const requestLog = process.env.REQUEST_LOG;
  const logRequest = (m: string, path: string, origin: string | null | undefined, ua: string | null | undefined) => {
    if (requestLog) appendFileSync(requestLog, JSON.stringify({ t: Date.now(), m, path, origin: origin ?? null, ua: ua ?? null }) + '\n');
  };
  const fetch = (req: Request) => {
    const url = new URL(req.url);
    logRequest(req.method, url.pathname, req.headers.get('origin'), req.headers.get('user-agent'));
    if (!url.pathname.startsWith('/__dev/push/')) return app.fetch(req);
    url.pathname = url.pathname.slice('/__dev/push'.length);
    return push.fetch(new Request(url, req));
  };
  // Dev/test only: SIGNAL_LOG=<file> appends one JSON line per signaling socket event and message routed in or out
  // (type, short device ids, ack, presence, error code), never envelopes, tickets or signatures.
  const signalLog = process.env.SIGNAL_LOG;
  let socketSeq = 0;
  const short = (v: unknown) => (typeof v === 'string' ? v.slice(0, 8) : undefined);
  const logSignal = (conn: number, dir: string, raw: unknown) => {
    if (!signalLog) return;
    let m: Record<string, unknown> = {};
    try { m = typeof raw === 'string' ? JSON.parse(raw) : {}; } catch { m = { t: 'unparsable' }; }
    const e = { t: Date.now(), conn, dir, type: m.t, from: short(m.from), to: short(m.to), dev: short(m.dev), ack: m.ack === undefined ? undefined : String(m.ack).slice(0, 12), online: m.online, code: m.code, others: Array.isArray(m.tickets) ? m.tickets.length : undefined, bytes: typeof raw === 'string' ? raw.length : undefined };
    appendFileSync(signalLog, JSON.stringify(e) + '\n');
  };
  const server = serve({ fetch, port });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  (server as import('node:http').Server).on('upgrade', (req, socket, head) => {
    logRequest('WS', (req.url ?? '').split('?')[0] ?? '', req.headers.origin, req.headers['user-agent']);
    if (!req.url?.startsWith('/api/signal') || !deps.signal) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = ++socketSeq;
      if (signalLog) appendFileSync(signalLog, JSON.stringify({ t: Date.now(), conn, dir: 'open', ua: req.headers['user-agent'] ?? null, addr: req.socket.remoteAddress ?? null }) + '\n');
      const h = createSignalSession({ get bufferedAmount() { return ws.bufferedAmount; }, send: (d) => { logSignal(conn, 'out', d); ws.send(d); }, close: (c, r) => { if (signalLog) appendFileSync(signalLog, JSON.stringify({ t: Date.now(), conn, dir: 'server-close', code: c, reason: r }) + '\n'); ws.close(c, r); } }, deps, deps.signal as MemorySignalBackend);
      ws.on('message', (d) => { logSignal(conn, 'in', String(d)); void h.onMessage(String(d)); });
      ws.on('close', (code) => { if (signalLog) appendFileSync(signalLog, JSON.stringify({ t: Date.now(), conn, dir: 'closed', code }) + '\n'); void h.onClose(); });
    });
  });
  console.log(`hivetex local API on http://localhost:${port}`);
  return { server, deps, close: () => server.close() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startLocal({ dataDir: process.env.MEMORY_DB ? undefined : (process.env.DATA_DIR ?? '.data/pg'), port: Number(process.env.PORT ?? 3000) });
}
