import { type DemandKind, type Lease, type Persistence, type ProjectRuntime, RuntimeRegistry, type RuntimeKey, runtimeKeyString } from '@hivetex/sync';

/**
 * One project runtime per (server, account, project) in this app (D2, 4.2). Workspaces attach with an `editor`
 * lease; the desktop's background seeding attaches with `background` leases. Closing a workspace releases its lease:
 * the runtime keeps running while any other lease remains (a seed keeps syncing), and closes with the last one.
 */
export interface HostedRuntime {
  runtime: ProjectRuntime;
  store: Persistence;
  storeKind: 'indexeddb' | 'native';
  keys: import('@hivetex/crypto').StoredDeviceKeys;
  close(): Promise<void>;
  setPaused(paused: boolean): void;
  recoveryEntries?(): Promise<import('@hivetex/sync').IngressEntry[]>;
}

const factories = new Map<string, () => Promise<HostedRuntime>>();
let blocked = false;
let activeAccount: string | undefined;

export function activateRuntimes(account: string) {
  activeAccount = account;
  blocked = false;
}

/** Reject new attachments before waiting for storage or remote sign-out. */
export async function stopRuntimes() {
  blocked = true;
  activeAccount = undefined;
  const {isDesktop}=await import('./api.js');
  if(isDesktop){
    const {invoke}=await import('@tauri-apps/api/core');
    await invoke('worker_request',{method:'account.freeze',params:'{}'});
  }
  await runtimes.stopWhere(() => true);
  factories.clear();
  if(isDesktop){
    const {invoke}=await import('@tauri-apps/api/core');
    await invoke('worker_request',{method:'account.stop',params:'{}'});
  }
}

export const runtimes = new RuntimeRegistry<HostedRuntime>({
  create: (key) => {
    const f = factories.get(runtimeKeyString(key));
    if (!f) return Promise.reject(new Error('no runtime factory for this project'));
    return f();
  },
});

/** Attaches to the project's runtime, creating it with `factory` if none is running. */
export function attachRuntime(key: RuntimeKey, kind: DemandKind, factory: () => Promise<HostedRuntime>): Lease<HostedRuntime> {
  if (blocked || (activeAccount !== undefined && key.account !== activeAccount)) throw new Error('Account synchronization is stopped');
  factories.set(runtimeKeyString(key), factory);
  return runtimes.attach(key, kind);
}
