import { eq, ilike, or } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import * as v from 'valibot';
import { schema } from '../db/client.js';
import type { Env } from '../deps.js';
import { AppError } from '../errors.js';
import { rateLimit } from '../middleware.js';
import { parseBody, randomId, randomToken } from '../util.js';
import { hashPassword, isBreached, MIN_PASSWORD, verifyPassword } from './password.js';
import { audit, consumeEmailToken, sendResetEmail, sendVerifyEmail, setPassword } from './service.js';
import { attachSession, clearSessionCookie, createSession, requireAuth, revokeAllSessions } from './sessions.js';

const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
const REAUTH_WINDOW_MS = 10 * 60 * 1000;
const LOCK_FAILURES = 10;
const LOCK_WINDOW_SEC = 900;
const LOCK_MS = LOCK_WINDOW_SEC * 1000;

const PasswordSchema = v.pipe(
  v.string(),
  v.minLength(MIN_PASSWORD, `Password must be at least ${MIN_PASSWORD} characters`),
  v.maxLength(256),
);
const Kind = v.optional(v.picklist(['web', 'desktop']), 'web');

const RegisterSchema = v.object({
  username: v.pipe(
    v.string(),
    v.trim(),
    v.toLowerCase(),
    v.regex(USERNAME_RE, 'Username must be 3-32 chars of a-z 0-9 _ -'),
  ),
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.email(), v.maxLength(254)),
  password: PasswordSchema,
  kind: Kind,
});

const LoginSchema = v.object({
  identifier: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254)),
  password: v.pipe(v.string(), v.maxLength(256)),
  kind: Kind,
});

const invalid = () => new AppError(401, 'invalid_credentials', 'Invalid credentials');
const weak = () => new AppError(422, 'weak_password', 'This password appears in known breaches; choose another');

// A constant-work dummy hash so unknown users cost the same as wrong passwords.
let dummyHash: Promise<string> | undefined;

function publicUser(u: typeof schema.users.$inferSelect) {
  return { id: u.id, username: u.username, email: u.email, emailVerified: !!u.emailVerifiedAt, isAdmin: u.isAdmin };
}

export const accountRoutes = new Hono<Env>();

accountRoutes.post('/register', rateLimit('register', 10, 3600), async (c) => {
  const deps = c.get('deps');
  const body = await parseBody(c, RegisterSchema);
  if (await isBreached(body.password, { online: deps.config.breachedCheck })) throw weak();

  const [dupUser] = await deps.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.usernameLc, body.username))
    .limit(1);
  if (dupUser) throw new AppError(409, 'username_unavailable', 'Username unavailable');
  const [dupMail] = await deps.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.emailLc, body.email))
    .limit(1);
  if (dupMail) throw new AppError(409, 'email_unavailable', 'Email unavailable');

  const id = randomId();
  try {
    await deps.db.insert(schema.users).values({
      id,
      usernameLc: body.username,
      username: body.username,
      emailLc: body.email,
      email: body.email,
      pwHash: await hashPassword(body.password, deps.config.argon),
      createdAt: deps.now(),
    });
  } catch {
    // Lost a race against the unique constraints.
    throw new AppError(409, 'username_unavailable', 'Username or email unavailable');
  }
  // After responding (like /forgot): a mail outage must not fail a registration whose account already exists.
  // The user can ask for a new link later (/resend-verification).
  const mail = sendVerifyEmail(deps, { id, email: body.email, username: body.username }).catch(() => {
    console.error('verification email could not be sent', c.get('requestId'));
  });
  if (deps.background) deps.background(mail);
  else await mail;
  const token = await createSession(deps, id, body.kind);
  const bearer = attachSession(c, token, body.kind);
  return c.json(
    { user: { id, username: body.username, email: body.email, emailVerified: false, isAdmin: false }, ...(bearer ? { token: bearer } : {}) },
    201,
  );
});

