import { type FolderMarker, MARKER_FILE, parseMarker } from '@hivetex/sync';
import { isDesktop } from './api.js';
import { folderAccessSupported, pickDirectory, webFs } from './fs-access.js';
import { type Location, folderLabel, setLocation } from './locations.js';
import { readLoose, type Progress } from './import/sources.js';

/** A folder the user just picked: a desktop path (allowlisted by the native picker) or a web directory handle. */
export type PickedFolder = { label: string; desktopPath: string } | { label: string; handle: FileSystemDirectoryHandle };

export const foldersSupported = () => isDesktop || folderAccessSupported();

export async function pickProjectFolder(title = 'Choose a folder'): Promise<PickedFolder | null> {
  if (isDesktop) {
    const { pickFolder } = await import('./tauri-fs.js');
    const dir = await pickFolder(title);
    return dir ? { label: folderLabel(dir), desktopPath: dir } : null;
  }
  const handle = await pickDirectory();
  return handle ? { label: handle.name, handle } : null;
}

/**
 * Reads the `.hivetex.json` marker of a picked folder (null when the folder is not a project folder yet).
 */
export async function readFolderMarker(f: PickedFolder): Promise<FolderMarker | null> {
  const names = [MARKER_FILE];
  if ('handle' in f) {
    for (const name of names) {
      try {
        const file = await (await f.handle.getFileHandle(name)).getFile();
        const marker = parseMarker(new Uint8Array(await file.arrayBuffer()));
        if (marker) return marker;
      } catch {
        /* not there */
      }
    }
    return null;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  const id = `marker-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await invoke('mirror_bind', { id, dir: f.desktopPath });
  try {
    for (const name of names) {
      const b64 = await invoke<string | null>('mirror_read', { id, path: name });
      const marker = b64 === null ? null : parseMarker(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      if (marker) return marker;
    }
    return null;
  } finally {
    await invoke('mirror_unbind', { id });
  }
}

const pendingBrowserImports = new Map<string, FileSystemDirectoryHandle>();
export function takeBrowserFolderImport(projectId: string) {
  const handle = pendingBrowserImports.get(projectId);
  pendingBrowserImports.delete(projectId);
  return handle;
}
/** Browser folders are one-shot imports. Only the native adapter can be a bidirectional location. */
export async function rememberFolder(projectId: string, f: PickedFolder) {
  if ('handle' in f) { pendingBrowserImports.set(projectId, f.handle); return; }
  const loc: Location = { kind: 'folder', label: f.label, desktopPath: f.desktopPath };
  return setLocation(projectId, loc);
}

export async function readBrowserFolder(handle: FileSystemDirectoryHandle, progress?: Progress) {
  const fs = webFs(handle);
  try {
    const items = (await fs.list()).map((file) => ({ ...file, read: async () => {
      const bytes = await fs.read(file.path);
      if (!bytes) throw new Error(`Folder file disappeared during import: ${file.path}`);
      return bytes;
    } }));
    return await readLoose(handle.name, items, { stripRoot: false }, progress);
  } finally { fs.dispose(); }
}

/** Readable prefix suggestion; only the server assigns a share-ID suffix. */
export function slugFromFolder(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31).replace(/-$/, '') || 'paper';
}

/** Project created from a folder: the workspace detects main/engine once the folder content is imported. */
let freshFolderProject: string | null = null;
export function markFreshFolderProject(id: string) {
  freshFolderProject = id;
}
export function takeFreshFolderProject(id: string) {
  const hit = freshFolderProject === id;
  if (hit) freshFolderProject = null;
  return hit;
}
