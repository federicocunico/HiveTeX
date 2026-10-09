import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };

/**
 * Local Neon emulator (docker compose): `NEON_HTTP_ENDPOINT=http://neon-proxy:4444/sql` sends the HTTP driver to a
 * Neon-compatible proxy in front of plain Postgres. Unset in production, where the driver derives Neon's endpoint.
 */
export function neonOverrides(env: NodeJS.ProcessEnv = process.env): { fetchEndpoint: string } | null {
  const endpoint = env.NEON_HTTP_ENDPOINT?.trim();
  return endpoint ? { fetchEndpoint: endpoint } : null;
}

/** Production: Neon over HTTP (no TCP pool needed in serverless). */
export async function createNeonDb(url: string, env: NodeJS.ProcessEnv = process.env): Promise<Db> {
  const { neon, neonConfig } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-http');
  const o = neonOverrides(env);
  if (o) neonConfig.fetchEndpoint = o.fetchEndpoint;
  return drizzle(neon(url), { schema }) as unknown as Db;
}
