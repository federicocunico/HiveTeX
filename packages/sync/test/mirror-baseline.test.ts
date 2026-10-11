import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileDocId } from '@hivetex/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { OfflineFork } from '../src/fork.js';
import { type FsAdapter, MirrorSync } from '../src/mirror.js';
import { nodeFs } from '../src/mirror-node.js';
import { Net, type Node } from '../src/testkit.js';

/**
 * F15: the folder mirror keeps a merge baseline from the moment disk and project agree, advances it only after a write
 * succeeded, never writes content the project does not have yet, and never lets a viewer's folder change the project.
 */

let net: Net;
const dirs: string[] = [];
const mirrors: MirrorSync[] = [];
afterEach(async () => {
  for (const m of mirrors.splice(0)) m.stop();
  net?.destroy();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error('waitFor timed out');
}
const read = (dir: string, p: string) => readFile(join(dir, p), 'utf8').catch(() => null);
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), 'p2p-mirror-base-'));
  dirs.push(d);
  return d;
}
const complete = (n: Node, id: string) => n.model.availability(fileDocId(id)) === 'complete';
const disk = async (dir: string, p: string) => JSON.stringify(await read(dir, p));

/** A real folder whose writes can be failed or parked, and whose change events can be muted. */
function controlled(dir: string) {
  const real = nodeFs(dir);
  const ctl = { failWrites: 0, hold: false, parked: [] as Array<() => void>, mute: false };
  const fs: FsAdapter = {
    ...real,
    watch: (cb) => real.watch((ev) => (ctl.mute ? undefined : cb(ev))),
    async write(path, bytes) {
      if (ctl.hold) await new Promise<void>((r) => ctl.parked.push(r));
      if (ctl.failWrites > 0) {
        ctl.failWrites--;
        throw new Error('disk full');
      }
      await real.write(path, bytes);
    },
  };
  return { fs, ctl };
}

type Opts = ConstructorParameters<typeof MirrorSync>[0];
async function bindWith(node: Node, fs: FsAdapter, extra: Partial<Opts> = {}, notices: string[] = []) {
  const blobs = new BlobManager(node.mesh, node.store);
  const m = new MirrorSync({ model: node.model, mesh: node.mesh, blobs, fs, getRole: () => node.role, onNotice: (n) => notices.push(n), debounceMs: 30, retryMs: 40, ...extra });
  mirrors.push(m);
  await m.start();
  return m;
}

const revisions = (n: Node) => n.model.list().map((f) => `${f.id}:${f.path}:${n.model.revision(fileDocId(f.id))}`);

describe('baseline from equal content', () => {
  it('merges a peer edit and a disk edit that both start from the matching initial file', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    const id = await b.model.createTextNow('main.tex', 'BASE');
    await writeFile(join(dir, 'main.tex'), 'BASE');
    await a.mesh.reconcile(fileDocId(id));
    await waitFor(() => complete(a, id));
    const { fs, ctl } = controlled(dir);
    await bindWith(a, fs);
    ctl.mute = true; // only the write path may notice the tool's edit
    await writeFile(join(dir, 'main.tex'), 'BASE LOCAL');
    (await b.model.openText(id)).insert(0, 'REMOTE ');
    const want = 'REMOTE BASE LOCAL';
    await waitFor(async () => (await read(dir, 'main.tex')) === want).catch(async (e) => {
      throw new Error(`disk=${await disk(dir, 'main.tex')} ${e}`);
    });
    expect((await a.model.openText(id)).toString()).toBe(want);
    await waitFor(async () => (await b.model.openText(id)).toString() === want);
  });

  it('merges concurrent edits made after the project text was imported from disk', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    await writeFile(join(dir, 'main.tex'), 'one\ntwo\nthree');
    const { fs, ctl } = controlled(dir);
    await bindWith(a, fs);
    const id = a.model.find('main.tex')?.id as string;
    await b.mesh.openDoc(fileDocId(id));
    await waitFor(async () => (await b.model.openText(id)).toString() === 'one\ntwo\nthree');
    ctl.mute = true;
    await writeFile(join(dir, 'main.tex'), 'one\ntwo\nthree LOCAL');
    (await b.model.openText(id)).insert(0, 'REMOTE\n');
    const want = 'REMOTE\none\ntwo\nthree LOCAL';
    await waitFor(async () => (await read(dir, 'main.tex')) === want).catch(async (e) => {
      throw new Error(`disk=${await disk(dir, 'main.tex')} ${e}`);
    });
  });
});

