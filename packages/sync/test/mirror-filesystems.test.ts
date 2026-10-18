import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { type FsAdapter, MARKER_FILE, MirrorSync, type MirrorOptions } from '../src/mirror.js';
import { nodeFs } from '../src/mirror-node.js';
import { Net, type Node, waitFor } from '../src/testkit.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null | undefined) => (b ? new TextDecoder().decode(b) : b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETAINED = 'Retained folder inode';
/** libuv: open with no sharing on Windows (not exported by node:fs constants). */
const UV_FS_O_EXLOCK = 0x10000000;
let net: Net | undefined;
const mirrors: MirrorSync[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const m of mirrors.splice(0)) m.stop();
  net?.destroy(); net = undefined;
  await sleep(30);
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
});
const temp = async () => { const d = await mkdtemp(join(tmpdir(), 'hivetex-mirror-fs-')); dirs.push(d); return d; };

/** In-memory folder with switchable faults and a call log (who read what), for per-path failure tests. */
function memFs(files: Record<string, string> = {}) {
  const disk = new Map(Object.entries(files).map(([p, s]) => [p, enc(s)] as [string, Uint8Array]));
  const f = { offline: false, locked: new Set<string>(), noteDirs: new Set<string>(), reads: new Map<string, number>(), writes: new Map<string, number>(),
    writeError: null as ((path: string) => Error | null) | null };
  let notify: (e: { path: string; error?: unknown }) => void = () => {};
  const down = () => Object.assign(new Error('the drive is not ready'), { code: 'ENODEV' });
  const fs: FsAdapter = {
    list: async () => { if (f.offline) throw down(); return [...disk].map(([path, b]) => ({ path, size: b.length })); },
    read: async (path) => {
      f.reads.set(path, (f.reads.get(path) ?? 0) + 1);
      if (f.offline) throw down();
      if (f.noteDirs.has(path)) throw Object.assign(new Error('illegal operation on a directory'), { code: 'EISDIR' });
      if (f.locked.has(path)) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      return disk.get(path) ?? null;
    },
    write: async (path, b) => {
      f.writes.set(path, (f.writes.get(path) ?? 0) + 1);
      if (f.offline) throw down();
      const e = f.writeError?.(path); if (e) throw e;
      if (f.locked.has(path)) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      disk.set(path, b);
    },
    remove: async (path) => { if (f.offline) throw down(); if (f.locked.has(path)) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }); disk.delete(path); },
    watch: (cb) => { notify = cb; return () => {}; },
  };
  return { fs, disk, f, event: (path: string) => notify({ path }), error: (error: unknown) => notify({ path: '', error }) };
}

async function owner() { net = await Net.create(); return net.add('owner', 'owner'); }
function bind(n: Node, fs: FsAdapter, opts: Partial<MirrorOptions> = {}) {
  const notices: string[] = [];
  const mirror = new MirrorSync({ model: n.model, mesh: n.mesh, blobs: new BlobManager(n.mesh, n.store), fs, getRole: () => n.role, debounceMs: 1, retryMs: 10, retainedSettleMs: 20, onNotice: (m) => notices.push(m), ...opts });
  mirrors.push(mirror);
  return { mirror, notices, started: mirror.start() };
}

describe('folder writes on filesystems without hard links (6.1)', () => {
  it('a publication that loses the file never becomes a shared deletion, and the next write restores it', async () => {
    const n = await owner();
    const id = await n.model.createTextNow('main.tex', 'v1');
    const m = memFs({ 'main.tex': 'v1' });
    let fail = false;
    const write = m.fs.write.bind(m.fs);
    // The worst case: the original was set aside, publication and rollback both failed, the watcher saw the absence.
    m.fs.write = async (path, b) => {
      if (fail && path === 'main.tex') { m.disk.delete(path); m.event(path); throw new Error('publication and rollback failed'); }
      return write(path, b);
    };
    const s = bind(n, m.fs, { marker: { id: 'p1', slug: 'paper' } });
    await s.started;
    fail = true;
    (await n.model.openText(id)).insert(2, ' edited');
    await waitFor(() => s.notices.some((x) => x.includes('publication and rollback failed')));
    await sleep(60);
    expect(n.model.byId(id)?.path).toBe('main.tex');
    fail = false;
    await waitFor(() => dec(m.disk.get('main.tex')) === 'v1 edited');
    expect(n.model.byId(id)?.path).toBe('main.tex');
  });
});

