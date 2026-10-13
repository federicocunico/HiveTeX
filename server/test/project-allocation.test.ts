import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db/client.js';
import { createProjectWithOwner, executeRows } from '../src/projects/allocation.js';
import { makeEnv, register } from './helpers.js';

async function setup() {
  const env = await makeEnv();
  const client = await register(env, 'owner');
  const user = (await client.get('/auth/me')).json.user;
  return { ...env, client, input: { prefix: 'paper', userId: user.id, pwHash: null, now: env.deps.now() } };
}

describe('atomic shared project creation', () => {
  it('creates exactly one project and its owner; concurrent prefixes are allowed', async () => {
    const { db, input } = await setup();
    const [a, b] = await Promise.all([createProjectWithOwner(db, input), createProjectWithOwner(db, input)]);
    expect(a.slug).not.toBe(b.slug);
    expect(await db.select().from(schema.projects)).toHaveLength(2);
    expect((await db.select().from(schema.memberships)).map(m => m.role)).toEqual(['owner', 'owner']);
  });
  it('retries a real unique constraint conflict with fresh randomness', async () => {
    const { db, input } = await setup();
    const fixed = 'a'.repeat(16);
    const a = await createProjectWithOwner(db, input, () => fixed);
    const random = vi.fn().mockReturnValueOnce(fixed).mockReturnValue('b'.repeat(16));
    const b = await createProjectWithOwner(db, input, random);
    expect(random).toHaveBeenCalledTimes(2);
    expect(a.id).not.toBe(b.id);
    expect(b.slug).toBe('paper-' + 'b'.repeat(16));
  });
  it('exhausts five collisions without an extra project or membership', async () => {
    const { db, input } = await setup();
    const random = vi.fn(() => 'a'.repeat(16));
    await createProjectWithOwner(db, input, random);
    random.mockClear();
    await expect(createProjectWithOwner(db, input, random)).rejects.toMatchObject({ code: 'id_generation_failed' });
    expect(random).toHaveBeenCalledTimes(5);
    expect(await db.select().from(schema.projects)).toHaveLength(1);
    expect(await db.select().from(schema.memberships)).toHaveLength(1);
  });
  it('rolls back the project if owner membership violates its foreign key', async () => {
    const { db, input } = await setup();
    await expect(createProjectWithOwner(db, { ...input, userId: 'missing-owner' })).rejects.toThrow();
    expect(await db.select().from(schema.projects)).toHaveLength(0);
    expect(await db.select().from(schema.memberships)).toHaveLength(0);
  });
  it('propagates unrelated failures instead of mislabeling them as collisions', async () => {
    const { db, input } = await setup();
    const fail = vi.spyOn(db, 'execute').mockRejectedValue(new Error('database unavailable'));
    await expect(createProjectWithOwner(db, input)).rejects.toThrow('database unavailable');
    expect(fail).toHaveBeenCalledTimes(1);
  });
  it('returns a suffixed ID even for old API callers and normal ownership details', async () => {
    const { client, db } = await setup();
    const response = await client.post('/projects', { slug: 'paper', passwordProtected: false });
    expect(response.status).toBe(201);
    expect(response.json.project).toMatchObject({ role: 'owner', defaultRole: 'viewer', passwordProtected: false, epoch: 1 });
    expect(response.json.project.slug).toMatch(/^paper-[a-z2-7]{16}$/);
    expect(await db.select().from(schema.memberships).where(eq(schema.memberships.projectId, response.json.project.id))).toHaveLength(1);
  });
  it('normalizes supported driver row wrappers', () => {
    expect(executeRows([{ id: 'a' }])).toEqual([{ id: 'a' }]);
    expect(executeRows({ rows: [{ id: 'b' }] })).toEqual([{ id: 'b' }]);
    expect(() => executeRows({})).toThrow();
  });
});

describe('share ID rename', () => {
  it('assigns a new suffix and preserves internal identity and memberships', async () => {
    const { client, db } = await setup();
    const original = (await client.post('/projects', { slug: 'paper', passwordProtected: false })).json.project;
    const before = await db.select().from(schema.memberships);
    const r = await client.patch('/projects/' + original.id, { slug: 'renamed' });
    expect(r.status).toBe(200);
    expect(r.json.project.id).toBe(original.id);
    expect(r.json.project.slug).toMatch(/^renamed-[a-z2-7]{16}$/);
    expect(await db.select().from(schema.memberships)).toEqual(before);
    expect((await client.post('/projects/join', { slug: original.slug })).status).toBe(404);
    expect((await client.post('/projects/join', { slug: r.json.project.slug })).status).toBe(200);
  });
  it('keeps exact legacy IDs on no-op updates and unrelated settings', async () => {
    const { client, db } = await setup();
    const original = (await client.post('/projects', { passwordProtected: false })).json.project;
    const legacy = 'a'.repeat(48);
    await db.update(schema.projects).set({ slug: legacy }).where(eq(schema.projects.id, original.id));
    const r = await client.patch('/projects/' + original.id, { slug: legacy, defaultRole: 'editor' });
    expect(r.status).toBe(200);
    expect(r.json.project.slug).toBe(legacy);
    expect(r.json.project.defaultRole).toBe('editor');
    expect((await client.post('/projects/join', { slug: legacy })).status).toBe(200);
  });
  it('never renames to a plain ID, even when another project has the same prefix', async () => {
    const { client } = await setup();
    const a = (await client.post('/projects', { slug: 'paper', passwordProtected: false })).json.project;
    const b = (await client.post('/projects', { slug: 'other', passwordProtected: false })).json.project;
    const r = await client.patch('/projects/' + b.id, { slug: 'paper' });
    expect(r.status).toBe(200);
    expect(r.json.project.slug).toMatch(/^paper-[a-z2-7]{16}$/);
    expect(r.json.project.slug).not.toBe(a.slug);
  });
});

it('enforces owner-only rename for a member and an outsider', async () => {
  const env = await setup();
  const p = (await env.client.post('/projects', { passwordProtected: false })).json.project;
  const member = await register(env, 'member');
  await member.post('/projects/join', { slug: p.slug });
  const outsider = await register(env, 'outsider');
  expect((await member.patch('/projects/' + p.id, { slug: 'hijacked' })).status).toBe(403);
  expect((await outsider.patch('/projects/' + p.id, { slug: 'hijacked' })).status).toBe(404);
  expect((await env.client.get('/projects/' + p.id)).json.project.slug).toBe(p.slug);
});
