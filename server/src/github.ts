import { generateDeviceKeys, seal } from '@p2platex/crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as v from 'valibot';
import { requireAuth } from './accounts/sessions.js';
import { schema } from './db/client.js';
import type { Env } from './deps.js';
import { AppError } from './errors.js';
import { rateLimit } from './middleware.js';
import { parseBody, randomToken } from './util.js';

/**
 * GitHub App user-to-server OAuth. The control plane exchanges the code (it holds the client secret) but
 * never keeps the tokens: they are sealed to the requesting device's public key, parked for two minutes under
 * a one-time hand-off id, and consumed once. Only the GitHub login/id link is stored.
 *
 * The exchange happens only for the signed-in user who started the flow (see /callback and /complete), so a
 * forwarded authorization link cannot deliver someone else's token to the account that created it.
 */
const STATE_TTL = 600;
const HANDOFF_TTL = 180;

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
}

export const githubRoutes = new Hono<Env>();

function cfg(c: { get(k: 'deps'): import('./deps.js').Deps }) {
  const d = c.get('deps');
  if (!d.github || !d.kv) throw new AppError(501, 'not_configured' as never, 'GitHub backup is not configured on this server');
  return { d, github: d.github, kv: d.kv, f: d.fetch ?? fetch };
}

githubRoutes.post('/start', rateLimit('gh-start', 20, 3600), async (c) => {
  const { d, github, kv } = cfg(c);
  const { u } = await requireAuth(c);
  const body = await parseBody(c, v.object({ handoff: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{16,64}$/)), pub: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)) }));
  const state = randomToken(24);
  await kv.set(`gh:state:${state}`, JSON.stringify({ userId: u.id, handoff: body.handoff, pub: body.pub }), STATE_TTL);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', github.clientId);
  url.searchParams.set('redirect_uri', `${d.config.appOrigin}/api/github/callback`);
  url.searchParams.set('state', state);
  return c.json({ url: url.toString() });
});

const CODE_RE = /^[\w.-]{1,256}$/;
const STATE_RE = /^[A-Za-z0-9_-]{16,64}$/;

// GitHub redirects the browser here. The code is NOT exchanged yet: it is handed to the web app in the URL fragment
// (never sent to servers or in Referer), which completes the flow with the signed-in user's own session. A forwarded
// authorization link therefore ends in the victim's session, where /complete refuses the attacker's state.
githubRoutes.get('/callback', async (c) => {
  const { d } = cfg(c);
  const code = c.req.query('code') ?? '';
  const state = c.req.query('state') ?? '';
  if (!CODE_RE.test(code) || !STATE_RE.test(state)) return c.redirect(`${d.config.appOrigin}/#/github-done?ok=0`);
  return c.redirect(`${d.config.appOrigin}/#/github-continue?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
});

githubRoutes.post('/complete', rateLimit('gh-complete', 20, 3600), async (c) => {
  const { d, github, kv, f } = cfg(c);
  const { u } = await requireAuth(c);
  const { code, state } = await parseBody(
    c,
    v.object({ code: v.pipe(v.string(), v.regex(CODE_RE)), state: v.pipe(v.string(), v.regex(STATE_RE)) }),
  );
  const saved = await kv.take(`gh:state:${state}`); // single use, whoever presents it
  if (!saved) throw new AppError(410, 'invalid_token', 'This GitHub link has expired or was already used; start again');
  const { userId, handoff, pub } = JSON.parse(saved) as { userId: string; handoff: string; pub: string };
  if (userId !== u.id) {
    throw new AppError(403, 'forbidden', 'This GitHub authorization was started by another account; nothing was linked');
  }
  let tok: Tokens;
  try {
    tok = await exchange(f, github, { code, redirect_uri: `${d.config.appOrigin}/api/github/callback` });
  } catch {
    throw new AppError(400, 'github_exchange_failed' as never, 'GitHub did not accept the authorization; try again');
  }
  const me = (await (await f('https://api.github.com/user', { headers: ghHeaders(tok.access_token) })).json()) as { login: string; id: number };
  await d.db
    .insert(schema.githubLinks)
    .values({ userId, githubLogin: me.login, githubId: me.id })
    .onConflictDoUpdate({ target: schema.githubLinks.userId, set: { githubLogin: me.login, githubId: me.id } });
  const serverKeys = await generateDeviceKeys({ forceNoble: true });
  const env = await seal(serverKeys, pub, new TextEncoder().encode(JSON.stringify(tok)), `gh-handoff|${handoff}`);
  await kv.set(`gh:handoff:${handoff}`, JSON.stringify({ userId, serverPub: serverKeys.xPub, env: Buffer.from(env).toString('base64') }), HANDOFF_TTL);
  return c.json({ ok: true, login: me.login });
});

githubRoutes.get('/handoff/:id', rateLimit('gh-handoff', 120, 600), async (c) => {
  const { kv } = cfg(c);
  const { u } = await requireAuth(c);
  const raw = await kv.get(`gh:handoff:${c.req.param('id')}`);
  if (!raw) return c.json({ ready: false });
  const h = JSON.parse(raw) as { userId: string; serverPub: string; env: string };
  if (h.userId !== u.id) throw new AppError(403, 'forbidden', 'Not your hand-off');
  await kv.take(`gh:handoff:${c.req.param('id')}`);
  return c.json({ ready: true, serverPub: h.serverPub, env: h.env });
});

githubRoutes.post('/refresh', rateLimit('gh-refresh', 60, 3600), async (c) => {
  const { github, f } = cfg(c);
  await requireAuth(c);
  const { refreshToken } = await parseBody(c, v.object({ refreshToken: v.pipe(v.string(), v.maxLength(512)) }));
  try {
    const tok = await exchange(f, github, { grant_type: 'refresh_token', refresh_token: refreshToken });
    return c.json(tok);
  } catch {
    throw new AppError(401, 'github_refresh_failed' as never, 'GitHub authorization expired; reconnect GitHub');
  }
});

githubRoutes.get('/link', async (c) => {
  const { u } = await requireAuth(c);
  const [l] = await c.get('deps').db.select().from(schema.githubLinks).where(eq(schema.githubLinks.userId, u.id)).limit(1);
  return c.json({ link: l ? { login: l.githubLogin, id: l.githubId } : null });
});

githubRoutes.delete('/link', async (c) => {
  const { u } = await requireAuth(c);
  await c.get('deps').db.delete(schema.githubLinks).where(eq(schema.githubLinks.userId, u.id));
  return c.json({ ok: true });
});

const ghHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'p2platex' });

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}

async function exchange(f: typeof fetch, g: GithubConfig, extra: Record<string, string>): Promise<Tokens> {
  const res = await f('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'p2platex' },
    body: JSON.stringify({ client_id: g.clientId, client_secret: g.clientSecret, ...extra }),
    signal: AbortSignal.timeout(8000),
  });
  const j = (await res.json()) as Tokens & { error?: string };
  if (!res.ok || j.error || !j.access_token) throw new Error(j.error ?? 'token exchange failed');
  return { access_token: j.access_token, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}), ...(j.expires_in ? { expires_in: j.expires_in } : {}) };
}