describe('recovery copies are transient and only for external work (6.2)', () => {
  it('a simulated hour of co-author typing leaves no copy in the folder and none in Recovery', async () => {
    const n = await owner(); const dir = await temp(); const fs = nodeFs(dir);
    const id = await n.model.createTextNow('main.tex', 'start');
    const s = bind(n, fs, { debounceMs: 5, marker: { id: 'p1', slug: 'paper' } }); await s.started;
    await waitFor(async () => (await readFile(join(dir, 'main.tex'), 'utf8').catch(() => '')) === 'start');
    const text = await n.model.openText(id);
    // One remote burst every 30 simulated seconds for an hour: each one replaces the file in the folder.
    for (let i = 0; i < 120; i++) {
      text.insert(text.length, ` w${i}`);
      const want = text.toString();
      await waitFor(async () => (await readFile(join(dir, 'main.tex'), 'utf8').catch(() => '')) === want, 4000);
    }
    await waitFor(async () => (await fs.retained!()).length === 0, 4000);
    expect((await readdir(dir)).sort()).toEqual([MARKER_FILE, 'main.tex']);
    expect((await s.mirror.recoveries()).filter((r) => r.reason.includes(RETAINED))).toEqual([]);
  });

  it('external bytes written through a handle after the last read produce exactly one Recovery entry', async () => {
    const n = await owner(); const dir = await temp(); const fs = nodeFs(dir);
    await writeFile(join(dir, 'main.tex'), 'agreed');
    const id = await n.model.createTextNow('main.tex', 'agreed');
    const s = bind(n, fs, { retainedSettleMs: 300 }); await s.started;
    const external = await open(join(dir, 'main.tex'), 'r+');
    try {
      (await n.model.openText(id)).insert(6, ' by a co-author');
      await waitFor(async () => (await readFile(join(dir, 'main.tex'), 'utf8').catch(() => '')) === 'agreed by a co-author');
      await external.write('external unsaved work', 0); await external.sync(); // lands in the retained inode
    } finally { await external.close(); }
    await waitFor(async () => (await fs.retained!()).length === 0, 4000);
    const kept = (await s.mirror.recoveries()).filter((r) => r.path === 'main.tex');
    expect(kept).toHaveLength(1);
    expect(dec(await s.mirror.recoveryBytes(kept[0]!.id))).toContain('external unsaved work');
    expect(await n.store.listBlobs()).toEqual([]); // never a shared blob
  });

  it('captures copies left by an earlier session once, removes them and does not read them again', async () => {
    const n = await owner(); const dir = await temp();
    await mkdir(join(dir, '.hivetex-recovery'));
    await writeFile(join(dir, '.hivetex-recovery', `main.tex.${'a'.repeat(32)}.retained`), 'left over');
    const s = bind(n, nodeFs(dir)); await s.started;
    expect((await s.mirror.recoveries()).filter((r) => r.path === 'main.tex').map((r) => r.reason)).toEqual([expect.stringContaining(RETAINED)]);
    expect(await readdir(dir)).not.toContain('.hivetex-recovery');
    // A copy the folder refuses to drop is remembered and not read again on the next start.
    const m = memFs({ [`.hivetex-recovery/a.tex.${'b'.repeat(32)}.retained`]: 'kept' });
    m.fs.retained = async () => [...m.disk].filter(([p]) => p.startsWith('.hivetex-recovery/')).map(([path, b]) => ({ path, size: b.length }));
    m.fs.dropRetained = async () => { throw new Error('locked'); };
    const a = bind(n, m.fs); await a.started; a.mirror.stop();
    const reads = m.f.reads.get(`.hivetex-recovery/a.tex.${'b'.repeat(32)}.retained`);
    const b = bind(n, m.fs); await b.started; await b.mirror.recoveries();
    expect(m.f.reads.get(`.hivetex-recovery/a.tex.${'b'.repeat(32)}.retained`)).toBe(reads);
  });
});