describe('disk writes', () => {
  it('retries a failed write instead of treating it as done', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    const dir = await tmp();
    const { fs, ctl } = controlled(dir);
    const notices: string[] = [];
    await bindWith(a, fs, {}, notices);
    const id = await a.model.createTextNow('main.tex', 'v1');
    await waitFor(async () => (await read(dir, 'main.tex')) === 'v1');
    ctl.failWrites = 2;
    (await a.model.openText(id)).insert(2, ' v2');
    await waitFor(() => notices.some((n) => n.includes('main.tex') && n.includes('disk full')));
    await waitFor(async () => (await read(dir, 'main.tex')) === 'v1 v2');
  });

  it('does not fail the folder binding when the first write fails', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    const dir = await tmp();
    await a.model.createTextNow('main.tex', 'first');
    const { fs, ctl } = controlled(dir);
    ctl.failWrites = 1;
    await bindWith(a, fs);
    await waitFor(async () => (await read(dir, 'main.tex')) === 'first');
  });

  it('keeps the baseline of the last successful write when a later write fails', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    const id = await a.model.createTextNow('main.tex', 'A\nB\nC');
    const { fs, ctl } = controlled(dir);
    await bindWith(a, fs);
    await waitFor(async () => (await read(dir, 'main.tex')) === 'A\nB\nC');
    await b.mesh.openDoc(fileDocId(id));
    await waitFor(async () => (await b.model.openText(id)).toString() === 'A\nB\nC');
    // the next write fails; meanwhile a tool edits the last written version of the file
    ctl.failWrites = 1;
    ctl.mute = true;
    (await b.model.openText(id)).insert(0, 'REMOTE\n');
    await waitFor(() => ctl.failWrites === 0);
    await writeFile(join(dir, 'main.tex'), 'A\nB\nC LOCAL');
    const want = 'REMOTE\nA\nB\nC LOCAL';
    await waitFor(async () => (await read(dir, 'main.tex')) === want).catch(async (e) => {
      throw new Error(`disk=${await disk(dir, 'main.tex')} ${e}`);
    });
  });

  for (const how of ['rename', 'delete'] as const) {
    it(`does not resurrect a file that was ${how}d while it was being written`, async () => {
      net = await Net.create();
      const a = await net.add('alice', 'owner');
      const dir = await tmp();
      const { fs, ctl } = controlled(dir);
      await bindWith(a, fs);
      ctl.hold = true;
      const id = await a.model.createTextNow('old.tex', 'content');
      await waitFor(() => ctl.parked.length > 0);
      if (how === 'rename') a.model.rename(id, 'new.tex');
      else a.model.delete(id);
      await sleep(80);
      ctl.hold = false;
      for (const r of ctl.parked.splice(0)) r();
      if (how === 'rename') await waitFor(async () => (await read(dir, 'new.tex')) === 'content');
      await sleep(300);
      expect(await read(dir, 'old.tex')).toBeNull();
      if (how === 'delete') expect(await read(dir, 'new.tex')).toBeNull();
    });
  }
});

