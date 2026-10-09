import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Deps, Env } from '../deps.js';
import { schema } from '../db/client.js';
import { AppError } from '../errors.js';
import { randomId, randomToken, sha256 } from '../util.js';

export const SESSION_IDLE_MS = 30 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 3600 * 1000;

export const cookieName = (secure: boolean) => (secure ? '__Host-p2p_session' : 'p2p_session');

export async function createSession(deps: Deps, userId: string, kind: 'web' | 'desktop') {
  const token = randomToken(32);
  await deps.db.insert(schema.sessions).values({
    id: randomId(),
    userId,
    tokenHash: sha256(token),
    kind,
    createdAt: deps.now(),
    lastSeenAt: deps.now(),
  });
  return token;
}

export function attachSession(c: Context<Env>, token: string, kind: 'web' | 'desktop') {
  const cfg = c.get('deps').config;
  if (kind === 'web') {
    setCookie(c, cookieName(cfg.cookieSecure), token, {
      httpOnly: true,
      secure: cfg.cookieSecure,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_IDLE_MS / 1000,
    });
    return null;
  }
  return token;
}

export function clearSessionCookie(c: Context<Env>) {
  deleteCookie(c, cookieName(c.get('deps').config.cookieSecure), { path: '/', secure: c.get('deps').config.cookieSecure });
}

export function extractToken(c: Context<Env>): string | undefined {
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return getCookie(c, cookieName(c.get('deps').config.cookieSecure));
}

export async function revokeAllSessions(deps: Deps, userId: string, exceptId?: string) {
  const rows = await deps.db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
  for (const r of rows) {
    if (r.id === exceptId) continue;
    await deps.db.update(schema.sessions).set({ revokedAt: deps.now() }).where(eq(schema.sessions.id, r.id));
  }
}

/** Resolves the session from the request and loads user into context. Throws 401 if absent/expired/revoked. */
export async function requireAuth(c: Context<Env>) {
  const deps = c.get('deps');
  const token = extractToken(c);
  if (!token) throw new AppError(401, 'unauthenticated', 'Sign in required');
  const [row] = await deps.db
    .select({ s: schema.sessions, u: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.sessions.tokenHash, sha256(token)))
    .limit(1);
  const now = deps.now().getTime();
  if (!row || row.s.revokedAt || now - row.s.lastSeenAt.getTime() > SESSION_IDLE_MS) {
    throw new AppError(401, 'unauthenticated', 'Sign in required');
  }
  if (now - row.s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await deps.db.update(schema.sessions).set({ lastSeenAt: deps.now() }).where(eq(schema.sessions.id, row.s.id));
  }
  c.set('user', row.u);
  c.set('session', { id: row.s.id, kind: row.s.kind as 'web' | 'desktop', reauthAt: row.s.reauthAt });
  return row;
}
