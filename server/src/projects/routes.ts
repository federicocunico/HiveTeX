import { and, count, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import * as v from 'valibot';
import { hashPassword, verifyPassword } from '../accounts/password.js';
import { requireAuth } from '../accounts/sessions.js';
import { schema } from '../db/client.js';
import type { Deps, Env } from '../deps.js';
import { AppError } from '../errors.js';
import { rateLimit } from '../middleware.js';
import { parseBody, randomId } from '../util.js';
import { doorbellInfo, signRingToken } from './doorbell.js';
import { signTicket } from './tickets.js';

const SLUG_RE = /^[a-z0-9-]{6,48}$/;
const ROLES = ['owner', 'editor', 'viewer'] as const;
type Role = (typeof ROLES)[number];
const JOIN_FAILS = 5;
const JOIN_WINDOW = 900;
const JOIN_FAILS_ANY = 20;

const SlugSchema = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(SLUG_RE, 'ID must be 6-48 chars of a-z 0-9 -'));
const ProjectPw = v.pipe(v.string(), v.minLength(8, 'Project password must be at least 8 characters'), v.maxLength(256));
const B64 = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/, 'Expected 32 bytes base64url'));

// base32 alphabet, lowercase: 10 random bytes -> 16 chars (80 bits)
function randomSlug() {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  const b = randomBytes(10);
  let bits = 0;
  let val = 0;
  let out = '';
  for (const byte of b) {
    val = (val << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += A[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

let dummyHash: Promise<string> | undefined;

export const projectRoutes = new Hono<Env>();

async function membership(deps: Deps, projectId: string, userId: string) {
  const [m] = await deps.db
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.projectId, projectId), eq(schema.memberships.userId, userId)))
    .limit(1);
  return m;
}

async function loadProject(deps: Deps, id: string) {
  const [p] = await deps.db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
  if (!p || p.deletedAt) throw new AppError(404, 'not_found', 'Project not found');
  return p;
}

async function requireOwner(deps: Deps, projectId: string, userId: string) {
  const p = await loadProject(deps, projectId);
  const m = await membership(deps, projectId, userId);
  if (!m) throw new AppError(404, 'not_found', 'Project not found');
  if (m.role !== 'owner') throw new AppError(403, 'forbidden', 'Owner only');
  return p;
}

async function ownerCount(deps: Deps, projectId: string) {
  const [r] = await deps.db
    .select({ n: count() })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.projectId, projectId), eq(schema.memberships.role, 'owner')));
  return Number(r?.n ?? 0);
}

async function bumpEpoch(deps: Deps, projectId: string) {
  const [r] = await deps.db
    .update(schema.projects)
    .set({ epoch: sqlInc() })
    .where(eq(schema.projects.id, projectId))
    .returning({ epoch: schema.projects.epoch });
  return r?.epoch ?? 0;
}
const sqlInc = () => sql`${schema.projects.epoch} + 1`;

function view(p: typeof schema.projects.$inferSelect, role: Role) {
  return {
    id: p.id,
    slug: p.slug,
    role,
    defaultRole: p.defaultRole,
    passwordProtected: !!p.pwHash,
    githubRepo: p.githubRepo ?? null,
    epoch: p.epoch,
  };
}

// ---- create / list / join ----

projectRoutes.post('/', rateLimit('proj-create', 20, 3600), async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const body = await parseBody(
    c,
    v.object({
      slug: v.optional(SlugSchema),
      password: v.optional(ProjectPw),
      passwordProtected: v.optional(v.boolean(), true),
    }),
  );
  if (body.passwordProtected && !body.password) {
    throw new AppError(422, 'password_required', 'Set a project password or explicitly disable protection');
  }
  const slug = body.slug ?? randomSlug();
  const [taken] = await deps.db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.slug, slug)).limit(1);
  if (taken) {
    throw new AppError(409, 'slug_unavailable', `ID unavailable. Try "${slug}-${randomBytes(2).toString('hex')}"`);
  }
  const id = randomId();
  try {
    await deps.db.insert(schema.projects).values({
      id,
      slug,
      pwHash: body.passwordProtected && body.password ? await hashPassword(body.password, deps.config.argon) : null,
      defaultRole: 'viewer',
      createdAt: deps.now(),
    });
  } catch {
    throw new AppError(409, 'slug_unavailable', 'ID unavailable');
  }
  await deps.db.insert(schema.memberships).values({ projectId: id, userId: u.id, role: 'owner', joinedAt: deps.now() });
  const [p] = await deps.db.select().from(schema.projects).where(eq(schema.projects.id, id));
  return c.json({ project: view(p as typeof schema.projects.$inferSelect, 'owner') }, 201);
});

