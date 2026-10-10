import { configFromEnv } from './config.js';
import { createNeonDb } from './db/client.js';
import type { Deps } from './deps.js';
import { createUpstashKv } from './kv.js';
import { createSmtpMailer, smtpFromEnv } from './mail.js';
import { createUpstashLimiter } from './ratelimit.js';
import { createUpstashSignalBackend } from './signal/hub.js';
import { cloudflareTurn } from './signal/turn.js';

/** The first set variable among `names` (aliases, e.g. the names a Vercel Marketplace integration uses). */
function need(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`Missing env var ${names.join(' (or ')}${names.length > 1 ? ')' : ''}`);
}

/** What differs between hosting platforms (Vercel Functions vs a plain Node server). */
export type PlatformDeps = Pick<Deps, 'upgradeWebSocket' | 'background'>;

/**
 * Production wiring from the environment: Neon (HTTP), Upstash (REST), SMTP, optional GitHub/TURN. The local docker
 * stack runs this same code against emulators via NEON_HTTP_ENDPOINT / Upstash URL / SMTP_HOST (see docs/local-stack.md).
 */
export async function productionDepsWith(platform: PlatformDeps): Promise<Deps> {
  // The Vercel Marketplace Upstash integration sets KV_REST_API_*; a manual setup usually uses UPSTASH_REDIS_REST_*.
  const redisUrl = need('UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL');
  const redisToken = need('UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN');
  const turnKey = process.env.CF_TURN_KEY_ID;
  const turnToken = process.env.CF_TURN_API_TOKEN;
  const smtp = smtpFromEnv();
  if (!smtp) throw new Error('Missing env var GMAIL_USER / GMAIL_APP_PASSWORD (or SMTP_HOST)');
  return {
    db: await createNeonDb(need('DATABASE_URL')),
    limiter: await createUpstashLimiter(redisUrl, redisToken),
    mailer: await createSmtpMailer(smtp),
    config: configFromEnv(),
    now: () => new Date(),
    signal: await createUpstashSignalBackend(redisUrl, redisToken),
    kv: await createUpstashKv(redisUrl, redisToken),
    ...(process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET
      ? { github: { clientId: process.env.GITHUB_APP_CLIENT_ID, clientSecret: process.env.GITHUB_APP_CLIENT_SECRET } }
      : {}),
    ...(turnKey && turnToken ? { turn: cloudflareTurn(turnKey, turnToken) } : {}),
    ...platform,
  };
}

/** Vercel Functions: `waitUntil` for background work and the platform WebSocket upgrade. */
export async function productionDeps(): Promise<Deps> {
  const { experimental_upgradeWebSocket, waitUntil } = await import('@vercel/functions');
  return productionDepsWith({
    background: (work) => waitUntil(work),
    upgradeWebSocket: (_req, attach) =>
      experimental_upgradeWebSocket(
        (ws) => {
          const h = attach({ send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason) });
          ws.on('message', (data) => void h.onMessage(String(data)));
          ws.on('close', () => void h.onClose());
        },
        { maxPayload: 64 * 1024 },
      ),
  });
}
