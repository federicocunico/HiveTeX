import type { FsAdapter } from '@hivetex/sync';

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * FsAdapter over the confined `mirror_*` Tauri commands. The Rust side only serves folders the user
 * bound through the OS dialog and refuses traversal and symlink escapes.
 */
export async function tauriFs(id: string, dir: string): Promise<FsAdapter & { dispose(): Promise<void> }> {
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  await invoke('mirror_bind', { id, dir });
  return {
    async list() {
      return invoke<Array<{ path: string; size: number }>>('mirror_list', { id });
    },
    async retained() { return invoke<Array<{ path: string; size: number }>>('mirror_retained', { id }); },
    async read(path) {
      const b = await invoke<string | null>('mirror_read', { id, path });
      return b === null ? null : fromB64(b);
    },
    // Both resolve with the transient retained copy of the replaced file; the mirror compares it, then drops it.
    async write(path, bytes) {
      return invoke<string | null>('mirror_write', { id, path, b64: toB64(bytes) });
    },
    async remove(path) {
      return invoke<string | null>('mirror_remove', { id, path });
    },
    async dropRetained(path) {
      await invoke('mirror_drop_retained', { id, path });
    },
    watch(cb) {
      let un: (() => void) | null = null;
      let stopped = false;
      void listen<string>(`mirror://${id}`, (e) => cb(e.payload.startsWith('\0error:') ? { path: '', error: e.payload.slice(7) } : { path: e.payload })).then((u) => {
        if (stopped) u();
        else un = u;
      });
      return () => {
        stopped = true;
        un?.();
      };
    },
    async dispose() {
      await invoke('mirror_unbind', { id });
    },
  };
}

/**
 * Opens the native folder picker (from Rust). Only folders chosen this way can later be mirrored or imported:
 * the native side refuses paths that merely come from page script.
 */
export async function pickFolder(title = 'Choose a folder to mirror this project'): Promise<string | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string | null>('mirror_pick', { title });
}

/**
 * Lists a folder for import through the same confined commands as the mirror (no symlinks, no traversal, tool folders
 * skipped). Call `done()` after reading to release the folder.
 */
export async function folderItems(dir: string): Promise<{ items: Array<{ path: string; size: number; read(): Promise<Uint8Array> }>; done(): Promise<void> }> {
  const { invoke } = await import('@tauri-apps/api/core');
  const id = `import-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await invoke('mirror_bind', { id, dir });
  const listed = await invoke<Array<{ path: string; size: number }>>('mirror_list', { id });
  return {
    items: listed.map((f) => ({
      path: f.path,
      size: f.size,
      read: async () => {
        const b = await invoke<string | null>('mirror_read', { id, path: f.path });
        if (b === null) throw new Error(`${f.path} disappeared while importing`);
        return fromB64(b);
      },
    })),
    done: async () => {
      await invoke('mirror_unbind', { id });
    },
  };
}
