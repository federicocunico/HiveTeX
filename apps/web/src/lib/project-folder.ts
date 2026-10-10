/**
 * Desktop: the project's folder, for the Files context menu (Open folder, Open in terminal, Copy folder path, Show in
 * file manager). A project kept in the app first gets `<Documents>/HiveTeX/<project ID>`, created on the native side
 * (the page never names a path), bound like any folder the user picked.
 */
export type FolderAction = { kind: 'open' } | { kind: 'terminal' } | { kind: 'copy' } | { kind: 'reveal'; path: string | null };

export interface FolderDeps {
  projectId: string;
  slug: string;
  /** Absolute path of the bound folder, or null when the project is kept in the app. */
  boundPath(): string | null;
  /** Binds the project to `path` (writes the files, starts the sync). */
  bind(path: string): Promise<void>;
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  copy(text: string): Promise<void>;
  /** Told before a folder is created, with its path. */
  onCreating?(path: string): void;
}

/** The bound folder, creating and binding the default one first when there is none. */
export async function ensureFolder(d: FolderDeps): Promise<{ path: string; created: boolean }> {
  const bound = d.boundPath();
  if (bound) return { path: bound, created: false };
  const path = await d.invoke<string>('mirror_default_folder', { slug: d.slug, projectId: d.projectId });
  d.onCreating?.(path);
  await d.bind(path);
  return { path, created: true };
}

/** Runs a folder action; returns the folder's path and whether it was just created. */
export async function runFolderAction(d: FolderDeps, action: FolderAction): Promise<{ path: string; created: boolean }> {
  const folder = await ensureFolder(d);
  const id = d.projectId;
  if (action.kind === 'open') await d.invoke('mirror_open', { id });
  else if (action.kind === 'terminal') await d.invoke('mirror_open_terminal', { id });
  else if (action.kind === 'copy') await d.copy(folder.path);
  else await d.invoke('mirror_reveal', { id, rel: action.path });
  return folder;
}
