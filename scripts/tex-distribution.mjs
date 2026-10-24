// Builds the same immutable resource distribution for Vite, deployed web and packaged desktop.
// No system TeX files or moving package-server endpoints participate in this build.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('../', import.meta.url));
const lockBytes = await readFile(new URL('./tex-distribution.lock.json', import.meta.url));
const lock = JSON.parse(lockBytes);
const adapter = (await readFile(new URL('./tex-resource-adapter.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
// Include the adapter/generator itself, so routing or map changes cannot reuse an incompatible cache.
export const distributionId = `tl2019-${sha(JSON.stringify(lock) + adapter + (await readFile(fileURLToPath(import.meta.url), 'utf8')).replace(/\r\n/g, '\n')).slice(0, 24)}`;
export const distributionPath = `texlive/${distributionId}/`;

async function acquire(url, expected, path) {
  let bytes = await readFile(path).catch(() => null);
  if (bytes && sha(bytes) === expected) return bytes;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`TeX distribution: ${url}: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (sha(bytes) !== expected) throw new Error(`TeX distribution checksum mismatch: ${url}`);
  await mkdir(join(path, '..'), { recursive: true });
  // Another preparation may extract this shared cache entry: never expose a partially written archive.
  const download = await mkdtemp(join(dirname(path), '.acquire-'));
  try {
    await writeFile(join(download, 'bytes'), bytes);
    await rename(join(download, 'bytes'), path);
  } finally {
    const owned = resolve(download);
    if (dirname(owned) !== resolve(dirname(path)) || !basename(owned).startsWith('.acquire-')) throw new Error('Unexpected TeX download directory');
    await rm(owned, { recursive: true, force: true });
  }
  return bytes;
}

export async function prepareTexDistribution() {
  const engines = new Map();
  for (const [name, checksum] of Object.entries(lock.engines)) {
    let bytes = await readFile(join(root, 'apps/web/public/swiftlatex', name));
    // Git's Windows checkout can change only the JS line endings. Verify and publish upstream LF bytes;
    // WASM remains byte-for-byte checked. Validate even when generated output already exists.
    if (name.endsWith('.js')) bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
    if (sha(bytes) !== checksum) throw new Error(`Vendored engine changed without updating the distribution lock: ${name}`);
    engines.set(name, bytes);
  }
  const parent = join(root, 'apps/web/public/texlive');
  const out = join(parent, distributionId);
  // These are generated build artifacts only. Browser caches retain all previously usable distributions.
  async function pruneBuildArtifacts() {
    for (const entry of await readdir(parent)) {
      if (entry === distributionId || !/^tl2019-[a-f0-9]{24}$/.test(entry)) continue;
      const target = resolve(parent, entry);
      if (dirname(target) !== resolve(parent)) throw new Error('Generated TeX path escaped its output directory');
      await rm(target, { recursive: true, force: true });
    }
  }
  if (await readFile(join(out, 'manifest.json')).then(() => true, () => false)) { await pruneBuildArtifacts(); return; }
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(tmpdir(), 'hivetex-tex-distribution-'));
  // Keep an active publisher outside Vite's public tree, on the same destination volume for atomic rename.
  // Each invocation cleans only its own directories; another build may still be writing its staging set.
  const publisherParent = resolve(root, 'apps/web');
  let publish;
  try {
    publish = await mkdtemp(join(publisherParent, '.texlive-staging-'));
    const tree = join(staging, 'tree');
    await mkdir(tree); await mkdir(join(publish, 'files'), { recursive: true });
    await mkdir(join(publish, 'sources'));
    const cache = join(tmpdir(), 'hivetex-texlive-2019');
    await mkdir(cache, { recursive: true });
    for (const archive of lock.archives) {
      const path = join(cache, archive.name);
      await acquire(lock.archiveBase + archive.name, archive.sha256, path);
      if (archive.kind === 'runtime') {
        const extraction = spawnSync('tar', ['-xf', path, '-C', tree], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
        if (extraction.status !== 0) throw new Error(`Extract ${archive.name}: ${extraction.stderr}`);
      } else {
        // Ship unchanged documentation, license notices and corresponding sources alongside the runtime files.
        await copyFile(path, join(publish, 'sources', archive.name));
      }
    }
    const files = {};
    const paths = new Map();
    async function walk(dir) {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else paths.set(basename(path), path);
      }
    }
    await walk(tree);
    async function add(name, bytes) {
      const hash = sha(bytes);
      files[name] = hash;
      await writeFile(join(publish, 'files', hash), bytes);
    }
    for (const [name, path] of paths) await add(name, await readFile(path));
    await add('pdftex.map', Buffer.concat(await Promise.all(['cm.map', 'cmextra.map', 'latxfont.map', 'symbols.map', 'cm-super-ts1.map'].map(name => readFile(paths.get(name))))));
    for (const [name, checksum] of Object.entries(lock.formats)) {
      await add(name, await acquire(lock.formatBase + name, checksum, join(tmpdir(), 'hivetex-swiftlatex-fixtures', name)));
    }
    const assets = {};
    for (let [name, bytes] of engines) {
      if (name.endsWith('.js')) {
        let source = bytes.toString();
        const engine = name.includes('pdftex') ? 'pdftex' : 'xetex';
        const replace = (from, to) => {
          if (source.split(from).length !== 2) throw new Error(`Vendored adapter pattern changed: ${name}: ${from}`);
          source = source.replace(from, to);
        };
        replace(`const remote_url=self.texlive_endpoint+"${engine}/"+cacheKey;`, 'const resource=self.hivetexResource(cacheKey);if(!resource){texlive404_cache[cacheKey]=1;return 0}const remote_url=resource.url;');
        replace('const fileid=xhr.getResponseHeader("fileid");', 'const fileid=resource.id;');
        if (engine === 'pdftex') {
          replace('const remote_url=self.texlive_endpoint+"pdftex/pk/"+cacheKey;', 'const resource=self.hivetexResource(cacheKey,true);if(!resource){pk404_cache[cacheKey]=1;return 0}const remote_url=resource.url;');
          replace('const pkid=xhr.getResponseHeader("pkid");', 'const pkid=resource.id;');
        }
        const prefix = `// HiveTeX immutable TL2019 resource adapter. Upstream source and checksums: manifest.json.\nconst hivetexFiles=${JSON.stringify(files)};\n${adapter}\n`;
        bytes = Buffer.from(prefix + source);
      }
      assets[name] = sha(bytes);
      await writeFile(join(publish, name), bytes);
    }
    await writeFile(join(publish, 'NOTICE.txt'), `HiveTeX compatible TeX distribution ${distributionId}\n${lock.release}\n\nRuntime files are unchanged except the generated pdftex.map and the documented worker URL adapter.\nPackage copyright/license notices remain in the files and accompanying sources/*.doc.tar.xz and *.source.tar.xz archives.\nPackage metadata (*.tlpobj in the manifest) identifies each original license and revision.\nSwiftLaTeX is AGPL-3.0: https://github.com/SwiftLaTeX/SwiftLaTeX/tree/v20022022\nFormats: ${lock.formatBase}\nOriginal TeX Live archives: ${lock.archiveBase}\nReproduce this distribution with scripts/tex-distribution.mjs and tex-distribution.lock.json in the HiveTeX source.\n`);
    await writeFile(join(publish, 'manifest.json'), JSON.stringify({ id: distributionId, ...lock, files, assets }, null, 2) + '\n');
    // Publish atomically on the destination volume; a failed preparation cannot mark a partial set ready.
    try { await rename(publish, out); } catch (error) {
      if (!await readFile(join(out, 'manifest.json')).then(() => true, () => false)) throw error;
    }
    await pruneBuildArtifacts();
    console.log(`Prepared ${distributionId}: ${Object.keys(files).length} compatible TeX resources`);
  } finally {
    if (publish) {
      const owned = resolve(publish);
      if (dirname(owned) !== publisherParent || !basename(owned).startsWith('.texlive-staging-')) throw new Error('Unexpected TeX publisher directory');
      await rm(owned, { recursive: true, force: true });
    }
    const scratch = resolve(staging);
    if (dirname(scratch) !== resolve(tmpdir()) || !basename(scratch).startsWith('hivetex-tex-distribution-')) throw new Error('Unexpected TeX scratch directory');
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await prepareTexDistribution();
