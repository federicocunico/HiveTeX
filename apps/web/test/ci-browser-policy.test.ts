import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/** The local-build browser specs are required in CI (retries off), so a broken compile indicator cannot pass unseen. */
it('requires the local-compilation browser specs in CI', () => {
  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const run = ci.split('\n').find((l) => l.includes('run: pnpm exec playwright test') && l.includes('e2e/changes.spec.ts'));
  expect(run, 'required browser step').toBeDefined();
  expect(run).toContain('--retries=0');
  for (const spec of ['workspace', 'compile-modes', 'compiler-state', 'offline-and-compile', 'full-flow']) expect(run).toContain(`e2e/${spec}.spec.ts`);
});
