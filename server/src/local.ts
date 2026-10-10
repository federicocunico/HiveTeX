/**
 * Local development / e2e server: embedded Postgres (PGlite, persisted under .data/), in-memory rate limiter,
 * console mailer. Never used in production (Vercel uses ./production.ts).
 */
import { mkdirSync } from 'node:fs';
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
import { MemorySignalBackend, createSignalSession } from './signal/hub.js';
import { WebSocketServer } from 'ws';

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
  const port = opts.port ?? 3000;
  const server = serve({ fetch: app.fetch, port });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  (server as import('node:http').Server).on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/signal') || !deps.signal) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const h = createSignalSession({ send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) }, deps, deps.signal as MemorySignalBackend);
      ws.on('message', (d) => void h.onMessage(String(d)));
      ws.on('close', () => void h.onClose());
    });
  });
  console.log(`hivetex local API on http://localhost:${port}`);
  return { server, deps, close: () => server.close() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startLocal({ dataDir: process.env.MEMORY_DB ? undefined : (process.env.DATA_DIR ?? '.data/pg'), port: Number(process.env.PORT ?? 3000) });
}
