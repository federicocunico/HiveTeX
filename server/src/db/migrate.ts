import { fileURLToPath } from 'node:url';
import { neonOverrides } from './client.js';

/** Applies the drizzle migrations over the Neon HTTP driver (or the local Neon emulator when NEON_HTTP_ENDPOINT is set). */
export async function runMigrations(url: string, env: NodeJS.ProcessEnv = process.env) {
  const { neon, neonConfig } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-http');
  const { migrate } = await import('drizzle-orm/neon-http/migrator');
  const o = neonOverrides(env);
  if (o) neonConfig.fetchEndpoint = o.fetchEndpoint;
  await migrate(drizzle(neon(url)), { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
}
