#!/usr/bin/env node
/**
 * Sets the release version everywhere it is declared: `node scripts/set-version.mjs 0.1.0` (or `make version VERSION=0.1.0`).
 * MSI installers need a plain numeric x.y.z, so pre-release suffixes are refused.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/set-version.mjs <major.minor.patch>   (e.g. 0.1.0)');
  process.exit(1);
}

function edit(rel, fn) {
  const p = join(root, rel);
  const before = readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) console.log(`  unchanged ${rel}`);
  else {
    writeFileSync(p, after);
    console.log(`  updated   ${rel}`);
  }
}

// JSON files: replace the top-level "version" value only, keeping formatting.
const jsonVersion = (s) => s.replace(/^(\s{2}"version":\s*")[^"]*(")/m, `$1${version}$2`);
for (const f of ['package.json', 'apps/web/package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json']) edit(f, jsonVersion);

// Cargo.toml: the version line of [package].
edit('apps/desktop/src-tauri/Cargo.toml', (s) => s.replace(/(\[package\][^[]*?\nversion\s*=\s*")[^"]*(")/, `$1${version}$2`));
// Cargo.lock: our own crate's entry, so builds do not rewrite the lock file.
edit('apps/desktop/src-tauri/Cargo.lock', (s) => s.replace(/(name = "hivetex-desktop"\r?\nversion = ")[^"]*(")/, `$1${version}$2`));

console.log(`Version set to ${version}. Commit, then: make release VERSION=${version} CONFIRM=1`);
