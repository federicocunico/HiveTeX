import { Hono } from 'hono';
import * as v from 'valibot';
import { requireAuth } from '../accounts/sessions.js';
import { schema } from '../db/client.js';
import type { Env } from '../deps.js';
import { AppError } from '../errors.js';
import { rateLimit } from '../middleware.js';
import { parseBody } from '../util.js';
import { and, eq } from 'drizzle-orm';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnProvider {
  /** Mints short-lived relay credentials. */
  mint(ttlSec: number): Promise<{ iceServers: IceServer[] }>;
}

/** Whether relay (TURN) credentials were issued, and if not why: reported so a silent STUN-only fallback is visible. */
export interface RelayStatus {
  available: boolean;
  reason: 'ok' | 'not_configured' | 'mint_failed';
}

export const DEFAULT_STUN: IceServer[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];

/** Cloudflare Realtime TURN (free tier): credentials generated via REST with a server-side key. */
export function cloudflareTurn(keyId: string, apiToken: string, fetchFn: typeof fetch = fetch): TurnProvider {
  return {
    async mint(ttl) {
      const res = await fetchFn(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`turn provider ${res.status}`);
      const json = (await res.json()) as { iceServers: IceServer[] | IceServer };
      return { iceServers: Array.isArray(json.iceServers) ? json.iceServers : [json.iceServers] };
    },
  };
}

const TURN_TTL = 3600;

export const turnRoutes = new Hono<Env>();

turnRoutes.post('/', rateLimit('turn', 60, 3600), async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const { projectId } = await parseBody(c, v.object({ projectId: v.string() }));
  const [m] = await deps.db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.projectId, projectId), eq(schema.memberships.userId, u.id)))
    .limit(1);
  if (!m) throw new AppError(403, 'not_member', 'Not a member of this project');
  const perUser = await deps.limiter.hit(`turn-user:${u.id}`, 20, 3600);
  if (!perUser.ok) throw new AppError(429, 'rate_limited', 'Too many requests', { 'Retry-After': String(perUser.retryAfter) });
  let relay: IceServer[] = [];
  let status: RelayStatus = { available: false, reason: 'not_configured' };
  if (deps.turn) {
    try {
      relay = (await deps.turn.mint(TURN_TTL)).iceServers;
      status = relay.length ? { available: true, reason: 'ok' } : { available: false, reason: 'mint_failed' };
    } catch {
      relay = []; // STUN-only still works for most networks; do not fail the request
      status = { available: false, reason: 'mint_failed' };
    }
  }
  return c.json({ iceServers: [...DEFAULT_STUN, ...relay], expiresAt: deps.now().getTime() + TURN_TTL * 1000, relay: status });
});

/**
 * Fixed relay credentials, for providers without a minting API (ExpressTURN, a coturn with a static user). The same
 * username and credential go to every project member's device, so use a relay account that is only good for relaying.
 */
export function staticTurn(cfg: { urls: string[]; username: string; credential: string }): TurnProvider {
  return {
    async mint() {
      return { iceServers: [{ urls: cfg.urls, username: cfg.username, credential: cfg.credential }] };
    },
  };
}

/** All providers at once: the answer has every server that worked, and fails only when none did. */
export function combineTurn(providers: TurnProvider[]): TurnProvider {
  return {
    async mint(ttl) {
      const results = await Promise.allSettled(providers.map((p) => p.mint(ttl)));
      const ok = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.iceServers : []));
      if (ok.length === 0) throw new Error('no relay provider issued credentials');
      return { iceServers: ok };
    },
  };
}

/**
 * The relay configured in the environment: Cloudflare Realtime TURN (`CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN`) and/or a
 * fixed account (`TURN_USERNAME` + `TURN_CREDENTIAL`, with `TURN_URLS` as a comma-separated list or `TURN_SERVER` as
 * `host:port`; the default server is ExpressTURN's free one). Undefined when neither is set.
 */
export function turnFromEnv(env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): TurnProvider | undefined {
  const providers: TurnProvider[] = [];
  if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) providers.push(cloudflareTurn(env.CF_TURN_KEY_ID, env.CF_TURN_API_TOKEN, fetchFn));
  if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    const server = (env.TURN_SERVER ?? 'free.expressturn.com:3478').trim();
    const urls = env.TURN_URLS
      ? env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean)
      : [`turn:${server}?transport=udp`, `turn:${server}?transport=tcp`];
    providers.push(staticTurn({ urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }));
  }
  if (providers.length === 0) return undefined;
  return providers.length === 1 ? (providers[0] as TurnProvider) : combineTurn(providers);
}