projectRoutes.get('/', async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const rows = await deps.db
    .select({ p: schema.projects, role: schema.memberships.role, joinedAt: schema.memberships.joinedAt, lastOpenedAt: schema.memberships.lastOpenedAt })
    .from(schema.memberships)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.memberships.projectId))
    .where(eq(schema.memberships.userId, u.id));
  // Recents across the account's devices: most recently opened first, never-opened ones last (newest joined first).
  const t = (d: Date | null) => (d ? d.getTime() : 0);
  rows.sort((a, b) => (b.lastOpenedAt ? 1 : 0) - (a.lastOpenedAt ? 1 : 0) || t(b.lastOpenedAt) - t(a.lastOpenedAt) || t(b.joinedAt) - t(a.joinedAt));
  return c.json({
    projects: rows.filter((r) => !r.p.deletedAt).map((r) => ({ ...view(r.p, r.role as Role), lastOpenedAt: r.lastOpenedAt ? r.lastOpenedAt.toISOString() : null })),
  });
});

/** Records that the user opened the project (best effort from the workspace), for the account's recents. */
projectRoutes.post('/:id/opened', rateLimit('opened', 240, 3600), async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const id = c.req.param('id');
  const done = await deps.db
    .update(schema.memberships)
    .set({ lastOpenedAt: deps.now() })
    .where(and(eq(schema.memberships.projectId, id), eq(schema.memberships.userId, u.id)))
    .returning({ projectId: schema.memberships.projectId });
  if (done.length === 0) throw new AppError(404, 'not_found', 'Project not found');
  return c.json({ ok: true });
});

projectRoutes.post('/join', async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const body = await parseBody(c, v.object({ slug: SlugSchema, password: v.optional(v.pipe(v.string(), v.maxLength(256)), '') }));
  const kUser = `joinfail:${body.slug}:u:${u.id}`;
  const kIp = `joinfail:${body.slug}:ip:${c.get('ip')}`;
  // Across all project IDs too: otherwise an account could scan for unprotected projects one ID at a time.
  const kAnyUser = `joinfail:any:u:${u.id}`;
  const kAnyIp = `joinfail:any:ip:${c.get('ip')}`;
  if (
    (await deps.limiter.peek(kUser, JOIN_WINDOW)) >= JOIN_FAILS ||
    (await deps.limiter.peek(kIp, JOIN_WINDOW)) >= JOIN_FAILS ||
    (await deps.limiter.peek(kAnyUser, JOIN_WINDOW)) >= JOIN_FAILS_ANY ||
    (await deps.limiter.peek(kAnyIp, JOIN_WINDOW)) >= JOIN_FAILS_ANY
  ) {
    throw new AppError(429, 'rate_limited', 'Too many failed attempts; try again later', { 'Retry-After': '900' });
  }
  const fail = async () => {
    await deps.limiter.hit(kUser, JOIN_FAILS, JOIN_WINDOW);
    await deps.limiter.hit(kIp, JOIN_FAILS, JOIN_WINDOW);
    await deps.limiter.hit(kAnyUser, JOIN_FAILS_ANY, JOIN_WINDOW);
    await deps.limiter.hit(kAnyIp, JOIN_FAILS_ANY, JOIN_WINDOW);
    return new AppError(404, 'join_failed', 'Project not found or wrong password');
  };

  const [p] = await deps.db.select().from(schema.projects).where(eq(schema.projects.slug, body.slug)).limit(1);
  if (!p || p.deletedAt) {
    dummyHash ??= hashPassword('dummy-project-password', deps.config.argon);
    await verifyPassword(await dummyHash, body.password);
    throw await fail();
  }
  if (p.pwHash && !(await verifyPassword(p.pwHash, body.password))) throw await fail();
  const [banned] = await deps.db
    .select()
    .from(schema.bans)
    .where(and(eq(schema.bans.projectId, p.id), eq(schema.bans.userId, u.id)))
    .limit(1);
  if (banned) throw await fail();

  let m = await membership(deps, p.id, u.id);
  if (!m) {
    await deps.db
      .insert(schema.memberships)
      .values({ projectId: p.id, userId: u.id, role: p.defaultRole, joinedAt: deps.now() })
      .onConflictDoNothing();
    m = await membership(deps, p.id, u.id);
  }
  return c.json({ project: view(p, (m?.role ?? p.defaultRole) as Role) });
});

