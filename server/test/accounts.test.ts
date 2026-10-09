import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { isBreached } from '../src/accounts/password.js';
import { schema } from '../src/db/client.js';
import { Client, PW, type TestEnv, makeEnv, register } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await makeEnv();
});

describe('schema constraints (2.2)', () => {
  it('enforces unique username_lc, email_lc and project slug', async () => {
    const mk = (id: string, u: string, e: string) =>
      env.db.insert(schema.users).values({ id, usernameLc: u, username: u, emailLc: e, email: e, pwHash: 'x' });
    await mk('1', 'a', 'a@x.io');
    await expect(mk('2', 'a', 'b@x.io')).rejects.toThrow();
    await expect(mk('3', 'c', 'a@x.io')).rejects.toThrow();
    await env.db.insert(schema.projects).values({ id: 'p1', slug: 'abc' });
    await expect(env.db.insert(schema.projects).values({ id: 'p2', slug: 'abc' })).rejects.toThrow();
  });
});

describe('app skeleton (2.3)', () => {
  it('rejects POST without the custom header and from a foreign origin', async () => {
    const c = new Client(env);
    const a = await env.app.request('/api/auth/login', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(a.status).toBe(403);
    const b = await c.req('POST', '/auth/login', { identifier: 'x', password: 'y' }, { origin: 'https://evil.example' });
    expect(b.status).toBe(403);
  });
  it('returns a json 404 without internals', async () => {
    const r = await new Client(env).get('/nope');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
  });
  it('returns 429 after the limit is exceeded', async () => {
    const c = new Client(env, '9.9.9.9');
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await c.post('/auth/login', { identifier: 'nobody', password: 'x' })).status;
    expect(last).toBe(429);
  });
});

