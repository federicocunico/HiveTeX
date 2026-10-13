import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Db, createNeonDb, schema } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createProjectWithOwner, executeRows } from '../src/projects/allocation.js';
import { randomId } from '../src/util.js';

// Opt-in against the isolated local Compose project; never use a production DATABASE_URL.
describe.runIf(process.env.HIVETEX_ALLOCATION_HTTP_TEST === '1')('allocation over Neon HTTP', () => {
  let db: Db;
  let userId: string;
  beforeAll(async () => {
    const url = 'postgres://postgres:postgres@localhost:55439/main';
    const env = { NEON_HTTP_ENDPOINT: 'http://localhost:4449/sql' };
    await runMigrations(url, env);
    db = await createNeonDb(url, env);
    userId = randomId();
    await db.insert(schema.users).values({ id: userId, username: userId, usernameLc: userId, email: userId + '@example.test', emailLc: userId + '@example.test', pwHash: 'fixture-hash' });
  });
  it('creates concurrent same-prefix projects with matching owners', async () => {
    const input = { prefix: 'http-' + randomId().slice(0, 8), userId, pwHash: null, now: new Date() };
    const [a, b] = await Promise.all([createProjectWithOwner(db, input), createProjectWithOwner(db, input)]);
    expect(a.slug).not.toBe(b.slug);
    for (const p of [a, b]) {
      expect(p.slug).toMatch(/-[a-z2-7]{16}$/);
      expect((await db.select().from(schema.memberships).where(eq(schema.memberships.projectId, p.id)))[0]).toMatchObject({ userId, role: 'owner' });
    }
  });
  it('retries real conflicts and leaves no project after an owner write fails', async () => {
    const prefix = 'atomic-' + randomId().slice(0, 8);
    const input = { prefix, userId, pwHash: null, now: new Date() };
    await createProjectWithOwner(db, input, () => 'a'.repeat(16));
    let calls = 0;
    const p = await createProjectWithOwner(db, input, () => ++calls === 1 ? 'a'.repeat(16) : 'b'.repeat(16));
    expect(calls).toBe(2);
    expect(p.slug).toBe(prefix + '-' + 'b'.repeat(16));
    const failed = prefix + '-failed';
    await expect(createProjectWithOwner(db, { ...input, prefix: failed, userId: 'missing-user' })).rejects.toThrow();
    expect(executeRows(await db.execute(sql`SELECT id FROM projects WHERE slug LIKE ${failed + '-%'}`))).toHaveLength(0);
  });
});
