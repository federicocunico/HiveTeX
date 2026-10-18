import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeFs } from '../src/mirror-node.js';

const fault = vi.hoisted(() => ({ rename: false, read: false, race: false, link: '' as '' | 'EPERM' | 'EIO-tmp', copyTmp: false }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (fault.rename) throw Object.assign(new Error('target locked'), { code: 'EBUSY' });
      await fs.rename(...args);
      if (fault.race) await fs.writeFile(args[0], 'external atomic save');
    },
    // 'EPERM': no hard links at all (FAT, exFAT); 'EIO-tmp': publication fails after the retain, the rollback works.
    link: async (...args: Parameters<typeof fs.link>) => {
      if (fault.link === 'EPERM') throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      if (fault.link === 'EIO-tmp' && String(args[0]).endsWith('.p2p-tmp')) throw Object.assign(new Error('i/o error'), { code: 'EIO' });
      return fs.link(...args);
    },
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      if (fault.copyTmp && String(args[0]).endsWith('.p2p-tmp')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fs.copyFile(...args);
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (fault.read) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return fs.readFile(...args);
    },
  };
});
const dirs: string[] = [];
afterEach(async () => {
  fault.rename = fault.read = fault.race = fault.copyTmp = false; fault.link = '';
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const temp = async () => { const dir = await mkdtemp(join(tmpdir(), 'hivetex-mirror-safety-')); dirs.push(dir); return dir; };

describe('native Node folder failures', () => {
  it('retains late writes through an external handle after replacement and after removal', async () => {
    const dir = await temp(); const fs = nodeFs(dir);
    await writeFile(join(dir, 'main.tex'), 'before');
    const external = await open(join(dir, 'main.tex'), 'r+');
    try {
      await fs.write('main.tex', new TextEncoder().encode('project version'));
      await external.writeFile('external contribution after replacement'); await external.sync();
      expect(await readFile(join(dir, 'main.tex'), 'utf8')).toBe('project version');
      const copies = await fs.retained!();
      expect(new TextDecoder().decode(await fs.read(copies[0]!.path) ?? undefined)).toContain('external contribution');
      await fs.remove('main.tex');
      expect(await fs.read('main.tex')).toBeNull();
      expect((await fs.retained!()).length).toBe(2);
      expect(await fs.list()).toEqual([]);
    } finally { await external.close(); }
  });

  it('does not replace an external atomic-save that races publication', async () => {
    const dir = await temp(); const fs = nodeFs(dir);
    await writeFile(join(dir, 'main.tex'), 'original');
    fault.race = true;
    await expect(fs.write('main.tex', new TextEncoder().encode('project version'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(dir, 'main.tex'), 'utf8')).toBe('external atomic save');
    expect(new TextDecoder().decode(await fs.read((await fs.retained!())[0]!.path) ?? undefined)).toBe('original');
  });

  it('never truncates the original when the atomic replacement cannot commit', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'main.tex'), 'original');
    const fs = nodeFs(dir);
    fault.rename = true;
    await expect(fs.write('main.tex', new TextEncoder().encode('replacement'))).rejects.toThrow('target locked');
    expect(await readFile(join(dir, 'main.tex'), 'utf8')).toBe('original');
    expect((await fs.list()).map((f) => f.path)).toEqual(['main.tex']);
    fault.rename = false;
    await fs.write('main.tex', new TextEncoder().encode('replacement'));
    expect(await readFile(join(dir, 'main.tex'), 'utf8')).toBe('replacement');
  });

  it('reports read and scan errors without inventing absence (audit F01)', async () => {
    const dir = await temp();
    const fs = nodeFs(dir);
    expect(await fs.read('missing.tex')).toBeNull();
    fault.read = true;
    await expect(fs.read('main.tex')).rejects.toMatchObject({ code: 'EACCES' });
    await writeFile(join(dir, 'file'), 'keep');
    await expect(nodeFs(join(dir, 'file')).list()).rejects.toBeDefined();
  });
  it('publishes on a filesystem without hard links and the retained copy is transient (exFAT, FAT)', async () => {
    const dir = await temp(); const fs = nodeFs(dir); const enc = new TextEncoder();
    fault.link = 'EPERM';
    expect(await fs.write('main.tex', enc.encode('first'))).toBeNull();
    const copy = await fs.write('main.tex', enc.encode('second'));
    expect(await readFile(join(dir, 'main.tex'), 'utf8')).toBe('second');
    expect(new TextDecoder().decode((await fs.read(copy as string)) ?? undefined)).toBe('first');
    await fs.dropRetained!(copy as string);
    expect((await readdir(dir)).sort()).toEqual(['main.tex']);
    await expect(fs.dropRetained!('main.tex')).rejects.toThrow('not a retained');
    // an external atomic-save that races the copy is never replaced either
    fault.race = true;
    await expect(fs.write('main.tex', enc.encode('project'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(dir, 'main.tex'), 'utf8')).toBe('external atomic save');
  });

  it('a publication failing after the retain puts the previous file back, also via the copy fallback', async () => {
    const dir = await temp(); const fs = nodeFs(dir); const enc = new TextEncoder();
    await writeFile(join(dir, 'main.tex'), 'previous');
    fault.link = 'EIO-tmp';
    await expect(fs.write('main.tex', enc.encode('new'))).rejects.toMatchObject({ code: 'EIO' });
    expect(await readFile(join(dir, 'main.tex'), 'utf8')).toBe('previous');
    expect(await fs.retained!()).toEqual([]);
    fault.link = 'EPERM'; fault.copyTmp = true;
    await expect(fs.write('main.tex', enc.encode('new'))).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await readFile(join(dir, 'main.tex'), 'utf8')).toBe('previous');
    expect(await fs.retained!()).toEqual([]);
    expect((await fs.list()).map((f) => f.path)).toEqual(['main.tex']);
  });

  it('reports a parent that became a file and skips target/ like the native walk', async () => {
    const dir = await temp(); const fs = nodeFs(dir);
    await writeFile(join(dir, 'sections'), 'a file');
    await expect(fs.write('sections/a.tex', new TextEncoder().encode('x'))).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(await readFile(join(dir, 'sections'), 'utf8')).toBe('a file');
    await mkdir(join(dir, 'target', 'debug'), { recursive: true });
    await writeFile(join(dir, 'target', 'debug', 'out.tex'), 'build output');
    expect((await fs.list()).map((f) => f.path)).toEqual(['sections']);
  });

  it('never reports a directory to the watcher', async () => {
    const dir = await temp(); const fs = nodeFs(dir); const seen: string[] = [];
    const stop = fs.watch((ev) => { if (!ev.error) seen.push(ev.path); });
    try {
      await new Promise((r) => setTimeout(r, 100));
      await mkdir(join(dir, 'figs', 'sub'), { recursive: true });
      await new Promise((r) => setTimeout(r, 200));
      await writeFile(join(dir, 'figs', 'sub', 'a.tex'), 'x');
      const end = Date.now() + 4000;
      while (Date.now() < end && !seen.includes('figs/sub/a.tex')) await new Promise((r) => setTimeout(r, 20));
      expect(seen).toContain('figs/sub/a.tex');
      expect(seen.filter((p) => p === 'figs' || p === 'figs/sub')).toEqual([]);
    } finally { stop(); }
  });
});