accountRoutes.post('/login', rateLimit('login', 30, 900), async (c) => {
  const deps = c.get('deps');
  const body = await parseBody(c, LoginSchema);
  const [user] = await deps.db
    .select()
    .from(schema.users)
    .where(or(eq(schema.users.usernameLc, body.identifier), eq(schema.users.emailLc, body.identifier)))
    .limit(1);

  if (!user) {
    dummyHash ??= hashPassword('dummy-password-for-timing', deps.config.argon);
    await verifyPassword(await dummyHash, body.password);
    throw invalid();
  }
  const now = deps.now();
  const ok = await verifyPassword(user.pwHash, body.password);
  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) throw invalid();
  if (!ok) {
    const r = await deps.limiter.hit(`loginfail:${user.id}`, LOCK_FAILURES, LOCK_WINDOW_SEC);
    if (r.count >= LOCK_FAILURES) {
      await deps.db
        .update(schema.users)
        .set({ lockedUntil: new Date(now.getTime() + LOCK_MS) })
        .where(eq(schema.users.id, user.id));
    }
    throw invalid();
  }
  await deps.limiter.reset(`loginfail:${user.id}`);
  await deps.db.update(schema.users).set({ failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, user.id));
  const token = await createSession(deps, user.id, body.kind);
  const bearer = attachSession(c, token, body.kind);
  return c.json({ user: publicUser(user), ...(bearer ? { token: bearer } : {}) });
});

accountRoutes.get('/me', async (c) => {
  const { u } = await requireAuth(c);
  return c.json({ user: publicUser(u) });
});

accountRoutes.post('/logout', async (c) => {
  const deps = c.get('deps');
  await requireAuth(c);
  await deps.db.update(schema.sessions).set({ revokedAt: deps.now() }).where(eq(schema.sessions.id, c.get('session').id));
  clearSessionCookie(c);
  return c.json({ ok: true });
});

accountRoutes.post('/logout-all', async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  await revokeAllSessions(deps, u.id);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

accountRoutes.post('/verify-email', rateLimit('verify', 20, 3600), async (c) => {
  const deps = c.get('deps');
  const { token } = await parseBody(c, v.object({ token: v.pipe(v.string(), v.maxLength(200)) }));
  const userId = await consumeEmailToken(deps, token, 'verify');
  if (!userId) throw new AppError(410, 'invalid_token', 'Link is invalid or expired');
  await deps.db.update(schema.users).set({ emailVerifiedAt: deps.now() }).where(eq(schema.users.id, userId));
  return c.json({ ok: true });
});

accountRoutes.post('/resend-verification', rateLimit('resend-verify', 10, 3600), async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  if (u.emailVerifiedAt) return c.json({ ok: true, alreadyVerified: true });
  const per = await deps.limiter.hit(`resend-verify:${u.id}`, 3, 3600);
  if (!per.ok) throw new AppError(429, 'rate_limited', 'Too many verification emails; try again later', { 'Retry-After': '3600' });
  const mail = sendVerifyEmail(deps, { id: u.id, email: u.email, username: u.username }).catch(() => {
    console.error('verification email could not be sent', c.get('requestId'));
  });
  if (deps.background) deps.background(mail);
  else await mail;
  return c.json({ ok: true });
});

accountRoutes.post('/forgot', rateLimit('forgot', 5, 3600), async (c) => {
  const deps = c.get('deps');
  const { email } = await parseBody(
    c,
    v.object({ email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254)) }),
  );
  const [user] = await deps.db.select().from(schema.users).where(eq(schema.users.emailLc, email)).limit(1);
  if (user?.emailVerifiedAt) {
    const per = await deps.limiter.hit(`forgot-acct:${user.id}`, 3, 3600);
    // Sent after responding: the response time must not reveal whether the address is registered.
    if (per.ok) {
      const work = sendResetEmail(deps, user).catch(() => {});
      if (deps.background) deps.background(work);
      else await work;
    }
  }
  return c.json({ ok: true, message: 'If the address exists, an email was sent.' });
});

