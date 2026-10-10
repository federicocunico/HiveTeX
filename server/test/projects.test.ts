import { generateDeviceKeys, verifyTicket } from '@hivetex/crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client.js';
import { Client, PW, type TestEnv, makeEnv, register } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await makeEnv();
});

const PPW = 'project-secret-1';

async function owner(slug?: string) {
  const o = await register(env, 'olga');
  const r = await o.post('/projects', { ...(slug ? { slug } : {}), password: PPW });
  return { o, p: r.json.project, status: r.status };
}

async function userId(name: string) {
  const [u] = await env.db.select().from(schema.users).where(eq(schema.users.usernameLc, name));
  return u?.id as string;
}

describe('project creation (4.1)', () => {
  it('accepts an available custom ID and makes the creator owner', async () => {
    const { p, status } = await owner('my-paper-2026');
    expect(status).toBe(201);
    expect(p.slug).toBe('my-paper-2026');
    expect(p.role).toBe('owner');
    expect(p.passwordProtected).toBe(true);
  });
  it('rejects a taken custom ID with a suggestion', async () => {
    await owner('taken-id-1');
    const b = await register(env, 'bart');
    const r = await b.post('/projects', { slug: 'taken-id-1', password: PPW });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/Try "taken-id-1-/);
  });
  it('generates an unguessable random ID (>= 80 bits => 16 base32 chars)', async () => {
    const { p } = await owner();
    expect(p.slug).toMatch(/^[a-z2-7]{16}$/);
  });
  it('requires a password unless protection is explicitly disabled', async () => {
    const o = await register(env, 'pat');
    expect((await o.post('/projects', {})).status).toBe(422);
    const r = await o.post('/projects', { passwordProtected: false });
    expect(r.status).toBe(201);
    expect(r.json.project.passwordProtected).toBe(false);
  });
  it('rejects invalid custom IDs', async () => {
    const o = await register(env, 'quin');
    expect((await o.post('/projects', { slug: 'ab', password: PPW })).status).toBe(422);
    expect((await o.post('/projects', { slug: 'has spaces here', password: PPW })).status).toBe(422);
  });
});

describe('joining (4.2)', () => {
  it('joins with correct ID + password as default role viewer', async () => {
    const { p } = await owner('join-me-please');
    const j = await register(env, 'jane');
    const r = await j.post('/projects/join', { slug: 'join-me-please', password: PPW });
    expect(r.status).toBe(200);
    expect(r.json.project.role).toBe('viewer');
    expect((await j.get('/projects')).json.projects.map((x: { id: string }) => x.id)).toContain(p.id);
  });
  it('uses the configured default role', async () => {
    const { o } = await owner('join-me-editor');
    await o.patch(`/projects/${(await o.get('/projects')).json.projects[0].id}`, { defaultRole: 'editor' });
    const j = await register(env, 'edie');
    expect((await j.post('/projects/join', { slug: 'join-me-editor', password: PPW })).json.project.role).toBe('editor');
  });
  it('returns the same generic error for unknown ID and wrong password', async () => {
    await owner('some-project-1');
    const j = await register(env, 'kate');
    const a = await j.post('/projects/join', { slug: 'some-project-1', password: 'wrong-wrong' });
    const b = await j.post('/projects/join', { slug: 'does-not-exist', password: PPW });
    expect(a.status).toBe(404);
    expect(a.json).toEqual(b.json);
  });
  it('blocks after 5 failed attempts for 15 minutes', async () => {
    await owner('rate-limited-1');
    const j = await register(env, 'liam');
    for (let i = 0; i < 5; i++) expect((await j.post('/projects/join', { slug: 'rate-limited-1', password: 'bad-bad-bad' })).status).toBe(404);
    expect((await j.post('/projects/join', { slug: 'rate-limited-1', password: PPW })).status).toBe(429);
    env.advance(16 * 60 * 1000);
    expect((await j.post('/projects/join', { slug: 'rate-limited-1', password: PPW })).status).toBe(200);
  });
  it('limits failed joins across project IDs (no ID scanning)', async () => {
    await owner('scan-target-1');
    const j = await register(env, 'scanner');
    for (let i = 0; i < 20; i++) {
      expect((await j.post('/projects/join', { slug: `guess-${i}-xyz`, password: '' })).status).toBe(404);
    }
    // even a real project with the right password is refused now, for a slug never tried before
    expect((await j.post('/projects/join', { slug: 'scan-target-1', password: PPW })).status).toBe(429);
    env.advance(16 * 60 * 1000);
    expect((await j.post('/projects/join', { slug: 'scan-target-1', password: PPW })).status).toBe(200);
  });
  it('refuses banned users even with the correct password', async () => {
    const { o, p } = await owner('ban-test-1');
    const j = await register(env, 'mona');
    await j.post('/projects/join', { slug: 'ban-test-1', password: PPW });
    const id = await userId('mona');
    expect((await o.del(`/projects/${p.id}/members/${id}`, { ban: true })).status).toBe(200);
    const again = await j.post('/projects/join', { slug: 'ban-test-1', password: PPW });
    expect(again.status).toBe(404);
  });
  it('allows joining unprotected projects with the ID alone', async () => {
    const o = await register(env, 'nora');
    await o.post('/projects', { slug: 'open-project-1', passwordProtected: false });
    const j = await register(env, 'omar');
    expect((await j.post('/projects/join', { slug: 'open-project-1' })).status).toBe(200);
  });
  it('requires sign-in', async () => {
    expect((await new Client(env).post('/projects/join', { slug: 'whatever-id', password: 'x' })).status).toBe(401);
  });
});

