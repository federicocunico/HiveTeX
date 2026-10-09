import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { FsAdapter } from './mirror.js';

const posix = (p: string) => p.split(sep).join('/');

/** FsAdapter over a real directory (used by tests and by headless tooling). */
export function nodeFs(root: string): FsAdapter {
  const abs = (p: string) => {
    const full = join(root, ...p.split('/'));
    if (relative(root, full).startsWith('..')) throw new Error('path escapes the bound folder');
    return full;
  };
  async function walk(dir: string, out: Array<{ path: string; size: number }>) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        await walk(p, out);
      } else if (e.isFile()) out.push({ path: posix(relative(root, p)), size: (await stat(p)).size });
    }
  }
  return {
    async list() {
      const out: Array<{ path: string; size: number }> = [];
      await walk(root, out);
      return out;
    },
    async read(path) {
      try {
        return new Uint8Array(await readFile(abs(path)));
      } catch {
        return null;
      }
    },
    async write(path, bytes) {
      const full = abs(path);
      await mkdir(dirname(full), { recursive: true });
      const tmp = `${full}.p2p-tmp`;
      await writeFile(tmp, bytes);
      // Windows can briefly lock the target (watchers, antivirus): retry, then fall back to an in-place write.
      for (let i = 0; ; i++) {
        try {
          await rename(tmp, full);
          return;
        } catch (e) {
          if (i >= 6) {
            await writeFile(full, bytes);
            await rm(tmp, { force: true });
            return;
          }
          await new Promise((r) => setTimeout(r, 15 * (i + 1)));
          void e;
        }
      }
    },
    async remove(path) {
      await rm(abs(path), { force: true });
    },
    watch(cb) {
      let w: FSWatcher | null = null;
      try {
        w = watch(root, { recursive: true }, (_ev, name) => {
          if (name) cb({ path: posix(name.toString()) });
        });
      } catch {
        /* recursive watch unsupported: caller falls back to polling */
      }
      return () => w?.close();
    },
  };
}