accountRoutes.post('/reset', rateLimit('reset', 10, 3600), async (c) => {
  const deps = c.get('deps');
  const body = await parseBody(c, v.object({ token: v.pipe(v.string(), v.maxLength(200)), password: PasswordSchema }));
  if (await isBreached(body.password, { online: deps.config.breachedCheck })) throw weak();
  const userId = await consumeEmailToken(deps, body.token, 'reset');
  if (!userId) throw new AppError(410, 'invalid_token', 'Link is invalid or expired; request a new one');
  await setPassword(deps, userId, body.password);
  return c.json({ ok: true });
});

accountRoutes.post('/change-password', rateLimit('chpw', 10, 900), async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const body = await parseBody(c, v.object({ current: v.pipe(v.string(), v.maxLength(256)), password: PasswordSchema }));
  if (!(await verifyPassword(u.pwHash, body.current))) {
    throw new AppError(403, 'invalid_credentials', 'Current password is incorrect');
  }
  if (await isBreached(body.password, { online: deps.config.breachedCheck })) throw weak();
  await setPassword(deps, u.id, body.password, c.get('session').id);
  return c.json({ ok: true });
});

// ---- platform admin ----

accountRoutes.post('/reauth', rateLimit('reauth', 10, 900), async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const { password } = await parseBody(c, v.object({ password: v.pipe(v.string(), v.maxLength(256)) }));
  if (!(await verifyPassword(u.pwHash, password))) throw new AppError(403, 'invalid_credentials', 'Invalid credentials');
  await deps.db.update(schema.sessions).set({ reauthAt: deps.now() }).where(eq(schema.sessions.id, c.get('session').id));
  return c.json({ ok: true });
});

async function requireAdmin(c: Context<Env>) {
  const { u, s } = await requireAuth(c);
  if (!u.isAdmin) throw new AppError(403, 'forbidden', 'Forbidden');
  if (!s.reauthAt || c.get('deps').now().getTime() - s.reauthAt.getTime() > REAUTH_WINDOW_MS) {
    throw new AppError(403, 'reauth_required', 'Re-enter your password to continue');
  }
  return u;
}

accountRoutes.get('/admin/users', async (c) => {
  const deps = c.get('deps');
  await requireAdmin(c);
  const q = (c.req.query('q') ?? '').toLowerCase().replace(/[%_\\]/g, '');
  if (q.length < 2) return c.json({ users: [] });
  const rows = await deps.db
    .select()
    .from(schema.users)
    .where(or(ilike(schema.users.usernameLc, `${q}%`), ilike(schema.users.emailLc, `${q}%`)))
    .limit(25);
  return c.json({
    users: rows.map((u) => ({ id: u.id, username: u.username, email: u.email, isAdmin: u.isAdmin, mustReset: u.pwMustReset })),
  });
});

accountRoutes.post('/admin/force-reset', async (c) => {
  const deps = c.get('deps');
  const admin = await requireAdmin(c);
  const { userId } = await parseBody(c, v.object({ userId: v.string() }));
  const [target] = await deps.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!target) throw new AppError(404, 'not_found', 'User not found');
  // The old password stops working immediately: replace it with an unusable random secret.
  await deps.db
    .update(schema.users)
    .set({
      pwHash: await hashPassword(randomToken(32), deps.config.argon),
      pwMustReset: true,
      lockedUntil: null,
      failedLogins: 0,
    })
    .where(eq(schema.users.id, target.id));
  await revokeAllSessions(deps, target.id);
  if (target.emailVerifiedAt) await sendResetEmail(deps, target);
  await audit(deps, admin.id, 'admin.force_password_reset', target.id, { username: target.username });
  return c.json({ ok: true, emailed: !!target.emailVerifiedAt });
});
