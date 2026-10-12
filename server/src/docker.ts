/**
 * Entry point for the local docker stack (docker-compose.yml): the *production* dependency wiring (Neon HTTP driver,
 * Upstash REST, SMTP) pointed at local emulators, served by a plain Node server with the same WebSocket signaling as
 * Vercel. Never used on Vercel (api/index.ts → createApp → productionDeps).
 */
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { exportJWK, generateKeyPair } from 'jose';
import { WebSocketServer } from 'ws';
import { buildApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { productionDepsWith } from './production.js';
import { UnlimitedRateLimiter } from './ratelimit.js';
import { createSignalSession } from './signal/hub.js';

/** Dev stack only: an ephemeral ticket key when none is configured (tickets just stop verifying after a restart). */
export async function ensureDevTicketKey(env: NodeJS.ProcessEnv = process.env) {
  if (env.TICKET_SIGNING_JWK) return false;
  if (env.HIVETEX_DEV_STACK !== '1') throw new Error('TICKET_SIGNING_JWK is required');
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const kid = env.TICKET_KID ?? 'dev';
  env.TICKET_KID = kid;
  env.TICKET_SIGNING_JWK = JSON.stringify(await exportJWK(privateKey));
  env.TICKET_PUBLIC_JWKS = JSON.stringify([{ kid, jwk: { ...(await exportJWK(publicKey)), alg: 'EdDSA', use: 'sig', kid } }]);
  return true;
}

export async function startDocker(port = Number(process.env.PORT ?? 3000)) {
  if (await ensureDevTicketKey()) console.log('[stack] using an ephemeral ticket signing key');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  for (let attempt = 1; ; attempt++) {
    try {
      await runMigrations(url);
      break;
    } catch (e) {
      if (attempt >= 30) throw e;
      console.log(`[stack] database not ready (${e instanceof Error ? e.message : e}); retrying`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const pending = new Set<Promise<unknown>>();
  const deps = await productionDepsWith({
    background: (work) => {
      pending.add(work);
      void work.catch((e) => console.error('[stack] background task failed', e)).finally(() => pending.delete(work));
    },
  });
  // End-to-end runs register many accounts from one IP: same switch as the embedded dev server (never set on Vercel).
  if (process.env.E2E_NO_LIMITS === '1') {
    deps.limiter = new UnlimitedRateLimiter();
    console.log('[stack] rate limits disabled (E2E_NO_LIMITS=1)');
  }
  const app = buildApp(deps);
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  (server as import('node:http').Server).on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/signal') || !deps.signal) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const h = createSignalSession({ get bufferedAmount() { return ws.bufferedAmount; }, send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) }, deps, deps.signal as NonNullable<typeof deps.signal>);
      ws.on('message', (d) => void h.onMessage(String(d)));
      ws.on('close', () => void h.onClose());
    });
  });
  console.log(`[stack] HiveTeX API (production wiring) on http://0.0.0.0:${port}`);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await startDocker();