describe('folder errors are isolated per path (6.3)', () => {
  it('a new subfolder starts no read-error notice or retry loop', async () => {
    const n = await owner(); const dir = await temp();
    await n.model.createTextNow('sections/a.tex', 'a');
    const s = bind(n, nodeFs(dir)); await s.started;
    await mkdir(join(dir, 'figs', 'deep'), { recursive: true });
    await writeFile(join(dir, 'figs', 'deep', 'b.tex'), 'b');
    await waitFor(() => !!n.model.find('figs/deep/b.tex'));
    await sleep(150);
    expect(s.notices.filter((x) => x.startsWith('Could not read'))).toEqual([]);
    // An adapter that still reports a directory: neither a known folder nor EISDIR becomes a retry loop.
    const m = memFs(); m.f.noteDirs.add('figs');
    const t = bind(n, m.fs); await t.started;
    m.event('sections'); m.event('figs');
    await sleep(100);
    expect(m.f.reads.get('sections') ?? 0).toBe(0);
    expect(m.f.reads.get('figs') ?? 0).toBeLessThanOrEqual(2);
    expect(t.notices.filter((x) => x.startsWith('Could not read'))).toEqual([]);
  });

  it('a locked file delays only its own removal; the other files arrive and the removal settles on release', async () => {
    const n = await owner();
    const old = await n.model.createTextNow('figs/old.tex', 'old');
    const m = memFs({ 'figs/old.tex': 'old' });
    const s = bind(n, m.fs); await s.started;
    m.f.locked.add('figs/old.tex'); // a viewer holds it without sharing
    n.model.delete(old);
    await n.model.createTextNow('figs/new.tex', 'new');
    await waitFor(() => dec(m.disk.get('figs/new.tex')) === 'new');
    await waitFor(() => s.notices.some((x) => x.includes('"figs/old.tex"') && x.includes('pending')));
    expect(m.disk.has('figs/old.tex')).toBe(true);
    m.f.locked.delete('figs/old.tex');
    await waitFor(() => !m.disk.has('figs/old.tex'), 5000);
    expect(dec(m.disk.get('figs/new.tex'))).toBe('new');
  });

  it.runIf(process.platform === 'win32')('a file opened without sharing on NTFS blocks only itself', async () => {
    const n = await owner(); const dir = await temp();
    const old = await n.model.createTextNow('figs/old.tex', 'old');
    const s = bind(n, nodeFs(dir)); await s.started;
    await waitFor(async () => (await readFile(join(dir, 'figs', 'old.tex'), 'utf8').catch(() => '')) === 'old');
    // Exclusive: it succeeds only between the mirror's own reads of its echo.
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let i = 0; i < 100 && !lock; i++) lock = await open(join(dir, 'figs', 'old.tex'), constants.O_RDONLY | UV_FS_O_EXLOCK).catch(() => sleep(20).then(() => undefined));
    if (!lock) throw new Error('could not lock figs/old.tex');
    try {
      n.model.delete(old);
      await n.model.createTextNow('figs/new.tex', 'new');
      await waitFor(async () => (await readFile(join(dir, 'figs', 'new.tex'), 'utf8').catch(() => '')) === 'new');
      await waitFor(() => s.notices.some((x) => x.includes('"figs/old.tex"') && x.includes('pending')));
    } finally { await lock.close(); }
    await waitFor(async () => !(await readdir(join(dir, 'figs'))).includes('old.tex'), 8000);
  });

  it('writes resume after the drive disconnects and returns, without a restart', async () => {
    const n = await owner();
    const id = await n.model.createTextNow('main.tex', 'v1');
    const m = memFs({ 'main.tex': 'v1' });
    const s = bind(n, m.fs); await s.started;
    m.f.offline = true;
    (await n.model.openText(id)).insert(2, ' while away');
    m.error(new Error('watcher lost the drive')); // the watcher also fails: a restart is retried meanwhile
    await waitFor(() => s.notices.filter((x) => x.includes('drive is not ready')).length >= 2);
    m.f.offline = false;
    await waitFor(() => dec(m.disk.get('main.tex')) === 'v1 while away', 5000);
    (await n.model.openText(id)).insert(0, '% ');
    await waitFor(() => dec(m.disk.get('main.tex')) === '% v1 while away');
  });

  it('a pending table retry does not swallow a restart (separate timers)', async () => {
    const n = await owner();
    await n.model.createTextNow('main.tex', 'v1');
    const m = memFs({ 'main.tex': 'v1' });
    const s = bind(n, m.fs, { retryMs: 30 }); await s.started;
    m.f.offline = true;
    await n.model.createTextNow('b.tex', 'b'); // table pass fails: table retry pending
    await waitFor(() => s.notices.some((x) => x.startsWith('Could not reconcile')));
    m.error(new Error('watch failed')); // restart requested while the table retry is pending
    await sleep(40);
    m.f.offline = false;
    // b.tex can only be written once the restart rescanned the folder.
    await waitFor(() => dec(m.disk.get('b.tex')) === 'b', 5000);
    await n.model.createTextNow('c.tex', 'c');
    await waitFor(() => dec(m.disk.get('c.tex')) === 'c');
  });
});

