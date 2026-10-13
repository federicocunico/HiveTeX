import { configFromEnv } from './config.js';
import { createNeonDb } from './db/client.js';
import type { Deps } from './deps.js';
import { createUpstashKv } from './kv.js';
import { createSmtpMailer, smtpFromEnv } from './mail.js';
import { createUpstashLimiter } from './ratelimit.js';
import { createApplicationRelayRouter } from './signal/application-relay.js';
import { createUpstashSignalBackend, meterSignalBackend, UsageMeter } from './signal/hub.js';
import { createRedisRelayAdmission, type EvalRedis, relayLimitsFromEnv } from './signal/relay-budget.js';
import { turnFromEnv } from './signal/turn.js';

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
  const turn = turnFromEnv(process.env);
  const smtp = smtpFromEnv();
  if (!smtp) throw new Error('Missing env var GMAIL_USER / GMAIL_APP_PASSWORD (or SMTP_HOST)');
  const config = configFromEnv();
  const usage = new UsageMeter();
  const signal = meterSignalBackend(await createUpstashSignalBackend(redisUrl, redisToken), usage);
  const relayLimits = relayLimitsFromEnv(process.env);
  let applicationRelay: Deps['applicationRelay'];
  if (relayLimits) {
    const { Redis } = await import('@upstash/redis');
    // One namespace per deployment environment: preview and production never share an allowance.
    const namespace = process.env.RELAY_NAMESPACE || `${process.env.VERCEL_ENV ?? 'node'}:${config.appOrigin}`;
    const redis = new Redis({ url: redisUrl, token: redisToken });
    const metered: EvalRedis = { eval: (script, keys, args) => { usage.add('relay.budget.eval'); return redis.eval(script, keys, args); } };
    const admission = createRedisRelayAdmission(metered, namespace, relayLimits);
    applicationRelay = createApplicationRelayRouter({ namespace, backend: signal, admission, deps: { config, now: () => new Date() }, meter: usage });
  }
  if (process.env.USAGE_LOG === '1') {
    // One counters-only line per minute and instance; see docs/deployment.md ("Measuring usage").
    setInterval(() => {
      const counts = usage.snapshot();
      if (Object.keys(counts).length) console.info('[usage]', JSON.stringify(counts));
      usage.reset();
    }, 60_000).unref();
  }
  return {
    db: await createNeonDb(need('DATABASE_URL')),
    limiter: await createUpstashLimiter(redisUrl, redisToken),
    mailer: await createSmtpMailer(smtp),
    config,
    now: () => new Date(),
    signal,
    presenceBatchMs: 10_000,
    usage,
    ...(applicationRelay ? { applicationRelay } : {}),
    kv: await createUpstashKv(redisUrl, redisToken),
    ...(process.env.GITHUB_APP_CLIENT_ID && process.env.GITHUB_APP_CLIENT_SECRET
      ? { github: { clientId: process.env.GITHUB_APP_CLIENT_ID, clientSecret: process.env.GITHUB_APP_CLIENT_SECRET } }
      : {}),
    ...(turn ? { turn } : {}),
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
          const h = attach({ get bufferedAmount() { return ws.bufferedAmount; }, send: (d) => ws.send(d), close: (code, reason) => ws.close(code, reason) });
          ws.on('message', (data) => void h.onMessage(String(data)));
          ws.on('close', () => void h.onClose());
        },
        { maxPayload: 64 * 1024 },
      ),
  });
}
