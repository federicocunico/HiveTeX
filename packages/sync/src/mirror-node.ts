import { type FSWatcher, constants, watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { FsAdapter } from './mirror.js';

const posix = (p: string) => p.split(sep).join('/');
const code = (e: unknown) => (e as { code?: string })?.code;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Same skipped components as the native walk (mirror.rs `skip_component`). */
const SKIP = new Set(['.git', 'node_modules', 'target', '.hivetex-recovery']);
/** Hard links unavailable (FAT, exFAT, some network and cloud drives). */
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);

/**
 * Exclusive publication: fails with EEXIST instead of replacing a path an external atomic-save filled meanwhile. Node
 * has no exclusive rename: a hard link, else an exclusive copy flushed to disk (not atomic for concurrent readers).
 * `rollback` also falls back on errors that are not "no hard links", to give the previous file every chance to return.
 */
async function publish(from: string, to: string, rollback = false) {
  try { await link(from, to); return; }
  catch (error) { if (code(error) === 'EEXIST' || !(rollback || NO_LINK.has(code(error) ?? ''))) throw error; }
  try {
    await copyFile(from, to, constants.COPYFILE_EXCL);
    const f = await open(to, 'r+');
    try { await f.sync(); } finally { await f.close(); }
  } catch (error) {
    if (code(error) !== 'EEXIST') await rm(to, { force: true }).catch(() => {}); // our partial copy (EXCL created it)
    throw error;
  }
}

/** FsAdapter over a real directory (used by tests and by headless tooling). */
export function nodeFs(root: string): FsAdapter {
  const abs = (p: string) => {
    const full = join(root, ...p.split('/'));
    if (relative(root, full).startsWith('..')) throw new Error('path escapes the bound folder');
    return full;
  };
  async function walk(dir: string, out: Array<{ path: string; size: number }>, retained = false) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name) && !(retained && e.name === '.hivetex-recovery')) continue;
        await walk(p, out, retained);
      } else if (e.isFile()) {
        const path = posix(relative(root, p));
        if (!retained || path.split('/').includes('.hivetex-recovery')) out.push({ path, size: (await stat(p)).size });
      }
    }
  }
  /** A parent that became a file is a collision (as in mirror.rs): reported, never removed to make room. */
  async function parentsAreDirs(path: string) {
    let dir = root;
    for (const part of path.split('/').slice(0, -1)) {
      dir = join(dir, part);
      let s: Awaited<ReturnType<typeof stat>>;
      try { s = await stat(dir); } catch (error) { if (code(error) === 'ENOENT') return; throw error; }
      if (!s.isDirectory()) throw Object.assign(new Error(`ENOTDIR: a parent folder of "${path}" is a file`), { code: 'ENOTDIR' });
    }
  }
  async function retain(full: string) {
    try { if (!(await lstat(full)).isFile()) throw new Error('Refusing to replace a directory or symlink'); }
    catch (error) { if (code(error) === 'ENOENT') return null; throw error; }
    const backup = join(dirname(full), '.hivetex-recovery', `${basename(full)}.${randomUUID()}.retained`);
    // Twice: an emptied recovery directory may be removed by dropRetained between creating it and the rename.
    for (let attempt = 0; attempt < 2; attempt++) {
      await mkdir(dirname(backup), { recursive: true });
      if ((await lstat(dirname(backup))).isSymbolicLink()) throw new Error('Recovery directory must not be a symlink');
      try { await rename(full, backup); return backup; }
      catch (error) {
        if (code(error) !== 'ENOENT') throw error;
        if (!(await lstat(full).then(() => true, () => false))) return null;
      }
    }
    throw new Error('the recovery directory kept disappearing');
  }
  return {
    async list() {
      const out: Array<{ path: string; size: number }> = [];
      await walk(root, out);
      return out;
    },
    async retained() { const out: Array<{ path: string; size: number }> = []; await walk(root, out, true); return out; },
    async read(path) {
      try {
        return new Uint8Array(await readFile(abs(path)));
      } catch (e) {
        if (code(e) === 'ENOENT') {
          if (!(await stat(root)).isDirectory()) throw new Error('Bound folder is unavailable');
          return null;
        }
        throw e;
      }
    },
    async write(path, bytes) {
      const full = abs(path);
      await parentsAreDirs(path);
      await mkdir(dirname(full), { recursive: true });
      const tmp = `${full}.${randomUUID()}.p2p-tmp`;
      try {
        const file = await open(tmp, 'wx');
        try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
        // Moving the inode retains even a write by an external handle after our last read.
        const backup = await retain(full);
        try { await publish(tmp, full); }
        catch (error) {
          if (!backup) throw error;
          // The previous file goes back exclusively too; a failed rollback is reported, never silent.
          try { await publish(backup, full, true); }
          catch (failed) {
            throw Object.assign(new Error(`${message(error)}; the previous file was kept in ${posix(relative(root, backup))} (${message(failed)})`), { code: code(error), cause: error });
          }
          await rm(backup, { force: true }).catch(() => {});
          throw error;
        }
        return backup ? posix(relative(root, backup)) : null;
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    },
    async remove(path) {
      const backup = await retain(abs(path));
      return backup ? posix(relative(root, backup)) : null;
    },
    async dropRetained(path) {
      const parts = path.split('/');
      if (parts.length < 2 || parts[parts.length - 2] !== '.hivetex-recovery' || !path.endsWith('.retained') || parts.includes('..')) throw new Error('not a retained recovery copy');
      const full = abs(path);
      try { if (!(await lstat(full)).isFile()) throw new Error('not a retained recovery copy'); }
      catch (error) { if (code(error) === 'ENOENT') return; throw error; }
      await rm(full);
      await rmdir(dirname(full)).catch(() => {}); // only once empty
    },
    watch(cb) {
      let w: FSWatcher | null = null;
      try {
        w = watch(root, { recursive: true }, (_ev, name) => {
          if (!name) return;
          const path = posix(name.toString());
          // Directories are never reported: reading one is not a file read failure (no retry loop).
          void lstat(join(root, name.toString())).then((s) => { if (!s.isDirectory()) cb({ path }); }, () => cb({ path }));
        });
        w.on('error', (error) => cb({ path: '', error }));
      } catch {
        /* recursive watch unsupported: caller falls back to polling */
      }
      return () => w?.close();
    },
  };
}
