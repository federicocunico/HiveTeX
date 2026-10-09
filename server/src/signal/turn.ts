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
  if (deps.turn) {
    try {
      relay = (await deps.turn.mint(TURN_TTL)).iceServers;
    } catch {
      relay = []; // STUN-only still works for most networks; do not fail the request
    }
  }
  return c.json({ iceServers: [...DEFAULT_STUN, ...relay], expiresAt: deps.now().getTime() + TURN_TTL * 1000 });
});
