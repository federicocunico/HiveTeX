#!/usr/bin/env node
/**
 * Checks that the compilers HiveTeX downloads (apps/desktop/src-tauri/src/managed.rs) are still published with the
 * pinned SHA-256 and size, using the digests GitHub publishes for release assets (nothing is downloaded).
 * Run weekly by .github/workflows/pinned-assets.yml; GITHUB_TOKEN (optional) raises the API rate limit.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'apps/desktop/src-tauri/src/managed.rs'), 'utf8');
const re = /asset!\("(\w+)", "([^"]+)", "(https:\/\/github\.com\/[^"]+)", "([0-9a-f]{64})", (\d+),/g;
const pinned = [...src.matchAll(re)].map(([, component, version, url, sha256, size]) => ({ component, version, url, sha256, size: Number(size) }));
if (pinned.length === 0) {
  console.error('no pinned assets found in managed.rs');
  process.exit(1);
}

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'hivetex-pinned-assets' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const releases = new Map();
let failed = 0;
for (const a of pinned) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(a.url);
  if (!m) {
    console.error(`✗ ${a.url}: not a GitHub release asset URL`);
    failed++;
    continue;
  }
  const [, owner, repo, tag, name] = m;
  const key = `${owner}/${repo}@${tag}`;
  if (!releases.has(key)) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`, { headers });
    releases.set(key, res.ok ? await res.json() : { error: res.status });
  }
  const rel = releases.get(key);
  const asset = rel.assets?.find((x) => x.name === decodeURIComponent(name));
  const problem = rel.error
    ? `release ${key} not found (${rel.error})`
    : !asset
      ? 'asset missing from the release'
      : asset.size !== a.size
        ? `size ${asset.size} != pinned ${a.size}`
        : asset.digest && asset.digest !== `sha256:${a.sha256}`
          ? `digest ${asset.digest} != pinned sha256:${a.sha256}`
          : null;
  if (problem) {
    console.error(`✗ ${a.component} ${a.version} ${decodeURIComponent(name)}: ${problem}`);
    failed++;
  } else console.log(`✓ ${a.component} ${a.version} ${decodeURIComponent(name)}`);
}
if (failed) {
  console.error(`${failed} pinned download(s) changed: update managed.rs (new version, size and digest).`);
  process.exit(1);
}
