// Test audit (docs/testing.md): lists "fixed real-time wait, then a positive assertion" sites, which pass on a fast
// machine and fail on a loaded CI runner. Usage: node scripts/audit-tests.mjs [repo]
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? '.';
const files = [];
const walk = (d) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name.startsWith('.') || f.name === 'target' || f.name === 'vendor') continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.(test|spec)\.(ts|mjs)$/.test(f.name)) files.push(p);
  }
};
for (const d of ['packages', 'server/test', 'apps/web/test', 'e2e', 'apps/desktop/e2e']) {
  const p = path.join(root, d);
  if (fs.existsSync(p)) walk(p);
}
const FIXED = /await (tick|sleep|wait|flushMicro)\(\s*\d*\s*\)|setTimeout\(r, ?\d+\)\)|waitForTimeout\(|await new Promise\(\(r\) => setTimeout\(r, ?\d+\)\)/;
const rows = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  const sites = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!FIXED.test(lines[i])) continue;
    // The next statement is a plain (non-polling) assertion.
    const first = (lines[i + 1] ?? '').trim();
    if (!/^expect\(/.test(first) || /\.poll/.test(first)) continue;
    // Deterministic: fake timers active in this test (looked up to 40 lines back).
    const ctx = lines.slice(Math.max(0, i - 40), i).join('\n');
    if (/useFakeTimers|advanceTimersByTime/.test(ctx) || /advanceTimers/.test(lines[i])) continue;
    // Negative: asserting that nothing happened within the wait is what a fixed wait is for.
    if (/\.not\.|toBe\((0|false|null|undefined)\)|toBeUndefined|toBeNull|toBeFalsy|toEqual\(\[\]\)|toHaveLength\(0\)|toBe\(1\)\s*;\s*\/\/.*(still|only|once)/.test(first)) continue;
    sites.push(i + 1);
  }
  const short = [];
  lines.forEach((l, i) => { const m = /\},\s*(\d[\d_]*)\);\s*$/.exec(l); if (m && Number(m[1].replace(/_/g, '')) < 10000 && /it\(|test\(/.test(lines.slice(Math.max(0, i - 80), i).join('\n'))) short.push(i + 1); });
  if (sites.length) rows.push({ file: path.relative(root, f).replace(/\\/g, '/'), sites: sites.length, at: sites.slice(0, 6).join(',') });
}
rows.sort((a, b) => b.sites - a.sites);
for (const r of rows) console.log(`${String(r.sites).padStart(3)}  ${r.file}  (lines ${r.at})`);
console.log(`files: ${rows.length}, fixed-wait-then-assert sites: ${rows.reduce((a, r) => a + r.sites, 0)}`);
