// vitest globalSetup (sync, compile): repeats at the end of the run every native suite that was skipped here, with how
// to enable it (native-test-bin.mjs). Workers inherit the log path through the environment.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'hivetex-native-skips-'));
  process.env.HIVETEX_NATIVE_SKIP_LOG = join(dir, 'skips.txt');
  return () => {
    let lines = [];
    try { lines = [...new Set(readFileSync(process.env.HIVETEX_NATIVE_SKIP_LOG, 'utf8').split('\n').filter(Boolean))]; } catch { /* none */ }
    rmSync(dir, { recursive: true, force: true });
    if (lines.length) console.warn(`\n${lines.length} native suite(s) skipped; this run is not native acceptance:\n${lines.map((l) => `  - ${l}`).join('\n')}\n`);
  };
}
