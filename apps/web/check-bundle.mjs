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
  if (/^(pdf|wasm-engine|fake-engine|Landing|Workspace|codemirror)/.test(f) && refs.some((r) => r.endsWith(f))) {
    console.error(`lazy chunk ${f} is part of the initial load`);
    ok = false;
  }
}

// The deployed CSP (vercel.json) must allow what the build needs: the dev server and e2e run without it.
const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
const csp = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
const directive = (name) => (csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) ?? []).slice(1);
const fontSrc = directive('font-src').length ? directive('font-src') : directive('default-src');
for (const f of readdirSync(join(dist, 'assets'))) {
  if (!f.endsWith('.css')) continue;
  if (/url\(\s*["']?data:font\//.test(readFileSync(join(dist, 'assets', f), 'utf8')) && !fontSrc.includes('data:')) {
    console.error(`${f} embeds a font as a data: URI, which the deployed CSP blocks (font-src)`);
    ok = false;
  }
}
const helperPorts = readFileSync(new URL('./src/lib/helper-engine.ts', import.meta.url), 'utf8').match(/const PORTS = \[([^\]]+)\]/)?.[1].split(',').map((p) => p.trim()) ?? [];
for (const port of helperPorts) {
  if (!directive('connect-src').includes(`http://127.0.0.1:${port}`)) {
    console.error(`the deployed CSP (connect-src) does not allow the desktop helper on http://127.0.0.1:${port}`);
    ok = false;
  }
}
if (!helperPorts.length) {
  console.error('could not read the desktop helper ports from helper-engine.ts');
  ok = false;
}
if (!ok) process.exit(1);
