import { DEFAULT_IGNORES, type FsAdapter, createIgnoreMatcher } from '@hivetex/sync';

/**
 * Read-only folder import on Chromium. This adapter refuses all writes/removals, even if an old caller accidentally
 * attempts to use it as a mirror: browser APIs cannot protect commits against arbitrary external editors atomically.
 */

/** Minimal shapes of the File System Access API used here (DOM typings vary between TypeScript versions). */
interface FileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<{ size: number; lastModified: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}
interface DirHandleLike {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, FileHandleLike | DirHandleLike]>;
  getDirectoryHandle(name: string): Promise<DirHandleLike>;
  getFileHandle(name: string): Promise<FileHandleLike>;
  queryPermission?(d: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' }): Promise<PermissionState>;
}

export const folderAccessSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/** Opens the browser's folder picker (must run inside a user gesture). Returns null when cancelled. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const w = window as unknown as { showDirectoryPicker(o: { mode: 'read' }): Promise<FileSystemDirectoryHandle> };
  try {
    return await w.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/** 'granted' | 'prompt' | 'denied' for read access. */
export async function folderPermission(h: FileSystemDirectoryHandle, request = false): Promise<PermissionState> {
  const d = h as unknown as DirHandleLike;
  if (!d.queryPermission) return 'granted';
  const now = await d.queryPermission({ mode: 'read' });
  if (now === 'granted' || !request || !d.requestPermission) return now;
  return d.requestPermission({ mode: 'read' });
}

const isIgnored = createIgnoreMatcher(DEFAULT_IGNORES);

export interface WebFsOptions {
  /** Polling interval for change detection (ms). */
  pollMs?: number;
}

export function webFs(root: FileSystemDirectoryHandle, opts: WebFsOptions = {}): FsAdapter & { dispose(): void } {
  const dir = root as unknown as DirHandleLike;
  const segments = (path: string) => {
    const parts = path.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`invalid path: ${path}`);
    return parts;
  };
  const parentOf = async (path: string) => {
    const parts = segments(path);
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    return { d, name: parts[parts.length - 1] as string };
  };

  async function walk(d: DirHandleLike, prefix: string, out: Map<string, { size: number; mtime: number }>) {
    for await (const [name, h] of d.entries()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (h.kind === 'directory') {
        if (!isIgnored(`${rel}/`)) await walk(h, rel, out);
      } else {
        const f = await h.getFile();
        out.set(rel, { size: f.size, mtime: f.lastModified });
      }
    }
  }

  const snapshot = async () => {
    const m = new Map<string, { size: number; mtime: number }>();
    await walk(dir, '', m);
    return m;
  };

  const timers: Array<() => void> = [];

  return {
    async list() {
      return [...(await snapshot())].map(([path, s]) => ({ path, size: s.size }));
    },
    async retained() {
      // Include copies from earlier sessions without traversing other ignored tool directories.
      const copies = new Map<string, { path: string; size: number }>();
      async function visit(d: DirHandleLike, prefix: string, privateDir = false) {
        for await (const [name, h] of d.entries()) {
          const path = prefix + name;
          if (h.kind === 'directory') {
            if (name === '.hivetex-recovery' || !isIgnored(`${path}/`)) await visit(h, `${path}/`, privateDir || name === '.hivetex-recovery');
          } else if (privateDir) copies.set(path, { path, size: (await h.getFile()).size });
        }
      }
      await visit(dir, ''); return [...copies.values()];
    },
    async read(path) {
      try {
        const { d, name } = await parentOf(path);
        const f = await (await d.getFileHandle(name)).getFile();
        return new Uint8Array(await f.arrayBuffer());
      } catch (e) {
        if ((e as { name?: string })?.name === 'NotFoundError') {
          // A removed/unavailable root handle must not masquerade as deletion of every contained file.
          for await (const _ of dir.entries()) break;
          return null;
        }
        throw e;
      }
    },
    async write() {
      throw new Error('Browser folders are import-only; use the desktop app for live folder sync');
    },
    async remove() {
      throw new Error('Browser folders are import-only; use the desktop app for live folder sync');
    },
    watch(cb) {
      let prev: Map<string, { size: number; mtime: number }> | null = null;
      let stopped = false;
      const tick = async () => {
        if (stopped) return;
        try {
          const cur = await snapshot();
          if (prev) {
            for (const [p, s] of cur) {
              const o = prev.get(p);
              if (!o || o.size !== s.size || o.mtime !== s.mtime) cb({ path: p });
            }
            for (const p of prev.keys()) if (!cur.has(p)) cb({ path: p });
          }
          prev = cur;
        } catch (error) {
          cb({ path: '', error });
        }
        if (!stopped) timer = setTimeout(tick, opts.pollMs ?? 1500);
      };
      let timer: ReturnType<typeof setTimeout> = setTimeout(tick, 0);
      // Where available, the browser tells us about changes right away; polling stays as the safety net.
      const Observer = (globalThis as { FileSystemObserver?: new (cb: (records: Array<{ relativePathComponents: string[] }>) => void) => { observe(h: unknown, o: { recursive: boolean }): Promise<void>; disconnect(): void } }).FileSystemObserver;
      let observer: { disconnect(): void } | null = null;
      if (Observer) {
        try {
          const o = new Observer((records) => {
            for (const r of records) if (r.relativePathComponents?.length) cb({ path: r.relativePathComponents.join('/') });
          });
          void o.observe(root, { recursive: true }).catch(() => {});
          observer = o;
        } catch {
          observer = null;
        }
      }
      const stop = () => {
        stopped = true;
        clearTimeout(timer);
        observer?.disconnect();
      };
      timers.push(stop);
      return stop;
    },
    dispose() {
      for (const t of timers.splice(0)) t();
    },
  };
}
