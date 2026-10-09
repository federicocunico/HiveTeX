import { generateDeviceKeys, open } from '@p2platex/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db/client.js';
import { MemoryKv } from '../src/kv.js';
import { Client, type TestEnv, makeEnv, register } from './helpers.js';

let env: TestEnv;
let kv: MemoryKv;
const calls: Array<{ url: string; body?: unknown }> = [];

const SECRET_TOKEN = 'ghu_SUPERSECRETACCESSTOKEN123456';
const SECRET_REFRESH = 'ghr_SUPERSECRETREFRESHTOKEN654321';

beforeEach(async () => {
  env = await makeEnv();
  kv = new MemoryKv(() => env.deps.now().getTime());
  calls.length = 0;
  env.deps.kv = kv;
  env.deps.github = { clientId: 'Iv1.testclient', clientSecret: 'client-secret-xyz' };
  env.deps.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url === 'https://github.com/login/oauth/access_token') {
      if (body.code === 'bad') return new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 });
      if (body.grant_type === 'refresh_token') return new Response(JSON.stringify({ access_token: 'ghu_REFRESHED', refresh_token: 'ghr_NEW', expires_in: 28800 }));
      return new Response(JSON.stringify({ access_token: SECRET_TOKEN, refresh_token: SECRET_REFRESH, expires_in: 28800 }));
    }
    if (url === 'https://api.github.com/user') return new Response(JSON.stringify({ login: 'octocat', id: 583231 }));
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
});

async function startFlow(c: Client) {
  const keys = await generateDeviceKeys();
  const handoff = 'handoff-0123456789abcdef';
  const r = await c.post('/github/start', { handoff, pub: keys.xPub });
  expect(r.status).toBe(200);
  const state = new URL(r.json.url).searchParams.get('state') as string;
  return { keys, handoff, state, url: r.json.url as string };
}

describe('GitHub OAuth hand-off (10.1)', () => {
  it('builds an authorize URL for the GitHub App with a one-time state', async () => {
    const c = await register(env, 'gina');
    const { url } = await startFlow(c);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('Iv1.testclient');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:1420/api/github/callback');
  });

  it('exchanges the code, stores only the login link, and hands tokens to the device encrypted', async () => {
    const c = await register(env, 'hal');
    const f = await startFlow(c);
    const cb = await env.app.request(`/api/github/callback?code=goodcode&state=${f.state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toContain('github-done?ok=1');

    // the client secret was used server-side
    expect(JSON.stringify(calls[0]?.body)).toContain('client-secret-xyz');

    // the hand-off is sealed: the key-value store never holds the plaintext token
    expect(kv.dump()).not.toContain(SECRET_TOKEN);
    expect(kv.dump()).not.toContain(SECRET_REFRESH);

    const h = await c.get(`/github/handoff/${f.handoff}`);
    expect(h.json.ready).toBe(true);
    const plain = JSON.parse(new TextDecoder().decode(await open(f.keys, h.json.serverPub, new Uint8Array(Buffer.from(h.json.env, 'base64')), `gh-handoff|${f.handoff}`)));
    expect(plain.access_token).toBe(SECRET_TOKEN);
    expect(plain.refresh_token).toBe(SECRET_REFRESH);

    // one-time: a second read finds nothing
    expect((await c.get(`/github/handoff/${f.handoff}`)).json.ready).toBe(false);

    // only the login link is persisted
    const links = await env.db.select().from(schema.githubLinks);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ githubLogin: 'octocat', githubId: 583231 });
    const dump = JSON.stringify({
      links,
      users: await env.db.select().from(schema.users),
      audit: await env.db.select().from(schema.auditLog),
      sessions: await env.db.select().from(schema.sessions),
    });
    expect(dump).not.toContain(SECRET_TOKEN);
    expect(dump).not.toContain(SECRET_REFRESH);
    expect((await c.get('/github/link')).json.link).toEqual({ login: 'octocat', id: 583231 });
  });

  it('never logs tokens', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = await register(env, 'ida');
    const f = await startFlow(c);
    await env.app.request(`/api/github/callback?code=goodcode&state=${f.state}`);
    await c.get(`/github/handoff/${f.handoff}`);
    const logged = JSON.stringify([...spy.mock.calls, ...err.mock.calls]);
    expect(logged).not.toContain(SECRET_TOKEN);
    spy.mockRestore();
    err.mockRestore();
  });

  it('rejects replayed, unknown and failed callbacks', async () => {
    const c = await register(env, 'jon');
    const f = await startFlow(c);
    const bad = await env.app.request('/api/github/callback?code=goodcode&state=unknown-state');
    expect(bad.headers.get('location')).toContain('ok=0');
    const failed = await env.app.request(`/api/github/callback?code=bad&state=${f.state}`);
    expect(failed.headers.get('location')).toContain('ok=0');
    const replay = await env.app.request(`/api/github/callback?code=goodcode&state=${f.state}`);
    expect(replay.headers.get('location')).toContain('ok=0'); // state was consumed
    expect((await c.get(`/github/handoff/${f.handoff}`)).json.ready).toBe(false);
  });

  it("keeps one user's hand-off from another user", async () => {
    const a = await register(env, 'kim');
    const b = await register(env, 'lee');
    const f = await startFlow(a);
    await env.app.request(`/api/github/callback?code=goodcode&state=${f.state}`);
    expect((await b.get(`/github/handoff/${f.handoff}`)).status).toBe(403);
    expect((await a.get(`/github/handoff/${f.handoff}`)).json.ready).toBe(true);
  });

  it('proxies refresh without persisting anything, and requires sign-in', async () => {
    const c = await register(env, 'max');
    const r = await c.post('/github/refresh', { refreshToken: SECRET_REFRESH });
    expect(r.json.access_token).toBe('ghu_REFRESHED');
    expect(kv.dump()).not.toContain('ghu_REFRESHED');
    expect((await new Client(env).post('/github/refresh', { refreshToken: 'x' })).status).toBe(401);
  });

  it('answers 501 when GitHub is not configured and supports unlinking', async () => {
    const c = await register(env, 'ned');
    const f = await startFlow(c);
    await env.app.request(`/api/github/callback?code=goodcode&state=${f.state}`);
    await c.del('/github/link');
    expect((await c.get('/github/link')).json.link).toBeNull();
    delete env.deps.github;
    expect((await c.post('/github/start', { handoff: 'handoff-0123456789abcdef', pub: f.keys.xPub })).status).toBe(501);
  });
});
