#!/usr/bin/env node
/**
 * Builds the desktop installers on this machine the way the release build does (same `tauri build`, same bundled worker
 * and web app, the production server baked in as the sign-in default), and copies them to ./dist-installer with their
 * SHA-256, so the exact file can be handed to someone for testing: `make installer` or `node scripts/build-installer.mjs`.
 *
 *   API_BASE=https://other.example   server baked into the installer (default: the GitHub variable HIVETEX_API_BASE when
 *                                    gh is logged in, else https://hivetex.vercel.app)
 *   TAURI_SIGNING_PRIVATE_KEY=...    set it (path or content) to also produce the updater signatures, as the release does;
 *                                    without it the build is unsigned for updates and says so
 *   --bundles nsis,msi               limit the bundle types (default: all of this OS)
 *   CARGO_TARGET_DIR=E:\build\target  put the Rust build (several GB) on another drive
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const out = join(root, 'dist-installer');
// CARGO_TARGET_DIR (e.g. on a roomier drive) moves the Rust build output, bundles included.
const bundleDir = join(process.env.CARGO_TARGET_DIR || join(desktop, 'src-tauri', 'target'), 'release', 'bundle');
const shell = process.platform === 'win32';

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell, ...opts });
const capture = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell });
  return r.status === 0 ? r.stdout.trim() : '';
};

const version = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
const bundlesArg = process.argv.indexOf('--bundles');
const bundles = bundlesArg > 0 ? process.argv[bundlesArg + 1] : '';

const apiBase = process.env.API_BASE || capture('gh', ['variable', 'get', 'HIVETEX_API_BASE']) || 'https://hivetex.vercel.app';
const signed = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);

console.log(`Building installers for version ${version}`);
console.log(`  default server: ${apiBase}`);
console.log(`  updater signatures: ${signed ? 'yes' : 'no (set TAURI_SIGNING_PRIVATE_KEY to sign)'}`);

const args = ['--filter', '@hivetex/desktop', 'tauri', 'build'];
if (!signed) {
  const cfg = join(tmpdir(), `hivetex-no-updater-${process.pid}.json`);
  writeFileSync(cfg, '{"bundle":{"createUpdaterArtifacts":false}}');
  args.push('--config', cfg);
}
if (bundles) args.push('--bundles', ...bundles.split(','));

// Old bundles must not be mistaken for this build's output.
rmSync(bundleDir, { recursive: true, force: true });
const built = run('pnpm', args, { env: { ...process.env, VITE_API_BASE: apiBase } });
if (built.status !== 0) {
  console.error('The installer build failed (see above).');
  process.exit(built.status ?? 1);
}

const wanted = /\.(exe|msi|dmg|deb|rpm|AppImage|sig)$/i;
const found = [];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (wanted.test(name) && name.includes(version)) found.push(p);
  }
};
walk(bundleDir);
if (found.length === 0) {
  console.error(`No installer for ${version} found under ${bundleDir}.`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sums = [];
console.log(`\nInstallers (copied to ${out}):`);
for (const p of found) {
  const name = p.split(/[\\/]/).pop();
  copyFileSync(p, join(out, name));
  if (!name.endsWith('.sig')) {
    const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
    sums.push(`${sha}  ${name}`);
    console.log(`  ${name}  ${(statSync(p).size / 1048576).toFixed(1)} MB  sha256 ${sha.slice(0, 16)}…`);
  }
}
writeFileSync(join(out, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);
console.log('\nHand over the .exe (NSIS setup) for testing; the .msi is for managed installs. Checksums: SHA256SUMS.txt');
console.log('Windows may show SmartScreen for an unsigned installer: More info > Run anyway (see README first-launch notes).');
