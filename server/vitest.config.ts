import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test boots an in-memory Postgres (PGlite) and applies the migrations in beforeEach: ~1.5 s locally, but
    // well over the 10 s default on a 2-vCPU CI runner while turbo runs all packages' tests in parallel.
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
