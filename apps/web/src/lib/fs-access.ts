import { DEFAULT_IGNORES, type FsAdapter, createIgnoreMatcher } from '@hivetex/sync';

/**
 * Folder access for the web app on Chromium browsers (File System Access API): the same FsAdapter contract the
 * desktop mirror uses, over a directory handle the user picked with showDirectoryPicker. Browsers do not watch
 * folders, so changes made by other programs (Claude Code, Codex, an editor) are detected by polling, or with
 * FileSystemObserver where the browser offers it.
 */

/** Minimal shapes of the File System Access API used here (DOM typings vary between TypeScript versions). */
interface FileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<{ size: number; lastModified: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
}
interface DirHandleLike {
  kind: 'directory';
  name: string;
  entries(): AsyncIterable<[string, FileHandleLike | DirHandleLike]>;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  queryPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'readwrite' }): Promise<PermissionState>;
}

export const folderAccessSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/** Opens the browser's folder picker (must run inside a user gesture). Returns null when cancelled. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const w = window as unknown as { showDirectoryPicker(o: { mode: 'readwrite' }): Promise<FileSystemDirectoryHandle> };
  try {
    return await w.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null;
    throw e;
  }
}

/** 'granted' | 'prompt' | 'denied' for read/write access to a remembered folder. */
export async function folderPermission(h: FileSystemDirectoryHandle, request = false): Promise<PermissionState> {
  const d = h as unknown as DirHandleLike;
  if (!d.queryPermission) return 'granted';
  const now = await d.queryPermission({ mode: 'readwrite' });
  if (now === 'granted' || !request || !d.requestPermission) return now;
  return d.requestPermission({ mode: 'readwrite' });
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
  const parentOf = async (path: string, create: boolean) => {
    const parts = segments(path);
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create });
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
    async read(path) {
      try {
        const { d, name } = await parentOf(path, false);
        const f = await (await d.getFileHandle(name)).getFile();
        return new Uint8Array(await f.arrayBuffer());
      } catch {
        return null;
      }
    },
    async write(path, bytes) {
      const { d, name } = await parentOf(path, true);
      // createWritable writes to a swap file and commits on close: readers never see a half-written file.
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
    },
    async remove(path) {
      try {
        const { d, name } = await parentOf(path, false);
        await d.removeEntry(name);
      } catch {
        /* already gone */
      }
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
        } catch {
          /* permission revoked or folder moved: keep trying quietly */
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
