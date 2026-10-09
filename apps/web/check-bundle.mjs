// Fails when the JS needed for first paint exceeds the budget, or when lazy chunks leak into it.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = new URL('./dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
const BUDGET = 250 * 1024;
let total = 0;
for (const r of refs) {
  const size = gzipSync(readFileSync(join(dist, r))).length;
  total += size;
  console.log(`initial  ${r}  ${(size / 1024).toFixed(1)} KB gz`);
}
console.log(`initial JS total: ${(total / 1024).toFixed(1)} KB gz (budget ${BUDGET / 1024} KB)`);
let ok = total <= BUDGET;
for (const f of readdirSync(join(dist, 'assets'))) {
  if (/^(pdf|wasm-engine|fake-engine)/.test(f) && refs.some((r) => r.endsWith(f))) {
    console.error(`lazy chunk ${f} is part of the initial load`);
    ok = false;
  }
}
if (!ok) process.exit(1);