// ---- details & owner management ----

projectRoutes.get('/:id', async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const p = await loadProject(deps, c.req.param('id'));
  const m = await membership(deps, p.id, u.id);
  if (!m) throw new AppError(404, 'not_found', 'Project not found');
  const out: Record<string, unknown> = { project: view(p, m.role as Role) };
  if (m.role === 'owner') {
    const rows = await deps.db
      .select({ userId: schema.users.id, username: schema.users.username, role: schema.memberships.role, joinedAt: schema.memberships.joinedAt })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.projectId, p.id));
    out.members = rows;
    out.bans = (await deps.db.select().from(schema.bans).where(eq(schema.bans.projectId, p.id))).map((b) => b.userId);
  }
  return c.json(out);
});

projectRoutes.patch('/:id', async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const p = await requireOwner(deps, c.req.param('id'), u.id);
  const body = await parseBody(
    c,
    v.object({
      slug: v.optional(SlugSchema),
      defaultRole: v.optional(v.picklist(['editor', 'viewer'])),
      password: v.optional(v.nullable(ProjectPw)), // string = set/change, null = disable protection
      githubRepo: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+@[\w./-]+$/, 'Use owner/repo@branch')))),
    }),
  );
  const patch: Partial<typeof schema.projects.$inferInsert> = {};
  if (body.slug && body.slug !== p.slug) {
    const [taken] = await deps.db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.slug, body.slug)).limit(1);
    if (taken) throw new AppError(409, 'slug_unavailable', 'ID unavailable');
    patch.slug = body.slug;
  }
  if (body.defaultRole) patch.defaultRole = body.defaultRole;
  if (body.githubRepo !== undefined) patch.githubRepo = body.githubRepo;
  if (body.password !== undefined) {
    patch.pwHash = body.password === null ? null : await hashPassword(body.password, deps.config.argon);
  }
  if (Object.keys(patch).length) {
    try {
      await deps.db.update(schema.projects).set(patch).where(eq(schema.projects.id, p.id));
    } catch {
      throw new AppError(409, 'slug_unavailable', 'ID unavailable');
    }
  }
  const np = await loadProject(deps, p.id);
  return c.json({ project: view(np, 'owner') });
});

projectRoutes.patch('/:id/members/:userId', async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const p = await requireOwner(deps, c.req.param('id'), u.id);
  const targetId = c.req.param('userId');
  const { role } = await parseBody(c, v.object({ role: v.picklist(ROLES) }));
  const m = await membership(deps, p.id, targetId);
  if (!m) throw new AppError(404, 'not_found', 'Member not found');
  if (m.role === 'owner' && role !== 'owner' && (await ownerCount(deps, p.id)) <= 1) {
    throw new AppError(409, 'last_owner', 'A project needs at least one owner');
  }
  await deps.db
    .update(schema.memberships)
    .set({ role })
    .where(and(eq(schema.memberships.projectId, p.id), eq(schema.memberships.userId, targetId)));
  const lowered = ROLES.indexOf(role) > ROLES.indexOf(m.role as Role);
  const epoch = lowered ? await bumpEpoch(deps, p.id) : p.epoch;
  return c.json({ ok: true, epoch });
});

projectRoutes.delete('/:id/members/:userId', async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const p = await requireOwner(deps, c.req.param('id'), u.id);
  const targetId = c.req.param('userId');
  const body = await parseBody(c, v.object({ ban: v.optional(v.boolean(), false) })).catch(() => ({ ban: false }));
  const m = await membership(deps, p.id, targetId);
  if (!m) throw new AppError(404, 'not_found', 'Member not found');
  if (m.role === 'owner' && (await ownerCount(deps, p.id)) <= 1) {
    throw new AppError(409, 'last_owner', 'A project needs at least one owner');
  }
  await deps.db
    .delete(schema.memberships)
    .where(and(eq(schema.memberships.projectId, p.id), eq(schema.memberships.userId, targetId)));
  if (body.ban) await deps.db.insert(schema.bans).values({ projectId: p.id, userId: targetId }).onConflictDoNothing();
  const epoch = await bumpEpoch(deps, p.id);
  return c.json({ ok: true, epoch });
});

projectRoutes.delete('/:id', async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const p = await requireOwner(deps, c.req.param('id'), u.id);
  await deps.db.delete(schema.memberships).where(eq(schema.memberships.projectId, p.id));
  await deps.db
    .update(schema.projects)
    .set({ deletedAt: deps.now(), slug: `deleted-${p.id}`, epoch: sqlInc() })
    .where(eq(schema.projects.id, p.id));
  return c.json({ ok: true });
});

