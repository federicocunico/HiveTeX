import { defineConfig, devices } from '@playwright/test';

// `make e2e`: starts the embedded-database dev server + Vite. `make test-stack`: runs against the docker stack
// (PLAYWRIGHT_BASE_URL=http://localhost:8080 SKIP_WEBSERVER=1).
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:1420';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // P2P tests (several browsers connecting over WebRTC) are occasionally flaky on CI runners; see TODO_CI.md.
  // Retried tests still show up as "flaky" in the report.
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', actionTimeout: 30_000, ...devices['Desktop Chrome'] },
  ...(process.env.SKIP_WEBSERVER
    ? {}
    : {
        webServer: [
          {
            command: 'npx pnpm@10 --filter @p2platex/server dev',
            url: 'http://localhost:3000/api/health',
            env: { MEMORY_DB: '1', PORT: '3000', E2E_FAKE_GITHUB: '1', E2E_NO_LIMITS: '1' },
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
          {
            command: 'npx pnpm@10 --filter @p2platex/web dev',
            url: 'http://localhost:1420',
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ],
      }),
});
