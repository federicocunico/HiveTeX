import { describe, expect, it } from 'vitest';
import { webFs } from '../src/lib/fs-access.js';
import { readBrowserFolder } from '../src/lib/folders.js';

/** In-memory stand-in for the File System Access API (just what webFs uses). */
class FakeFile {
  kind = 'file' as const;
  data = new Uint8Array();
  lastModified = Date.now();
  writes = 0;
  constructor(public name: string) {}
  async getFile() {
    const d = this.data;
    return { size: d.length, lastModified: this.lastModified, arrayBuffer: async () => d.slice().buffer };
  }
  async createWritable() {
    let pending = new Uint8Array();
    return {
      write: async (b: Uint8Array) => {
        pending = b.slice();
      },
      close: async () => {
        this.data = pending; // committed only on close (swap-file semantics)
        this.lastModified = Date.now() + ++this.writes;
      },
    };
  }
}
class FakeDir {
  kind = 'directory' as const;
  children = new Map<string, FakeDir | FakeFile>();
  listed: string[] = [];
  constructor(public name: string) {}
  async *entries() {
    this.listed.push(this.name);
    for (const e of this.children) yield e;
  }
  async getDirectoryHandle(name: string, o?: { create?: boolean }) {
    let d = this.children.get(name);
    if (!d && o?.create) this.children.set(name, (d = new FakeDir(name)));
    if (!(d instanceof FakeDir)) throw new DOMException('not found', 'NotFoundError');
    return d;
  }
  async getFileHandle(name: string, o?: { create?: boolean }) {
    let f = this.children.get(name);
    if (!f && o?.create) this.children.set(name, (f = new FakeFile(name)));
    if (!(f instanceof FakeFile)) throw new DOMException('not found', 'NotFoundError');
    return f;
  }
  async removeEntry(name: string) {
    if (!this.children.delete(name)) throw new DOMException('not found', 'NotFoundError');
  }
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);

describe('web folder adapter (File System Access API)', () => {
  it('refuses every browser write/delete without touching external bytes, even through the adapter directly', async () => {
    const root = new FakeDir('paper');
    const original = await root.getFileHandle('main.tex', { create: true }); original.data = enc('external contribution');
    const fs = webFs(root as unknown as FileSystemDirectoryHandle);
    await expect(fs.write('main.tex', enc('replacement'))).rejects.toThrow('import-only');
    await expect(fs.write('new.tex', enc('new'))).rejects.toThrow('import-only');
    await expect(fs.remove('main.tex')).rejects.toThrow('import-only');
    expect(dec(await fs.read('main.tex'))).toBe('external contribution');
    expect(original.writes).toBe(0); expect([...root.children.keys()]).toEqual(['main.tex']);
    const bundle = await readBrowserFolder(root as unknown as FileSystemDirectoryHandle);
    expect(bundle.files).toMatchObject([{ path: 'main.tex', kind: 'text', text: 'external contribution' }]);
    expect(original.writes).toBe(0); fs.dispose();
  });

  it('distinguishes a missing file from revoked permission and I/O errors (audit F01)', async () => {
    const root = new FakeDir('paper');
    const fs = webFs(root as unknown as FileSystemDirectoryHandle);
    expect(await fs.read('missing.tex')).toBeNull();
    const file = await root.getFileHandle('main.tex', { create: true }); file.data = enc('preserve this text');
    file.getFile = async () => { throw new DOMException('permission revoked', 'NotAllowedError'); };
    await expect(fs.read('main.tex')).rejects.toMatchObject({ name: 'NotAllowedError' });
    await expect(readBrowserFolder(root as unknown as FileSystemDirectoryHandle)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(dec(file.data)).toBe('preserve this text');
    fs.dispose();
  });

  it('imports nested files without walking tool folders or creating a mirror', async () => {
    const root = new FakeDir('paper');
    const fs = webFs(root as unknown as FileSystemDirectoryHandle);
    const sections = await root.getDirectoryHandle('sections', { create: true });
    (await sections.getFileHandle('intro.tex', { create: true })).data = enc('hello');
    (await root.getFileHandle('main.tex', { create: true })).data = enc('main');
    const git = await root.getDirectoryHandle('.git', { create: true });
    await git.getFileHandle('HEAD', { create: true });
    expect(dec(await fs.read('sections/intro.tex'))).toBe('hello');
    expect(await fs.read('missing.tex')).toBeNull();
    const listed = (await fs.list()).map((f) => f.path).sort();
    expect(listed).toEqual(['main.tex', 'sections/intro.tex']);
    expect(root.listed.concat(git.listed)).not.toContain('.git'); // never descended into
    const bundle = await readBrowserFolder(root as unknown as FileSystemDirectoryHandle);
    expect(bundle.files.map((f) => f.path).sort()).toEqual(['main.tex', 'sections/intro.tex']);
    expect(dec(await fs.read('main.tex'))).toBe('main');
    await expect(fs.read('../escape.tex')).rejects.toThrow(/invalid path/);
    fs.dispose();
  });

  it('reports changes made by other programs within one poll', async () => {
    const root = new FakeDir('paper');
    const fs = webFs(root as unknown as FileSystemDirectoryHandle, { pollMs: 20 });
    (await root.getFileHandle('main.tex', { create: true })).data = enc('v1');
    const seen: string[] = [];
    const stop = fs.watch((e) => seen.push(e.path));
    await new Promise((r) => setTimeout(r, 40)); // first snapshot
    // "Claude Code" edits the file and creates another one, outside the app
    const f = await root.getFileHandle('main.tex');
    f.data = enc('v2 by the AI');
    f.lastModified += 1000;
    (await root.getFileHandle('notes.tex', { create: true })).data = enc('new');
    await new Promise((r) => setTimeout(r, 60));
    await expect.poll(async () => seen, { timeout: 15_000 }).toContain('main.tex');
    expect(seen).toContain('notes.tex');
    stop();
    (fs as unknown as { dispose(): void }).dispose();
  });
});