describe('owner management (4.3)', () => {
  async function setup() {
    const { o, p } = await owner('manage-me-1');
    const e = await register(env, 'eve');
    await e.post('/projects/join', { slug: 'manage-me-1', password: PPW });
    return { o, e, p, eid: await userId('eve'), oid: await userId('olga') };
  }
  it('owner changes a role; lowering bumps the epoch', async () => {
    const { o, p, eid } = await setup();
    const up = await o.patch(`/projects/${p.id}/members/${eid}`, { role: 'editor' });
    expect(up.json.epoch).toBe(1);
    const down = await o.patch(`/projects/${p.id}/members/${eid}`, { role: 'viewer' });
    expect(down.json.epoch).toBe(2);
  });
  it('rejects every owner-only action from non-owners', async () => {
    const { e, p, oid, eid } = await setup();
    expect((await e.patch(`/projects/${p.id}/members/${eid}`, { role: 'owner' })).status).toBe(403);
    expect((await e.del(`/projects/${p.id}/members/${oid}`)).status).toBe(403);
    expect((await e.patch(`/projects/${p.id}`, { slug: 'hijacked-id' })).status).toBe(403);
    expect((await e.del(`/projects/${p.id}`)).status).toBe(403);
    const outsider = await register(env, 'zed');
    expect((await outsider.patch(`/projects/${p.id}`, { defaultRole: 'editor' })).status).toBe(404);
  });
  it('protects the last owner', async () => {
    const { o, p, oid } = await setup();
    expect((await o.patch(`/projects/${p.id}/members/${oid}`, { role: 'editor' })).status).toBe(409);
    expect((await o.del(`/projects/${p.id}/members/${oid}`)).status).toBe(409);
  });
  it('allows removing an owner once another exists', async () => {
    const { o, p, oid, eid } = await setup();
    await o.patch(`/projects/${p.id}/members/${eid}`, { role: 'owner' });
    expect((await o.patch(`/projects/${p.id}/members/${oid}`, { role: 'editor' })).status).toBe(200);
  });
  it('changes the slug: old one stops resolving, new one works', async () => {
    const { o, p } = await setup();
    expect((await o.patch(`/projects/${p.id}`, { slug: 'brand-new-slug' })).status).toBe(200);
    const j = await register(env, 'fay');
    expect((await j.post('/projects/join', { slug: 'manage-me-1', password: PPW })).status).toBe(404);
    expect((await j.post('/projects/join', { slug: 'brand-new-slug', password: PPW })).status).toBe(200);
  });
  it('password change keeps existing members; new password required for new joins', async () => {
    const { o, e, p } = await setup();
    await o.patch(`/projects/${p.id}`, { password: 'rotated-password-2' });
    expect((await e.get(`/projects/${p.id}`)).status).toBe(200);
    const j = await register(env, 'gus');
    expect((await j.post('/projects/join', { slug: 'manage-me-1', password: PPW })).status).toBe(404);
    expect((await j.post('/projects/join', { slug: 'manage-me-1', password: 'rotated-password-2' })).status).toBe(200);
  });
  it('owners see the member list; viewers do not', async () => {
    const { o, e, p } = await setup();
    expect((await o.get(`/projects/${p.id}`)).json.members).toHaveLength(2);
    expect((await e.get(`/projects/${p.id}`)).json.members).toBeUndefined();
  });
  it('deleting a project invalidates memberships and the ID', async () => {
    const { o, e, p } = await setup();
    expect((await o.del(`/projects/${p.id}`)).status).toBe(200);
    expect((await e.get('/projects')).json.projects).toHaveLength(0);
    const j = await register(env, 'hal');
    expect((await j.post('/projects/join', { slug: 'manage-me-1', password: PPW })).status).toBe(404);
  });
});

