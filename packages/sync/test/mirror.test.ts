import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobManager } from '../src/blobs.js';
import { MirrorSync } from '../src/mirror.js';
import { nodeFs } from '../src/mirror-node.js';
import { Net, type Node } from '../src/testkit.js';

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

async function bind(node: Node, dir: string, notices: string[] = []) {
  const blobs = new BlobManager(node.mesh, node.store);
  const m = new MirrorSync({ model: node.model, mesh: node.mesh, blobs, fs: nodeFs(dir), getRole: () => node.role, onNotice: (n) => notices.push(n), debounceMs: 30 });
  mirrors.push(m);
  await m.start();
  return { m, blobs };
}

async function tmp() {
  const d = await mkdtemp(join(tmpdir(), 'p2p-mirror-'));
  dirs.push(d);
  return d;
}

describe('local folder mirror (9.3)', () => {
  it('writes the project to the folder and picks up remote edits within a second', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    const id = await b.model.createTextNow('main.tex', 'hello');
    await bind(a, dir);
    await waitFor(async () => (await read(dir, 'main.tex')) === 'hello');

    const t0 = Date.now();
    (await b.model.openText(id)).insert(5, ' world');
    await waitFor(async () => (await read(dir, 'main.tex')) === 'hello world', 1500);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('turns an external edit (e.g. Claude Code) into a collaborative edit that reaches peers', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    await mkdir(join(dir, 'sections'), { recursive: true });
    await a.model.createTextNow('sections/method.tex', 'original method');
    await bind(a, dir);
    await waitFor(async () => (await read(dir, 'sections/method.tex')) === 'original method');

    await writeFile(join(dir, 'sections/method.tex'), 'original method, improved by an AI tool');
    const entry = () => b.model.find('sections/method.tex');
    await waitFor(() => !!entry());
    await b.mesh.openDoc(`f:${entry()?.id}`);
    await waitFor(async () => (await b.model.openText(entry()?.id as string)).toString() === 'original method, improved by an AI tool');

    // a brand-new file created on disk appears remotely too
    await writeFile(join(dir, 'appendix.tex'), '\\section{Extra}');
    await waitFor(() => !!b.model.find('appendix.tex'));
  });

  it('applies a minimal diff, preserving a concurrent remote edit', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    const id = await a.model.createTextNow('main.tex', 'AAA\nBBB\nCCC');
    await bind(a, dir);
    await waitFor(async () => (await read(dir, 'main.tex')) === 'AAA\nBBB\nCCC');
    await b.mesh.openDoc(`f:${id}`);
    await waitFor(async () => (await b.model.openText(id)).toString() === 'AAA\nBBB\nCCC');
    const bt = await b.model.openText(id);
    // external tool changes the middle line; bob appends at the end meanwhile
    await writeFile(join(dir, 'main.tex'), 'AAA\nBBB-edited\nCCC');
    bt.insert(bt.length, '\nDDD');
    await waitFor(async () => (await read(dir, 'main.tex')) === 'AAA\nBBB-edited\nCCC\nDDD').catch(async (e) => {
      throw new Error(`DISK=${JSON.stringify(await read(dir, 'main.tex'))} DOC=${JSON.stringify(bt.toString())} ${e}`);
    });
    await waitFor(async () => bt.toString() === 'AAA\nBBB-edited\nCCC\nDDD');
  });

  it('ignores build artifacts, tool folders and patterns from .hivetexignore', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    await writeFile(join(dir, '.hivetexignore'), 'drafts/\nscratch.tex\n');
    await bind(a, dir);
    for (const [p, c] of [
      ['main.aux', 'x'],
      ['main.log', 'x'],
      ['main.synctex.gz', 'x'],
      ['.claude/settings.json', '{}'],
      ['drafts/idea.tex', 'secret idea'],
      ['scratch.tex', 'tmp'],
      ['keep.tex', 'keep me'],
    ] as const) {
      await mkdir(join(dir, p.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
      await writeFile(join(dir, p), c);
    }
    await waitFor(() => !!b.model.find('keep.tex'));
    await sleep(300);
    expect(b.model.list().map((f) => f.path).sort()).toEqual(['.hivetexignore', 'keep.tex']);
  });

  it('reverts local changes made by a read-only member and tells them', async () => {
    net = await Net.create();
    const [owner, viewer] = [await net.add('owen', 'owner'), await net.add('vic', 'viewer')];
    await net.link(owner, viewer);
    const dir = await tmp();
    await owner.model.createTextNow('main.tex', 'protected content');
    const notices: string[] = [];
    await bind(viewer, dir, notices);
    await waitFor(async () => (await read(dir, 'main.tex')) === 'protected content');

    await writeFile(join(dir, 'main.tex'), 'tampered by viewer');
    await writeFile(join(dir, 'extra.tex'), 'new file by viewer');
    await waitFor(async () => (await read(dir, 'main.tex')) === 'protected content');
    await waitFor(async () => (await read(dir, 'extra.tex')) === null);
    expect(notices.some((n) => n.includes('read-only'))).toBe(true);
    // nothing leaked to the project
    await sleep(200);
    expect(owner.model.list().map((f) => f.path)).toEqual(['main.tex']);
    expect((await owner.model.openText(owner.model.find('main.tex')?.id as string)).toString()).toBe('protected content');
  });

  it('propagates deletes and renames in both directions', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    const id = await b.model.createTextNow('old.tex', 'content');
    await bind(a, dir);
    await waitFor(async () => (await read(dir, 'old.tex')) === 'content');
    b.model.rename(id, 'new.tex');
    await waitFor(async () => (await read(dir, 'new.tex')) === 'content' && (await read(dir, 'old.tex')) === null).catch(async (e) => {
      throw new Error(`rename not mirrored: new=${await read(dir, 'new.tex')} old=${await read(dir, 'old.tex')} files=${a.model.list().map((f) => f.path)} ${e}`);
    });
    await rm(join(dir, 'new.tex'));
    await waitFor(() => !b.model.find('new.tex')).catch((e) => {
      throw new Error(`delete not propagated: a=${a.model.list().map((f) => f.path)} b=${b.model.list().map((f) => f.path)} ${e}`);
    });
  });

  it('syncs binary files through the blob store', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    const bb = new BlobManager(b.mesh, b.store);
    await bind(a, dir);
    await mkdir(join(dir, 'img'), { recursive: true });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
    await writeFile(join(dir, 'img/fig.png'), png);
    await waitFor(() => b.model.find('img/fig.png')?.kind === 'binary');
    const got = await bb.fetch(b.model.find('img/fig.png')?.hash as string, 5000);
    expect(Buffer.from(got).equals(png)).toBe(true);
  });
});

