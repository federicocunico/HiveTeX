import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ENABLE = {
  rtc_cli: 'cd apps/desktop/src-tauri && cargo build --locked --example rtc_cli   (or HIVETEX_NATIVE_TESTS=1 pnpm --filter @hivetex/sync test)',
  tex_cli: 'cd apps/desktop/src-tauri && cargo build --locked --example tex_cli   (or HIVETEX_NATIVE_TESTS=1 pnpm --filter @hivetex/compile test)',
};

/**
 * A native suite that does not run here: named with the reason and how to enable it, at once and again in the summary at
 * the end of the run (native-test-summary.mjs, the vitest globalSetup). `ctx` (a vitest test context) also marks the
 * test skipped instead of passed. Never call it for a required run (HIVETEX_NATIVE_TESTS=1): that must fail.
 */
export function nativeSkip(suite, reason, enable, ctx) {
  const line = `native suite skipped: ${suite}: ${reason}. Enable: ${enable}`;
  console.warn(line);
  if (process.env.HIVETEX_NATIVE_SKIP_LOG) try { appendFileSync(process.env.HIVETEX_NATIVE_SKIP_LOG, `${line}\n`); } catch { /* summary only */ }
  ctx?.skip(`${reason}. Enable: ${enable}`);
}

/** Never run an existing, potentially stale bridge. Required CI also builds from a clean checkout. */
export function nativeTestBinary(example, suite = example) {
  if (!['rtc_cli', 'tex_cli'].includes(example)) throw new Error('Unknown native test bridge');
  const cwd = fileURLToPath(new URL('../apps/desktop/src-tauri/', import.meta.url));
  const base = resolve(cwd, process.env.CARGO_TARGET_DIR ?? 'target', 'debug', 'examples', example);
  const bin = process.platform === 'win32' ? `${base}.exe` : base;
  if (!existsSync(bin) && process.env.HIVETEX_NATIVE_TESTS !== '1') {
    nativeSkip(suite, `${example} is not built (${bin})`, ENABLE[example]);
    return null;
  }
  const desktop = fileURLToPath(new URL('../apps/desktop/', import.meta.url));
  const nodeBinary = process.platform === 'win32' ? 'node.exe' : process.platform === 'darwin' ? `node-${process.arch}` : 'node';
  let packaged = false;
  try { packaged = JSON.parse(readFileSync(resolve(cwd, 'resources/node/manifest.json'), 'utf8')).version === JSON.parse(readFileSync(resolve(desktop, 'worker.config.json'), 'utf8')).node && existsSync(resolve(cwd, 'resources/node', nodeBinary)); } catch { /* cold checkout */ }
  const prepare = spawnSync(process.execPath, [resolve(desktop, packaged ? 'worker-build.mjs' : 'prepare-worker.mjs')], { encoding: 'utf8', timeout: 180_000 });
  if (prepare.error || prepare.status !== 0) throw new Error(`Cannot prepare required native resources: ${prepare.error?.message ?? prepare.stderr ?? prepare.stdout}`);
  const result = spawnSync('cargo', ['build', '--locked', '--example', example], { cwd, encoding: 'utf8', timeout: 600_000 });
  if (result.error || result.status !== 0 || !existsSync(bin)) {
    throw new Error(`Cannot build required ${example}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
  return bin;
}