// ---- devices & tickets ----

export const deviceRoutes = new Hono<Env>();

deviceRoutes.post('/', rateLimit('device-reg', 30, 3600), async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const body = await parseBody(c, v.object({ ed25519Pub: B64, x25519Pub: B64, label: v.optional(v.pipe(v.string(), v.maxLength(64)), '') }));
  const [existing] = await deps.db
    .select()
    .from(schema.devices)
    .where(and(eq(schema.devices.userId, u.id), eq(schema.devices.ed25519Pub, body.ed25519Pub)))
    .limit(1);
  if (existing && !existing.revokedAt) return c.json({ deviceId: existing.id });
  const id = randomId();
  await deps.db.insert(schema.devices).values({ id, userId: u.id, ed25519Pub: body.ed25519Pub, x25519Pub: body.x25519Pub, label: body.label, createdAt: deps.now() });
  return c.json({ deviceId: id }, 201);
});

deviceRoutes.delete('/:id', async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  await deps.db
    .update(schema.devices)
    .set({ revokedAt: deps.now() })
    .where(and(eq(schema.devices.id, c.req.param('id')), eq(schema.devices.userId, u.id)));
  return c.json({ ok: true });
});

projectRoutes.post('/:id/ticket', rateLimit('ticket', 120, 900), async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const { deviceId } = await parseBody(c, v.object({ deviceId: v.string() }));
  const p = await loadProject(deps, c.req.param('id'));
  const m = await membership(deps, p.id, u.id);
  if (!m) throw new AppError(403, 'not_member', 'Not a member of this project');
  const [dev] = await deps.db
    .select()
    .from(schema.devices)
    .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, u.id)))
    .limit(1);
  if (!dev || dev.revokedAt) throw new AppError(403, 'bad_device', 'Unknown or revoked device');
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  const ticket = await signTicket(
    deps.config,
    { v: 1, pid: p.id, uid: u.id, uname: u.username, dev: dev.id, devX: dev.x25519Pub, devE: dev.ed25519Pub, role: m.role as Role, ep: p.epoch },
    nowSec,
  );
  const doorbell = doorbellInfo(deps.config, p.id, p.epoch);
  return c.json({ ticket, expiresAt: (nowSec + 15 * 60) * 1000, epoch: p.epoch, githubRepo: p.githubRepo ?? null, ...(doorbell ? { doorbell } : {}), ...(deps.config.desktopFeatures ? { features: deps.config.desktopFeatures } : {}) });
});

/**
 * Doorbell (D14): a member that needs peers gets a short-lived signed ring token for the project's current topic and
 * publishes it to the push service itself. Ringing grants nothing: woken devices still authenticate with tickets.
 */
projectRoutes.post('/:id/ring', rateLimit('ring', 600, 3600), async (c) => {
  const deps = c.get('deps');
  const { u } = await requireAuth(c);
  const { deviceId } = await parseBody(c, v.object({ deviceId: v.pipe(v.string(), v.maxLength(64)) }));
  const p = await loadProject(deps, c.req.param('id'));
  const m = await membership(deps, p.id, u.id);
  if (!m) throw new AppError(403, 'not_member', 'Not a member of this project');
  const [dev] = await deps.db
    .select()
    .from(schema.devices)
    .where(and(eq(schema.devices.id, deviceId), eq(schema.devices.userId, u.id)))
    .limit(1);
  if (!dev || dev.revokedAt) throw new AppError(403, 'bad_device', 'Unknown or revoked device');
  const doorbell = doorbellInfo(deps.config, p.id, p.epoch);
  if (!doorbell) throw new AppError(404, 'doorbell_disabled', 'Ringing is not enabled on this server');
  for (const [key, limit, windowSec] of [[`ring-dev:${dev.id}:${p.id}`, 1, 20], [`ring-hour:${dev.id}:${p.id}`, 60, 3600]] as const) {
    const r = await deps.limiter.hit(key, limit, windowSec);
    if (!r.ok) throw new AppError(429, 'rate_limited', 'Too many rings', { 'Retry-After': String(r.retryAfter) });
  }
  const nowSec = Math.floor(deps.now().getTime() / 1000);
  return c.json({ ...doorbell, token: await signRingToken(deps.config, doorbell.topic, p.epoch, nowSec), epoch: p.epoch });
});

export const keyRoutes = new Hono<Env>();
keyRoutes.get('/', (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({ keys: c.get('deps').config.ticketPublicJwks });
});
