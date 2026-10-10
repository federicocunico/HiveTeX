/**
 * Promote an existing account to platform admin. Never exposed via the API.
 *   DATABASE_URL=postgres://... pnpm --filter @hivetex/server seed-admin <username>
 *   DATA_DIR=.data/pg ...        (local PGlite database)
 */

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { schema } from '../src/db/client.js';

const username = process.argv[2]?.toLowerCase();
if (!username) {
  console.error('usage: seed-admin <username>');
  process.exit(1);
}

// biome-ignore lint/suspicious/noExplicitAny: shared drizzle surface across drivers
let db: any;
if (process.env.DATABASE_URL) {
  const { neon } = await import('@neondatabase/serverless');
  const { drizzle } = await import('drizzle-orm/neon-http');
  db = drizzle(neon(process.env.DATABASE_URL), { schema });
} else {
  db = drizzlePglite(new PGlite(process.env.DATA_DIR ?? '.data/pg'), { schema });
}
const rows = await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.usernameLc, username)).returning({ id: schema.users.id });
if (rows.length === 0) {
  console.error(`no such user: ${username}`);
  process.exit(2);
}
console.log(`${username} is now a platform admin`);
process.exit(0); // the embedded database keeps the event loop alive otherwise
