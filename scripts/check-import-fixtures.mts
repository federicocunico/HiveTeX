/** Local acceptance: pnpm exec tsx scripts/check-import-fixtures.mts <private-fixture-directory> <report.json> */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { readArchive, readLoose } from '../apps/web/src/lib/import/sources.js';
import { applyImport, planFor } from '../apps/web/src/lib/import/apply.js';
import { BlobManager } from '../packages/sync/src/blobs.js';
import { IndexedDbPersistence } from '../packages/sync/src/persistence.js';
import { acquireProject, projectHash } from '../packages/sync/src/snapshot.js';
import { Net, waitFor } from '../packages/sync/src/testkit.js';

const fixtureDir = resolve(process.argv[2] ?? '../data');
const reportPath = resolve(process.argv[3] ?? '.data/import-acceptance/inputs.json');
// Use the real browser persistence adapter with an isolated IndexedDB implementation; no user stores are opened.
const { IDBFactory, IDBKeyRange } = createRequire(new URL('../apps/web/package.json', import.meta.url))('fake-indexeddb');
Reflect.set(globalThis, 'IDBKeyRange', IDBKeyRange);
const factory = new IDBFactory();
const results: unknown[] = [];
async function compile(capture: Extract<Awaited<ReturnType<typeof acquireProject>>, { complete: true }>) {
  const dir = await mkdtemp(join(tmpdir(), 'hivetex-import-compile-'));
  for (const f of capture.capture.files) {
    if (f.kind === 'dir') continue;
    const path = join(dir, f.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, f.kind === 'text' ? f.text ?? '' : capture.assets.get(f.hash!)!);
  }
  const { main, engine } = capture.capture.settings;
  const version = spawnSync(engine, ['--version'], { encoding: 'utf8', windowsHide: true });
  const miktex = /miktex/i.test(version.stdout ?? '');
  const run = (exe: string, args: string[]) => spawnSync(exe, args, { cwd: dir, encoding: 'utf8', windowsHide: true,
    timeout: 90_000, env: { ...process.env, shell_escape: 'f', openin_any: 'p', openout_any: 'p' } });
  const tex = () => run(engine, ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape',
    ...(miktex ? ['-disable-installer', '-dont-parse-first-line'] : []), main]);
  let attempt = tex();
  const steps = [{ command: engine, status: attempt.status, error: attempt.error?.message }];
  const job = main.replace(/\.tex$/i, '');
  if (attempt.status === 0) {
    const aux = await readFile(join(dir, `${job}.aux`), 'utf8').catch(() => '');
    if (/\\bibdata/.test(aux)) {
      const bib = run('bibtex', [job]);
      steps.push({ command: 'bibtex', status: bib.status, error: bib.error?.message });
    }
    for (let i = 0; i < 2; i++) { attempt = tex(); steps.push({ command: engine, status: attempt.status, error: attempt.error?.message }); }
  }
  const pdf = await readFile(join(dir, `${job}.pdf`)).catch(() => null);
  const log = await readFile(join(dir, `${job}.log`), 'utf8').catch(() => String(attempt.stderr || attempt.stdout || attempt.error));
  const cause = log.split(/\r?\n/).filter(line => /^!|^l\.\d|not found|not installed|Emergency stop|Fatal error/i.test(line)).slice(0, 8);
  return { engine, main, directory: dir, steps, ok: steps.every(step => step.status === 0) && !!pdf, pdfBytes: pdf?.length ?? 0, cause };
}
async function folderItems(root: string, prefix = ''): Promise<Array<{ path: string; size: number; read(): Promise<Uint8Array> }>> {
  const out = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await folderItems(root, path));
    else if (entry.isFile()) {
      const bytes = new Uint8Array(await readFile(join(root, path)));
      out.push({ path, size: bytes.length, read: async () => bytes });
    }
  }
  return out;
}
for (const name of (await readdir(fixtureDir)).filter(name => name.endsWith('.zip'))) {
  let zipHash: string | undefined;
  for (const kind of ['zip', 'folder'] as const) {
    const bundle = kind === 'zip'
      ? readArchive(name, new Uint8Array(await readFile(join(fixtureDir, name))))
      : await readLoose(name, await folderItems(join(fixtureDir, name.slice(0, -4))), { stripRoot: false });
    const net = await Net.create();
    const dbName = `acceptance-${crypto.randomUUID()}`;
    let store = await IndexedDbPersistence.open(dbName, factory);
    const owner = await net.add('owner', 'owner', { store, authored: false });
    await owner.model.initializeLocal();
    const blobs = new BlobManager(owner.mesh, store);
    await applyImport(owner.model, bytes => blobs.add(bytes), await planFor(owner.model, bundle), {
      mode: 'merge', resolutions: new Map(), defaultResolution: 'keep', main: bundle.detection.main ?? undefined,
      engine: bundle.engine ?? undefined,
    });
    const initial = await acquireProject(owner.mesh, owner.model, blobs);
    assert.equal(initial.complete, true);
    if (!initial.complete) throw new Error('Incomplete local import');
    const hash = await projectHash(initial.capture);
    if (kind === 'zip') zipHash = hash;
    else assert.equal(hash, zipHash, 'Folder and ZIP must yield identical project inputs');
    assert.equal(owner.mesh.peers.length, 0);
    owner.mesh.destroy(); await owner.model.destroy(); store.close();
    store = await IndexedDbPersistence.open(dbName, factory);
    const reopened = await net.add('reopened', 'owner', { store, authored: false });
    const reopenedBlobs = new BlobManager(reopened.mesh, store);
    const after = await acquireProject(reopened.mesh, reopened.model, reopenedBlobs);
    assert.equal(after.complete, true);
    if (!after.complete) throw new Error('Incomplete reopen');
    assert.equal(await projectHash(after.capture), hash);
    const peer = await net.add('joining-editor', 'editor');
    const peerBlobs = new BlobManager(peer.mesh, peer.store);
    await net.link(reopened, peer);
    await waitFor(() => peer.model.list().length === bundle.files.length);
    const shared = await acquireProject(peer.mesh, peer.model, peerBlobs, { timeoutMs: 10_000, assetTimeoutMs: 10_000 });
    assert.equal(shared.complete, true);
    if (!shared.complete) throw new Error('Incomplete source sharing');
    assert.equal(await projectHash(shared.capture), hash);
    const compiler = kind === 'zip' && process.argv.includes('--compile') ? await compile(initial) : undefined;
    const result = { sample: name, kind, files: bundle.files.length, text: bundle.files.filter(f => f.kind === 'text').length,
      binary: bundle.files.filter(f => f.kind === 'binary').length, detection: bundle.detection, hash,
      zeroPeerInputs: true, reopenedInputs: true, laterPeerInputs: true, ...(compiler ? { compiler } : {}) };
    results.push(result); console.log(JSON.stringify(result));
    net.destroy();
    await Promise.all(net.nodes.map(async node => { await node.model.destroy(); node.store.close(); }));
  }
}
assert.ok(results.length, 'No ZIP fixtures found');
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
