import type { ProjectInfo } from './session.svelte.js';

/**
 * Projects that exist only on this computer (desktop local mode, local-mode spec). They have ids `local-<uuid>`, are
 * listed under "On this computer", and open like any project kept on this device: the workspace finds their
 * description in the same cache it uses offline (`hivetex.proj.<id>`), and the session works offline.
 */
export interface LocalProject {
  id: string;
  name: string;
  createdAt: string;
}

const KEY = 'hivetex.localProjects';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const isLocalProjectId = (id: string) => id.startsWith('local-');

export function listLocalProjects(storage: Store = localStorage): LocalProject[] {
  try {
    const v = JSON.parse(storage.getItem(KEY) ?? '[]') as LocalProject[];
    return Array.isArray(v) ? v.filter((p) => p && typeof p.id === 'string' && isLocalProjectId(p.id)) : [];
  } catch {
    return [];
  }
}

function save(list: LocalProject[], storage: Store) {
  storage.setItem(KEY, JSON.stringify(list));
}

/** The description the workspace and session use for a local project: this person owns it, nobody else is in it. */
export function localProjectInfo(p: LocalProject): ProjectInfo {
  return { id: p.id, slug: p.name, role: 'owner', defaultRole: 'editor', passwordProtected: false, epoch: 0, lastOpenedAt: null };
}

const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ').slice(0, 80) || 'Untitled';

export function createLocalProject(name: string, storage: Store = localStorage, uuid: () => string = () => crypto.randomUUID()): LocalProject {
  const p: LocalProject = { id: `local-${uuid()}`, name: cleanName(name), createdAt: new Date().toISOString() };
  save([...listLocalProjects(storage), p], storage);
  storage.setItem(`hivetex.proj.${p.id}`, JSON.stringify(localProjectInfo(p)));
  return p;
}

export function getLocalProject(id: string, storage: Store = localStorage) {
  return listLocalProjects(storage).find((p) => p.id === id) ?? null;
}

/** Forgets a local project (its stored contents are deleted separately, see removeLocalProjectData). */
export function forgetLocalProject(id: string, storage: Store = localStorage) {
  save(
    listLocalProjects(storage).filter((p) => p.id !== id),
    storage,
  );
  storage.removeItem(`hivetex.proj.${id}`);
}

/** Deletes a local project's stored contents on this device (see project-store.ts: IndexedDB or the native store). */
export async function removeLocalProjectData(id: string): Promise<void> {
  const { removeProjectStore } = await import('./project-store.js');
  await removeProjectStore({ kind: 'local', id });
}

/** Copies a local project's stored contents (documents, images, history, change log) into a shared project's store. */
export async function copyProjectData(fromId: string, to: { project: string; account: string }): Promise<void> {
  const { copyProjectContent } = await import('./project-store.js');
  await copyProjectContent({ kind: 'local', id: fromId }, { kind: 'shared', ...to });
}

/**
 * Publish (signed in): the local project becomes a shared project with exactly its files and history, and its folder
 * (if any) stays linked. `create` makes the project on the server and returns its description.
 */
export async function publishLocalProject(local: LocalProject, create: () => Promise<ProjectInfo>, account: string): Promise<ProjectInfo> {
  const info = await create();
  await copyProjectData(local.id, { project: info.id, account });
  const { getLocation, removeLocation, setLocation } = await import('./locations.js');
  const loc = await getLocation(local.id).catch(() => null);
  if (loc && loc.kind === 'folder') {
    await setLocation(info.id, loc);
    await removeLocation(local.id);
  }
  localStorage.setItem(`hivetex.proj.${info.id}`, JSON.stringify(info));
  forgetLocalProject(local.id);
  await removeLocalProjectData(local.id);
  return info;
}

/** Link (signed in): the workspace of the joined project merges this local project in once it has the project's files. */
let pendingLink: { localId: string; projectId: string } | null = null;
export function setPendingLink(localId: string, projectId: string) {
  pendingLink = { localId, projectId };
}
export function takePendingLink(projectId: string) {
  const p = pendingLink?.projectId === projectId ? pendingLink : null;
  if (p) pendingLink = null;
  return p;
}