describe('devices and tickets (4.4)', () => {
  async function device(c: Client) {
    const keys = await generateDeviceKeys();
    const r = await c.post('/devices', { ed25519Pub: keys.edPub, x25519Pub: keys.xPub, label: 'laptop' });
    return { keys, id: r.json.deviceId as string };
  }
  async function trusted() {
    return (await new Client(env).get('/keys')).json.keys;
  }
  it('issues a verifiable 15-minute ticket with the right claims', async () => {
    const { o, p } = await owner('ticket-proj-1');
    const d = await device(o);
    const r = await o.post(`/projects/${p.id}/ticket`, { deviceId: d.id });
    expect(r.status).toBe(200);
    const claims = await verifyTicket(r.json.ticket, await trusted(), { now: env.deps.now() });
    expect(claims).toMatchObject({ pid: p.id, uname: 'olga', role: 'owner', ep: 1, dev: d.id, devE: d.keys.edPub, devX: d.keys.xPub });
    expect(claims.exp - claims.iat).toBe(900);
  });
  it('fails verification after expiry', async () => {
    const { o, p } = await owner('ticket-proj-2');
    const d = await device(o);
    const { ticket } = (await o.post(`/projects/${p.id}/ticket`, { deviceId: d.id })).json;
    await expect(verifyTicket(ticket, await trusted(), { now: new Date(env.deps.now().getTime() + 20 * 60_000) })).rejects.toThrow();
  });
  it('refuses tickets to removed members and for foreign or revoked devices', async () => {
    const { o, p } = await owner('ticket-proj-3');
    const j = await register(env, 'ivo');
    await j.post('/projects/join', { slug: 'ticket-proj-3', password: PPW });
    const jd = await device(j);
    expect((await j.post(`/projects/${p.id}/ticket`, { deviceId: jd.id })).status).toBe(200);
    // another user's device
    const od = await device(o);
    expect((await j.post(`/projects/${p.id}/ticket`, { deviceId: od.id })).status).toBe(403);
    // removed member cannot refresh
    await o.del(`/projects/${p.id}/members/${await userId('ivo')}`);
    expect((await j.post(`/projects/${p.id}/ticket`, { deviceId: jd.id })).status).toBe(403);
    // revoked device
    await o.del(`/devices/${od.id}`);
    expect((await o.post(`/projects/${p.id}/ticket`, { deviceId: od.id })).status).toBe(403);
  });
  it('embeds the bumped epoch after a role is lowered', async () => {
    const { o, p } = await owner('ticket-proj-4');
    const j = await register(env, 'joe');
    await j.post('/projects/join', { slug: 'ticket-proj-4', password: PPW });
    const jd = await device(j);
    await o.patch(`/projects/${p.id}/members/${await userId('joe')}`, { role: 'editor' });
    await o.patch(`/projects/${p.id}/members/${await userId('joe')}`, { role: 'viewer' });
    const t = await verifyTicket((await j.post(`/projects/${p.id}/ticket`, { deviceId: jd.id })).json.ticket, await trusted(), { now: env.deps.now() });
    expect(t).toMatchObject({ role: 'viewer', ep: 2 });
  });
  it('registers a device idempotently', async () => {
    const { o } = await owner('ticket-proj-5');
    const keys = await generateDeviceKeys();
    const a = await o.post('/devices', { ed25519Pub: keys.edPub, x25519Pub: keys.xPub });
    const b = await o.post('/devices', { ed25519Pub: keys.edPub, x25519Pub: keys.xPub });
    expect(a.json.deviceId).toBe(b.json.deviceId);
  });
});

