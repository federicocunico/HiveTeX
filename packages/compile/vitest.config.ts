import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // In CI turbo runs every package's tests at once on a 2-4 vCPU runner: real-time waits (workers, crypto, meshes)
    // take several times longer than locally. Generous per-test limits, and fewer workers per package there, keep
    // contention from turning into timeouts; a real hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    ...(process.env.CI ? { maxWorkers: 2, minWorkers: 1 } : {}),
  },
});
