import { encodeValue, decodeValue, storeScope } from '@hivetex/sync';
import { apiBase, isDesktop } from './api.js';
import type { ProjectInfo } from './session.svelte.js';
import { openProjectStore } from './project-store.js';

export interface SeedSelection {
  project: { server: string; account: string; project: string; scope: string; role: 'owner' | 'editor' | 'viewer'; isLocal: boolean; createdHere: boolean };
  seedEnabled: boolean;
  paused: boolean;
  stage: string;
  status?: SeedRuntimeStatus | null;
}
export interface SeedStatus { background: boolean; paused: boolean; upnp?: boolean; projects: SeedSelection[] }
export async function seedRequest<T>(method: string, params: unknown = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  try { return decodeValue(await invoke<string>('worker_request', { method, params: encodeValue(params) })) as T; }
  catch (e) { throw e instanceof Error ? e : new Error(String(e)); }
}
export async function activateDesktopSeeds(account: string) {
  if (!isDesktop) return;
  await seedRequest('catalog.activate', { server: apiBase() || location.origin, account });
}
export async function downloadAndSeed(project: ProjectInfo, account: string) {
  // Migration still needs a foreground webview, but it never opens a workspace or changes recents.
  const opened = await openProjectStore({ kind: 'shared', project: project.id, account });
  if (opened.kind !== 'native') { await opened.store.close(); throw new Error('Complete native storage migration before enabling seeding.'); }
  await opened.store.close();
  const { localKeys } = await import('./keys.js');
  await localKeys(account); // explicit action can establish a durable identity; worker startup cannot invent one
  const server = apiBase() || location.origin;
  await seedRequest('catalog.activate', { server, account });
  await seedRequest('catalog.select', {
    project: { server, account, project: project.id, scope: await storeScope(server, account, project.id),
      role: project.role, isLocal: false, createdHere: false },
    enabled: true, download: true,
  });
}

/** Runtime facts the worker reports with an awake project (`catalog.list` → `status`). */
export interface SeedRuntimeStatus {
  saveFailing?: boolean;
  conflicts?: unknown[];
  mergeError?: string | null;
  peers?: { limited?: string | null }[];
  syncStatus?: { stage?: string; files?: { have?: boolean; deferred?: string }[] } | null;
}

const STAGES: Record<string, string> = {
  dormant: 'Reachable on request',
  waking: 'Waking',
  connecting: 'Connecting to the wake-up service',
  alone: 'Waiting for co-authors',
  queued: 'Queued: other projects are syncing',
  'ring-channel-unreachable': 'Wake-up service unreachable',
  'auth-required': 'Sign in to resume',
  receiving: 'Files still arriving',
  reconciling: 'Checking files',
  synced: 'Up to date with co-authors',
  offline: 'Offline',
  disabled: 'Background syncing off',
  paused: 'Work offline',
  'save-failure': 'Save failed',
};

/**
 * The status shown for a retained project. Problems that need the member win over the transport stage: an
 * unresolved conflict, a failing save, a relay limit, then files still missing or waiting for space.
 */
export function seedLabel(stage: string, status?: SeedRuntimeStatus | null): { text: string; attention: boolean } {
  if (status?.conflicts?.length || status?.mergeError) return { text: 'Unresolved conflict: open the project to resolve it', attention: true };
  if (status?.saveFailing || stage === 'save-failure') return { text: 'Save failed: open the project to export a recovery copy', attention: true };
  if (status?.peers?.some((p) => p.limited)) return { text: 'Server relay limit reached: changes wait on this device', attention: true };
  const files = status?.syncStatus?.files ?? [];
  if (files.some((f) => f.deferred)) return { text: 'Some files wait for disk space', attention: true };
  if (stage === 'receiving' && files.some((f) => f.have === false)) return { text: 'Incomplete: some files are not available from anyone online yet', attention: false };
  const attention = stage === 'auth-required' || stage === 'ring-channel-unreachable';
  return { text: STAGES[stage] ?? stage, attention };
}
