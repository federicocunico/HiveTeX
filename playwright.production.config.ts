import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base,
  testMatch: 'bundled-workspace.spec.ts',
  outputDir: 'test-results/production',
  retries: 0,
  use: { ...base.use, baseURL: 'http://localhost:1420' },
  webServer: [
    servers[0]!,
    { command: 'pnpm --filter @hivetex/web exec vite preview --host 127.0.0.1 --port 1420 --strictPort', url: 'http://localhost:1420', reuseExistingServer: false, timeout: 120_000 },
  ],
});