describe('minor mirror cases (6.4)', () => {
  it('a case-only rename on the real filesystem leaves exactly the new spelling', async () => {
    const n = await owner(); const dir = await temp();
    const id = await n.model.createTextNow('Intro.tex', 'introduction');
    const s = bind(n, nodeFs(dir), { debounceMs: 20 }); await s.started;
    await waitFor(async () => (await readdir(dir)).includes('Intro.tex'));
    n.model.rename(id, 'intro.tex');
    await waitFor(async () => (await readdir(dir)).includes('intro.tex') && !(await readdir(dir)).includes('Intro.tex'), 5000);
    await sleep(300);
    expect(await readFile(join(dir, 'intro.tex'), 'utf8')).toBe('introduction');
    expect(n.model.list().filter((f) => f.kind !== 'dir').map((f) => f.path)).toEqual(['intro.tex']);
    expect(s.notices.filter((x) => x.includes('collision'))).toEqual([]);
  });

  it('an NFD name from a macOS listing is the same file as the NFC project path', async () => {
    const n = await owner();
    const id = await n.model.createTextNow('café.tex', 'same');
    const m = memFs();
    const nfd = 'café.tex';
    m.disk.set(nfd, enc('same'));
    // HFS+: names come back decomposed, either form opens the file.
    const read = m.fs.read.bind(m.fs);
    m.fs.read = (p) => read(p.normalize('NFC') === 'café.tex' ? nfd : p);
    m.fs.write = async (p, b) => { m.disk.set(p.normalize('NFC') === 'café.tex' ? nfd : p, b); };
    const s = bind(n, m.fs); await s.started;
    m.event(nfd);
    (await n.model.openText(id)).insert(4, ' edit');
    await waitFor(() => dec(m.disk.get(nfd)) === 'same edit');
    expect(n.model.list().map((f) => f.path)).toEqual(['café.tex']);
    expect(s.notices.filter((x) => x.includes('collision') || x.includes('conflicting'))).toEqual([]);
  });

  it('a missing marker pauses deletions without a retry loop and the marker coming back settles them', async () => {
    const n = await owner();
    const id = await n.model.createTextNow('main.tex', 'm');
    await n.model.createTextNow('other.tex', 'o');
    const m = memFs({ 'main.tex': 'm', 'other.tex': 'o' });
    const s = bind(n, m.fs, { marker: { id: 'p1', slug: 'paper' } }); await s.started;
    await waitFor(() => m.disk.has(MARKER_FILE));
    const marker = m.disk.get(MARKER_FILE)!;
    m.disk.delete(MARKER_FILE); m.disk.delete('main.tex');
    m.event('main.tex');
    await waitFor(() => s.notices.some((x) => x.includes('marker')));
    const reads = m.f.reads.get(MARKER_FILE);
    await sleep(200);
    expect(m.f.reads.get(MARKER_FILE)).toBe(reads); // no loop
    expect(n.model.byId(id)).toBeDefined();
    m.disk.set(MARKER_FILE, marker); m.event(MARKER_FILE);
    await waitFor(() => !n.model.byId(id));
    expect(n.model.find('other.tex')).toBeDefined();
  });

  it('ignored folder files never block a project path in later table passes', async () => {
    const n = await owner();
    await n.model.createTextNow('Scratch', 'a project file without an extension');
    const m = memFs({ '.hivetexignore': 'scratch/\n', 'scratch/notes.tex': 'local only' });
    const s = bind(n, m.fs); await s.started;
    await waitFor(() => m.disk.has('Scratch'));
    m.disk.delete('Scratch');
    await n.model.createTextNow('b.tex', 'b'); // a table pass
    await waitFor(() => m.disk.has('b.tex'));
    expect(s.notices.filter((x) => x.includes('"scratch/notes.tex"'))).toEqual([]);
    expect(n.model.find('scratch/notes.tex')).toBeUndefined();
  });

  it('target/ is never mirrored, as in the native walk', async () => {
    const n = await owner(); const dir = await temp();
    await mkdir(join(dir, 'target'), { recursive: true });
    await writeFile(join(dir, 'target', 'build.tex'), 'native build output');
    await n.model.createTextNow('target/x.tex', 'never written');
    const s = bind(n, nodeFs(dir)); await s.started;
    await sleep(100);
    expect(n.model.find('target/build.tex')).toBeUndefined();
    expect(await readdir(join(dir, 'target'))).toEqual(['build.tex']);
  });

  it('a parent that became a file is held as a collision instead of retried forever', async () => {
    const n = await owner();
    await n.model.createTextNow('sections/a.tex', 'a');
    const m = memFs();
    m.f.writeError = (p) => (p === 'sections/a.tex' ? Object.assign(new Error('ENOTDIR: a parent folder of "sections/a.tex" is a file'), { code: 'ENOTDIR' }) : null);
    const s = bind(n, m.fs); await s.started;
    await waitFor(() => s.notices.some((x) => x.includes('parent folder')));
    await sleep(150);
    expect(m.f.writes.get('sections/a.tex')).toBe(1);
    expect(n.model.find('sections/a.tex')).toBeDefined();
  });
});