describe('initial binding and content readiness', () => {
  it('never empties a disk file for text the project has not received', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    const dir = await tmp();
    await writeFile(join(dir, 'main.tex'), 'precious');
    // the file list names the file, its text never arrived
    a.model.putEntry('ghost1', { path: 'main.tex', kind: 'text' });
    await bindWith(a, controlled(dir).fs);
    await sleep(300);
    expect(await read(dir, 'main.tex')).toBe('precious');
    expect((await a.model.openText('ghost1')).toString()).toBe(''); // and the unknown text was not "merged" with the disk's
    // once the text is known, an equal file simply gets its baseline
    (await a.model.openText('ghost1')).insert(0, 'precious');
    a.model.markComplete(fileDocId('ghost1'));
    await sleep(300);
    expect(await read(dir, 'main.tex')).toBe('precious');
  });

  it('writes the file once its content is complete', async () => {
    net = await Net.create();
    const a = await net.add('alice', 'owner');
    const dir = await tmp();
    a.model.putEntry('late1', { path: 'late.tex', kind: 'text' });
    await bindWith(a, controlled(dir).fs);
    await sleep(200);
    expect(await read(dir, 'late.tex')).toBeNull(); // not an empty placeholder
    (await a.model.openText('late1')).insert(0, 'arrived');
    a.model.markComplete(fileDocId('late1'));
    await waitFor(async () => (await read(dir, 'late.tex')) === 'arrived');
  });

  it('viewer binding changes nothing in the project and says what it restored', async () => {
    net = await Net.create();
    const [owner, viewer] = [await net.add('owen', 'owner'), await net.add('vic', 'viewer')];
    await net.link(owner, viewer);
    const id = await owner.model.createTextNow('main.tex', 'project text');
    await viewer.mesh.reconcile(fileDocId(id));
    await waitFor(() => complete(viewer, id));
    const dir = await tmp();
    await writeFile(join(dir, 'main.tex'), 'viewer copy');
    await writeFile(join(dir, 'extra.tex'), 'only here');
    const before = revisions(viewer);
    const notices: string[] = [];
    await bindWith(viewer, controlled(dir).fs, {}, notices);
    await waitFor(async () => (await read(dir, 'main.tex')) === 'project text');
    await sleep(200);
    expect(revisions(viewer)).toEqual(before);
    expect(viewer.model.list().map((f) => f.path)).toEqual(['main.tex']);
    expect((await viewer.model.openText(id)).toString()).toBe('project text');
    expect(owner.model.list().map((f) => f.path)).toEqual(['main.tex']);
    expect(notices.some((n) => n.includes('main.tex') && n.includes('read-only'))).toBe(true);
    expect(notices.some((n) => n.includes('extra.tex'))).toBe(true);
    expect(await read(dir, 'extra.tex')).toBe('only here');
  });

  it('keeps both versions when the folder and the project changed the same lines while closed', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    const base = 'Intro.\n\nMethod para.\n\nEnd.';
    const id = await a.model.createTextNow('main.tex', base);
    const mkFork = (model: Node['model']) => new OfflineFork({ model, isLinked: () => false, canEdit: () => true, confirm: async () => 'timeout' });
    let fork = mkFork(a.model);
    await fork.start();
    const record: Opts['onConflict'] = (c) => fork.recordTextConflict(c);
    const first = await bindWith(a, nodeFs(dir), { onConflict: record });
    await waitFor(async () => (await read(dir, 'main.tex')) === base);
    await sleep(400); // baseline persisted
    first.stop(); // "app closed"
    await writeFile(join(dir, 'main.tex'), 'Intro.\n\nMethod para, rewritten by the AI.\n\nEnd.');
    await b.mesh.openDoc(fileDocId(id));
    await waitFor(async () => (await b.model.openText(id)).toString() === base);
    const bt = await b.model.openText(id);
    bt.insert(bt.toString().indexOf('Method para.') + 'Method para'.length, ', edited by Bob');
    const at = await a.model.openText(id);
    await waitFor(() => at.toString().includes('edited by Bob'));

    await bindWith(a, nodeFs(dir), { onConflict: record }); // "app reopened"
    await waitFor(() => fork.conflicts.length === 1);
    const theirs = 'Intro.\n\nMethod para, edited by Bob.\n\nEnd.';
    expect(at.toString()).toBe(theirs); // the project keeps the co-author's version
    await waitFor(async () => (await read(dir, 'main.tex')) === theirs);
    const regions = JSON.stringify((fork.conflicts[0] as { regions: unknown }).regions);
    expect(regions).toContain('rewritten by the AI');
    expect(regions).toContain('edited by Bob');

    // restart: the conflict is still there with both versions
    await a.model.flush();
    fork = mkFork(a.model);
    await fork.start();
    expect(fork.conflicts.length).toBe(1);
    const again = JSON.stringify((fork.conflicts[0] as { regions: unknown }).regions);
    expect(again).toContain('rewritten by the AI');
    expect(again).toContain('edited by Bob');
  });
});