describe('project folders (local-folder-projects)', () => {
  it('writes the marker with the project identity, never as a project file, keeping backup paths', async () => {
    net = await Net.create();
    const [a] = [await net.add('alice', 'owner')];
    const dir = await tmp();
    await writeFile(join(dir, '.hivetex.json'), JSON.stringify({ version: 1, paths: ['main.tex'] }));
    await a.model.createTextNow('main.tex', 'x');
    const blobs = new BlobManager(a.mesh, a.store);
    const m = new MirrorSync({ model: a.model, mesh: a.mesh, blobs, fs: nodeFs(dir), getRole: () => 'owner', debounceMs: 30, marker: { id: 'p123', slug: 'my-paper' } });
    mirrors.push(m);
    await m.start();
    const marker = JSON.parse((await read(dir, '.hivetex.json')) as string);
    expect(marker).toMatchObject({ version: 2, project: { id: 'p123', slug: 'my-paper' }, paths: ['main.tex'] });
    await new Promise((r) => setTimeout(r, 150));
    expect(a.model.find('.hivetex.json')).toBeUndefined();
  });

  it('merges edits made in the folder while the app was closed with co-author edits made meanwhile', async () => {
    net = await Net.create();
    const [a, b] = [await net.add('alice', 'owner'), await net.add('bob', 'editor')];
    await net.link(a, b);
    const dir = await tmp();
    const id = await a.model.createTextNow('main.tex', 'Intro para.\n\nMethod para.\n\nEnd.');
    const first = await bind(a, dir);
    await waitFor(async () => (await read(dir, 'main.tex')) === 'Intro para.\n\nMethod para.\n\nEnd.');
    await new Promise((r) => setTimeout(r, 400)); // base persisted
    first.m.stop(); // "app closed"

    // while closed: an AI tool rewrites the intro on disk, a co-author edits the method paragraph
    await writeFile(join(dir, 'main.tex'), 'Intro para, rewritten by the AI.\n\nMethod para.\n\nEnd.');
    await b.mesh.openDoc(`f:${id}`);
    const bt = await b.model.openText(id);
    await waitFor(() => bt.toString().includes('Method para.'));
    bt.insert(bt.toString().indexOf('Method para.') + 'Method para'.length, ' (edited by Bob)');
    const at = await a.model.openText(id);
    await waitFor(() => at.toString().includes('edited by Bob'));

    await bind(a, dir); // "app reopened"
    const want = 'Intro para, rewritten by the AI.\n\nMethod para (edited by Bob).\n\nEnd.';
    await waitFor(() => at.toString() === want).catch(() => {
      throw new Error(`project=${JSON.stringify(at.toString())}`);
    });
    await waitFor(async () => (await read(dir, 'main.tex')) === want);
    await waitFor(() => bt.toString() === want);
  });

  it('does not add files larger than the transfer limit and says so', async () => {
    net = await Net.create();
    const [a] = [await net.add('alice', 'owner')];
    const dir = await tmp();
    const notices: string[] = [];
    await bind(a, dir, notices);
    await writeFile(join(dir, 'huge.bin'), Buffer.alloc(51 * 1024 * 1024));
    await waitFor(() => notices.some((n) => n.includes('huge.bin')), 8000);
    expect(a.model.find('huge.bin')).toBeUndefined();
  }, 20_000);
});
