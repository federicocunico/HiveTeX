import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { publicOrigin } from '../src/config.js';
import { schema } from '../src/db/client.js';
import { Client, PW, type TestEnv, makeEnv, register } from './helpers.js';

describe('public origin', () => {
  it('prefers APP_ORIGIN, then the production domain, then the deployment URL', () => {
    expect(publicOrigin({ APP_ORIGIN: 'https://x.example', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'p.vercel.app' })).toBe('https://x.example');
    expect(publicOrigin({ VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'hivetex.vercel.app', VERCEL_URL: 'hivetex-abc123.vercel.app' })).toBe('https://hivetex.vercel.app');
    expect(publicOrigin({ VERCEL_ENV: 'preview', VERCEL_PROJECT_PRODUCTION_URL: 'hivetex.vercel.app', VERCEL_URL: 'hivetex-git-x.vercel.app' })).toBe('https://hivetex-git-x.vercel.app');
    expect(publicOrigin({})).toBe('http://localhost:1420');
  });
});

describe('first admin bootstrap (BOOTSTRAP_ADMIN)', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await makeEnv();
    env.deps.config.bootstrapAdmin = 'alice';
  });
  const isAdmin = async (name: string) =>
    (await env.db.select().from(schema.users).where(eq(schema.users.usernameLc, name)))[0]?.isAdmin;

  it('makes the designated user admin when they register first', async () => {
    const bob = await register(env, 'bob');
    expect((await bob.get('/auth/me')).json.user.isAdmin).toBe(false);
    const alice = await register(env, 'alice');
    expect((await alice.get('/auth/me')).json.user.isAdmin).toBe(true);
    expect(await isAdmin('bob')).toBe(false);
  });

  it('promotes on sign-in for an account created before the setting', async () => {
    delete env.deps.config.bootstrapAdmin;
    await register(env, 'alice');
    env.deps.config.bootstrapAdmin = 'alice';
    const c = new Client(env);
    const r = await c.post('/auth/login', { identifier: 'alice', password: PW });
    expect(r.json.user.isAdmin).toBe(true);
  });

  it('has no effect once an admin exists', async () => {
    await register(env, 'carol');
    await env.db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.usernameLc, 'carol'));
    await register(env, 'alice');
    expect(await isAdmin('alice')).toBe(false);
  });
});
