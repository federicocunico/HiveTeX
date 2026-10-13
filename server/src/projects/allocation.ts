import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { AppError } from '../errors.js';
import { randomId } from '../util.js';
import { projectShareId, projectSuffix } from './identity.js';

export const ALLOCATION_ATTEMPTS = 5;

/** PGlite and Neon HTTP expose raw execute rows through different result wrappers. */
export function executeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) return result.rows as T[];
  throw new Error('Database did not return query rows');
}

export function allocationFailed() {
  return new AppError(500, 'id_generation_failed', 'Could not assign a project ID. Please try again.');
}

/** One statement is atomic even on the serverless HTTP driver (no interactive transaction). */
export async function createProjectWithOwner(
  db: Db,
  input: { prefix?: string | undefined; userId: string; pwHash: string | null; now: Date },
  suffix: () => string = projectSuffix,
) {
  const id = randomId();
  for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt++) {
    const slug = projectShareId(input.prefix, suffix);
    const result = await db.execute(sql`
      WITH created AS (
        INSERT INTO projects (id, slug, pw_hash, default_role, created_at)
        VALUES (${id}, ${slug}, ${input.pwHash}, 'viewer', ${input.now.toISOString()})
        ON CONFLICT (slug) DO NOTHING
        RETURNING id, slug
      ), owned AS (
        INSERT INTO memberships (project_id, user_id, role, joined_at)
        SELECT id, ${input.userId}, 'owner', ${input.now.toISOString()} FROM created
        RETURNING project_id
      )
      SELECT created.id, created.slug FROM created JOIN owned ON owned.project_id = created.id
    `);
    const [p] = executeRows<{ id: string; slug: string }>(result);
    if (p) return p;
  }
  throw allocationFailed();
}

/** Retry only the slug constraint, including Drizzle's wrapped native database error. */
export function isSlugConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; constraint?: string; cause?: unknown };
  return (e.code === '23505' && e.constraint === 'projects_slug_unique') || (!!e.cause && isSlugConflict(e.cause));
}
