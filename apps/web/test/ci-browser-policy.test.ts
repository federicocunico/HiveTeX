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

function authoringGate(ci: string) {
  const job = ci.match(/^  authoring-browser:\r?\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[0];
  expect(job, 'required authoring job').toBeDefined();
  expect(job).not.toMatch(/continue-on-error:|if:.*(?:false|inputs\.)/);
  expect(job).toContain('runs-on: windows-2025');
  const run = job!.split('\n').find((line) => line.includes('pnpm exec playwright test'));
  expect(run).toContain('--retries=0');
  expect(run).not.toMatch(/\|\||;|continue|exit 0/);
  for (const spec of ['editor-geometry', 'compile-scheduling', 'pdf-preview', 'synctex', 'format-overflow', 'workspace-status', 'authoring']) expect(run).toContain(`e2e/${spec}.spec.ts`);
  expect(job).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
  expect(job).toContain('if: failure()');
  expect(job).toContain('path: test-results/');
}

it('makes the focused authoring suite required, without promoting unrelated diagnostics', () => {
  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  authoringGate(ci);
  expect(ci.split('  browser-diagnostics:')[1]).toContain('continue-on-error: true');
});

it('rejects mutations that would hide deliberate failures or omit regression coverage', () => {
  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const start = ci.indexOf('  authoring-browser:');
  for (const mutate of [
    (s: string) => s.replace('  authoring-browser:', '  authoring-browser:\n    continue-on-error: true'),
    (s: string) => s.slice(0, start) + s.slice(start).replace('--retries=0', '--retries=2'),
    (s: string) => s.replace(' e2e/editor-geometry.spec.ts', ''),
    (s: string) => s.slice(0, start) + s.slice(start).replace('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }', 'exit 0'),
  ]) expect(() => authoringGate(mutate(ci))).toThrow();
});

it('requires real template and pinned visual acceptance, and the native bridge refuses absent prerequisites', () => {
  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = ci.split('  authoring-real-and-visual:')[1]!.split('  browser-diagnostics:')[0]!;
  expect(job).not.toContain('continue-on-error');
  expect(job).toContain('windows-2025');
  expect(job).toContain('node-version: 22.22.0');
  expect(job).toContain('e2e/compiler-templates.spec.ts e2e/authoring-visual.spec.ts --retries=0');
  expect(job).toContain('pnpm --filter @hivetex/web build');
  expect(job).toContain('pnpm exec playwright test --config playwright.production.config.ts --retries=0');
  const turbo = JSON.parse(readFileSync(new URL('../../../turbo.json', import.meta.url), 'utf8'));
  expect(turbo.globalDependencies).toEqual(expect.arrayContaining(['scripts/tex-distribution.mjs', 'scripts/tex-distribution.lock.json', 'scripts/tex-resource-adapter.js']));
  expect(job).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
  const desktop = readFileSync(new URL('../../../.github/workflows/desktop.yml', import.meta.url), 'utf8').split('  desktop-diagnostics:')[0]!;
  expect(desktop).not.toContain('continue-on-error: true');
  expect(desktop).toContain('vitest run test/native.test.ts');
  expect(desktop).toContain('vitest run test/native-managed.test.ts');
  expect(desktop).toContain('HIVETEX_TINYTEX_ROOT: ${{ runner.temp }}');
  expect(desktop).toContain('e2e/native-authoring.spec.ts e2e/local-real-compile.spec.ts --retries=0');
  expect(desktop).toContain("HIVETEX_DESKTOP_AUTHORING: '1'");
  expect(desktop).toContain("HIVETEX_NATIVE_TESTS: '1'");
});

it('requires the dedicated stress budget and retains its raw measurements', () => {
  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = ci.split('  authoring-stress:')[1]!.split('  browser-diagnostics:')[0]!;
  expect(job).not.toContain('continue-on-error');
  expect(job).toContain('windows-2025');
  expect(job).toContain('node-version: 22.22.0');
  expect(job).toContain('e2e/authoring-stress.spec.ts --retries=0');
  expect(job).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }');
  expect(job).toContain('if: always()'); expect(job).toContain('path: test-results/');
});

it('prepares verified TeX resources before every CI build or browser startup', () => {
  const ci = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const name of ['checks', 'data-safety-browser', 'authoring-browser', 'authoring-real-and-visual', 'authoring-stress', 'browser-diagnostics']) {
    const job = ci.split(`  ${name}:`)[1]?.split(/^ {2}[\w-]+:/m)[0] ?? '';
    const prepare = job.indexOf('uses: ./.github/actions/prepare-tex-distribution');
    const startup = job.search(/run: (?:pnpm turbo|pnpm exec playwright)/);
    expect(prepare, `${name}: explicit preparation`).toBeGreaterThan(job.indexOf('pnpm install --frozen-lockfile'));
    expect(prepare, `${name}: preparation precedes startup`).toBeLessThan(startup);
    expect(job).toContain('timeout-minutes: 10');
  }
  const action = readFileSync(new URL('../../../.github/actions/prepare-tex-distribution/action.yml', import.meta.url), 'utf8');
  expect(action).toContain("require('node:os').tmpdir()");
  expect(action).toContain("hashFiles('scripts/tex-distribution.lock.json')");
  expect(action).toContain('run: node scripts/tex-distribution.mjs');
  expect(action).not.toContain('apps/web/public/texlive');
});
