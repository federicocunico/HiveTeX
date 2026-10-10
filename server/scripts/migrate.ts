/** Apply SQL migrations to Neon: DATABASE_URL=... pnpm --filter @hivetex/server migrate (honors NEON_HTTP_ENDPOINT). */
import { runMigrations } from '../src/db/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
await runMigrations(url);
console.log('migrations applied');