describe('registration (3.1)', () => {
  it('registers, stores only an argon2id hash, and signs in via cookie', async () => {
    const c = new Client(env);
    const r = await c.post('/auth/register', { username: 'Alice', email: 'Alice@Example.com', password: PW });
    expect(r.status).toBe(201);
    expect(r.json.user.username).toBe('alice');
    const [row] = await env.db.select().from(schema.users);
    expect(row?.pwHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(row)).not.toContain(PW);
    expect((await c.get('/auth/me')).json.user.username).toBe('alice');
    expect(env.mailer.last('alice@example.com')?.subject).toMatch(/Verify/);
  });
  it('rejects a taken username ignoring case', async () => {
    await register(env, 'bob');
    const r = await new Client(env).post('/auth/register', { username: 'BOB', email: 'other@example.com', password: PW });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('username_unavailable');
  });
  it('rejects short and breached passwords', async () => {
    const c = new Client(env);
    expect((await c.post('/auth/register', { username: 'carl', email: 'c@x.io', password: 'short' })).status).toBe(422);
    expect((await c.post('/auth/register', { username: 'carl', email: 'c@x.io', password: 'password1234' })).status).toBe(422);
    expect(await env.db.select().from(schema.users)).toHaveLength(0);
  });
  it('HIBP check sends only a 5-char prefix and detects a match', async () => {
    let url = '';
    const none = (async (u: string) => {
      url = u;
      return new Response('0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await isBreached('zebra-unicorn-42', { online: true, fetchFn: none })).toBe(false);
    expect(url).toMatch(/\/range\/[0-9A-F]{5}$/);
    const sha = createHash('sha1').update('zebra-unicorn-42').digest('hex').toUpperCase();
    const hit = (async () => new Response(`${sha.slice(5)}:12\r\n`)) as unknown as typeof fetch;
    expect(await isBreached('zebra-unicorn-42', { online: true, fetchFn: hit })).toBe(true);
  });
});

describe('sign-in and sessions (3.2, 3.3)', () => {
  it('gives identical errors for unknown user and wrong password', async () => {
    await register(env, 'dave');
    const c = new Client(env);
    const a = await c.post('/auth/login', { identifier: 'dave', password: 'wrong-password-xx' });
    const b = await c.post('/auth/login', { identifier: 'ghost', password: 'wrong-password-xx' });
    expect(a.status).toBe(401);
    expect(a.json).toEqual(b.json);
  });
  it('desktop kind returns a bearer token and no cookie', async () => {
    await register(env, 'erin');
    const c = new Client(env);
    const r = await c.post('/auth/login', { identifier: 'erin@example.com', password: PW, kind: 'desktop' });
    expect(r.json.token).toBeTruthy();
    expect(c.cookie).toBe('');
    c.token = r.json.token;
    expect((await c.get('/auth/me')).status).toBe(200);
  });
  it('sign out everywhere revokes every session', async () => {
    const a = await register(env, 'finn');
    const b = new Client(env);
    await b.post('/auth/login', { identifier: 'finn', password: PW });
    expect((await b.get('/auth/me')).status).toBe(200);
    await a.post('/auth/logout-all');
    expect((await a.get('/auth/me')).status).toBe(401);
    expect((await b.get('/auth/me')).status).toBe(401);
  });
  it('expires sessions after 30 days of inactivity', async () => {
    const a = await register(env, 'gina');
    env.advance(31 * 24 * 3600 * 1000);
    expect((await a.get('/auth/me')).status).toBe(401);
  });
  it('locks sign-in after 10 failures: the 11th attempt is refused for 15 minutes', async () => {
    await register(env, 'hank');
    for (let i = 0; i < 10; i++) {
      const r = await new Client(env).post('/auth/login', { identifier: 'hank', password: 'nope-nope-nope' });
      expect(r.status).toBe(401);
    }
    const good = await new Client(env).post('/auth/login', { identifier: 'hank', password: PW });
    expect(good.status).toBe(401); // correct password still refused while locked
    env.advance(16 * 60 * 1000);
    expect((await new Client(env).post('/auth/login', { identifier: 'hank', password: PW })).status).toBe(200);
  });
});

describe('recovery (3.5)', () => {
  const tokenFrom = (to: string) => /token=([\w-]+)/.exec(env.mailer.last(to)?.text ?? '')?.[1];

  it('emails a verified user, responds neutrally, resets once and revokes sessions', async () => {
    const a = await register(env, 'ivy');
    const c = new Client(env);
    const r = await c.post('/auth/forgot', { email: 'ivy@example.com' });
    expect(r.json.message).toMatch(/If the address exists/);
    const t = tokenFrom('ivy@example.com');
    const newPw = 'a brand new passphrase!';
    expect((await c.post('/auth/reset', { token: t, password: newPw })).status).toBe(200);
    expect((await a.get('/auth/me')).status).toBe(401);
    expect((await new Client(env).post('/auth/login', { identifier: 'ivy', password: newPw })).status).toBe(200);
    expect((await c.post('/auth/reset', { token: t, password: 'another passphrase 99' })).status).toBe(410);
  });
  it('is neutral and silent for unknown emails', async () => {
    const before = env.mailer.sent.length;
    const r = await new Client(env).post('/auth/forgot', { email: 'nobody@example.com' });
    expect(r.json.message).toMatch(/If the address exists/);
    expect(env.mailer.sent.length).toBe(before);
  });
  it('sends nothing for an unverified email', async () => {
    await register(env, 'jack', { verify: false });
    const before = env.mailer.sent.length;
    await new Client(env).post('/auth/forgot', { email: 'jack@example.com' });
    expect(env.mailer.sent.length).toBe(before);
  });
  it('refuses expired links', async () => {
    await register(env, 'kim');
    const c = new Client(env);
    await c.post('/auth/forgot', { email: 'kim@example.com' });
    const t = tokenFrom('kim@example.com');
    env.advance(31 * 60 * 1000);
    expect((await c.post('/auth/reset', { token: t, password: 'a brand new passphrase!' })).status).toBe(410);
  });
});

describe('password change (3.6)', () => {
  it('requires the current password and ends other sessions', async () => {
    const a = await register(env, 'lena');
    const b = new Client(env);
    await b.post('/auth/login', { identifier: 'lena', password: PW });
    const bad = await a.post('/auth/change-password', { current: 'wrong-wrong-wrong', password: 'new passphrase 12345' });
    expect(bad.status).toBe(403);
    const ok = await a.post('/auth/change-password', { current: PW, password: 'new passphrase 12345' });
    expect(ok.status).toBe(200);
    expect((await a.get('/auth/me')).status).toBe(200);
    expect((await b.get('/auth/me')).status).toBe(401);
  });
});

describe('platform admin (3.7)', () => {
  async function makeAdmin() {
    const admin = await register(env, 'root');
    await env.db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.usernameLc, 'root'));
    return admin;
  }
  it('force reset revokes sessions, kills the old password, emails and audits', async () => {
    const admin = await makeAdmin();
    const victim = await register(env, 'mallory');
    const [v] = await env.db.select().from(schema.users).where(eq(schema.users.usernameLc, 'mallory'));
    expect((await admin.post('/auth/admin/force-reset', { userId: v?.id })).status).toBe(403); // needs re-auth
    await admin.post('/auth/reauth', { password: PW });
    expect((await admin.post('/auth/admin/force-reset', { userId: v?.id })).status).toBe(200);
    expect((await victim.get('/auth/me')).status).toBe(401);
    expect((await new Client(env).post('/auth/login', { identifier: 'mallory', password: PW })).status).toBe(401);
    expect(env.mailer.last('mallory@example.com')?.subject).toMatch(/Reset/);
    const log = await env.db.select().from(schema.auditLog);
    expect(log[0]).toMatchObject({ action: 'admin.force_password_reset', target: v?.id });
  });
  it('rejects non-admins', async () => {
    const u = await register(env, 'nina');
    const [t] = await env.db.select().from(schema.users).where(eq(schema.users.usernameLc, 'nina'));
    expect((await u.post('/auth/admin/force-reset', { userId: t?.id })).status).toBe(403);
    expect((await u.get('/auth/admin/users?q=ni')).status).toBe(403);
  });
  it('expires the re-auth window after 10 minutes', async () => {
    const admin = await makeAdmin();
    await admin.post('/auth/reauth', { password: PW });
    expect((await admin.get('/auth/admin/users?q=ro')).status).toBe(200);
    env.advance(11 * 60 * 1000);
    expect((await admin.get('/auth/admin/users?q=ro')).status).toBe(403);
  });
});
