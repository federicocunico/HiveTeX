import { type FolderMarker, LEGACY_MARKER_FILE, MARKER_FILE, parseMarker } from '@hivetex/sync';
import { isDesktop } from './api.js';
import { folderAccessSupported, pickDirectory } from './fs-access.js';
import { type Location, folderLabel, setLocation } from './locations.js';

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
 * Reads the `.hivetex.json` marker of a picked folder, or its name from before the product was renamed
 * (null when the folder is not a project folder yet). Binding the folder later replaces an old marker.
 */
export async function readFolderMarker(f: PickedFolder): Promise<FolderMarker | null> {
  const names = [MARKER_FILE, LEGACY_MARKER_FILE];
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

/** Makes the folder the project's location on this device; the workspace binds it when the project opens. */
export function rememberFolder(projectId: string, f: PickedFolder) {
  const loc: Location = 'handle' in f ? { kind: 'folder', label: f.label, handle: f.handle } : { kind: 'folder', label: f.label, desktopPath: f.desktopPath };
  return setLocation(projectId, loc);
}

/** Slug suggestion from a folder name (6–48 chars of a–z, 0–9 and -). */
export function slugFromFolder(name: string): string {
  let s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (s.length < 6) s = `${s || 'paper'}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 48);
  return s;
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