describe('github repo name for bootstrap (10.6)', () => {
  it('lets the owner store owner/repo@branch, shows it to members, and validates the format', async () => {
    const { o, p } = await owner('gh-bootstrap-1');
    expect((await o.patch(`/projects/${p.id}`, { githubRepo: 'octocat/paper@main' })).json.project.githubRepo).toBe('octocat/paper@main');
    const j = await register(env, 'jess');
    await j.post('/projects/join', { slug: 'gh-bootstrap-1', password: PPW });
    expect((await j.get(`/projects/${p.id}`)).json.project.githubRepo).toBe('octocat/paper@main');
    expect((await o.patch(`/projects/${p.id}`, { githubRepo: 'not a repo' })).status).toBe(422);
    expect((await j.patch(`/projects/${p.id}`, { githubRepo: 'evil/repo@main' })).status).toBe(403);
    expect((await o.patch(`/projects/${p.id}`, { githubRepo: null })).json.project.githubRepo).toBeNull();
  });
});

describe('cross-origin access for the desktop app', () => {
  it('answers the preflight for desktop origins and stays closed to other sites', async () => {
    const pre = (origin: string) =>
      env.app.request('/api/auth/me', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,x-requested-with' },
      });
    for (const origin of ['http://tauri.localhost', 'tauri://localhost']) {
      const r = await pre(origin);
      expect(r.status).toBe(204);
      expect(r.headers.get('access-control-allow-origin')).toBe(origin);
      expect(r.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
      expect(r.headers.get('access-control-allow-credentials')).toBeNull();
    }
    const evil = await pre('https://evil.example');
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    // an actual desktop request with a bearer token works and is readable cross-origin
    const c = await register(env, 'desk');
    const login = await env.app.request('/api/auth/login', {
      method: 'POST',
      headers: { Origin: 'http://tauri.localhost', 'X-Requested-With': 'hivetex', 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'desk', password: PW, kind: 'desktop' }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
    const { token } = (await login.json()) as { token: string };
    const me = await env.app.request('/api/auth/me', { headers: { Origin: 'http://tauri.localhost', Authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(me.headers.get('access-control-allow-origin')).toBe('http://tauri.localhost');
    void c;
  });
});

describe('account recents', () => {
  it('lists the most recently opened projects first, never-opened ones last', async () => {
    const o = await register(env, 'rita');
    const ids: string[] = [];
    for (const slug of ['recent-aaa', 'recent-bbb', 'recent-ccc']) {
      ids.push((await o.post('/projects', { slug, password: PPW })).json.project.id);
      env.advance(1000);
    }
    expect((await o.post(`/projects/${ids[1]}/opened`)).status).toBe(200);
    env.advance(1000);
    expect((await o.post(`/projects/${ids[0]}/opened`)).status).toBe(200);
    const r = await o.get('/projects');
    expect(r.json.projects.map((p: { slug: string }) => p.slug)).toEqual(['recent-aaa', 'recent-bbb', 'recent-ccc']);
    expect(r.json.projects[0].lastOpenedAt).toBe(new Date(env.clock.t).toISOString());
    expect(r.json.projects[2].lastOpenedAt).toBeNull();
  });

  it('only members can record an open', async () => {
    const { p } = await owner('recent-own');
    const x = await register(env, 'xena');
    expect((await x.post(`/projects/${p.id}/opened`)).status).toBe(404);
    expect((await x.post('/projects/nope/opened')).status).toBe(404);
  });
});
