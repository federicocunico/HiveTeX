<script lang="ts">
  import { onMount } from 'svelte';
  import type { ProjectInfo } from '../lib/session.svelte.js';
  import { seedRequest, downloadAndSeed, seedLabel, type SeedStatus, type SeedSelection } from '../lib/seeds.js';
  import { mappingText, type MappingState } from '../lib/sync-view.js';
  let { projects, account }: { projects: ProjectInfo[]; account: string } = $props();
  let status = $state<SeedStatus>({ background: true, paused: false, projects: [] });
  let error = $state('');
  let busy = $state(false);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startup = $state<{ login: boolean; background: boolean; tray: boolean }>({ login: false, background: false, tray: true });
  let mapping = $state<MappingState>({ state: 'disabled' });
  async function invoke<T>(cmd: string, args?: Record<string, unknown>) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  async function refresh() {
    try {
      const next = await seedRequest<SeedStatus>('catalog.list');
      if (!closed) status = next;
      const [s, m] = await Promise.all([invoke<typeof startup>('startup_get'), invoke<MappingState>('upnp_status')]);
      if (!closed) { startup = s; mapping = m; }
    } catch (e) { if (!closed) error = String(e); }
  }
  onMount(() => {
    void refresh();
    let off: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const stop = await listen<{ event: string }>('worker://event', ({ payload }) => {
        if (payload.event !== 'catalog.change' || closed || timer) return;
        timer = setTimeout(() => { timer = null; void refresh(); }, 200);
      });
      if (closed) stop(); else off = stop;
    });
    return () => { closed = true; off?.(); if (timer) clearTimeout(timer); };
  });
  async function action(fn: () => Promise<unknown>) {
    busy = true; error = '';
    try { await fn(); await refresh(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  const selected = (p: ProjectInfo): SeedSelection | undefined => status.projects.find((r) => r.project.project === p.id);
</script>

<details class="seeds" data-testid="background-seeds">
  <summary>Background syncing</summary>
  <p>Projects retained on this device are available as dormant seeds by default when you own or can edit them.
    Background syncing does not compile, back up to GitHub or watch local folders. Folder changes merge when you reopen the editor.</p>
  <div class="controls">
    <label><input type="checkbox" checked={status.background} disabled={busy} onchange={(e) => action(() => seedRequest('catalog.settings', { background: e.currentTarget.checked }))} />Enable background syncing</label>
    <label><input type="checkbox" checked={status.paused} disabled={busy} onchange={(e) => action(() => seedRequest('catalog.settings', { paused: e.currentTarget.checked }))} />Work offline for all projects</label>
    <label><input type="checkbox" checked={status.upnp !== false} disabled={busy} data-testid="upnp-toggle" onchange={(e) => action(() => seedRequest('catalog.settings', { upnp: e.currentTarget.checked }))} />Ask the router to forward a port (UPnP)</label>
  </div>
  <p class="mapping" data-testid="upnp-status">{mappingText(mapping)}</p>
  <div class="controls">
    <label><input type="checkbox" checked={startup.login} disabled={busy} data-testid="launch-at-login" onchange={(e) => action(() => invoke('startup_set', { login: e.currentTarget.checked, background: startup.background }))} />Start HiveTeX when I sign in to this computer</label>
    <label><input type="checkbox" checked={startup.background} disabled={busy || !startup.login} data-testid="start-in-background" onchange={(e) => action(() => invoke('startup_set', { login: startup.login, background: e.currentTarget.checked }))} />Start in the background (no window)</label>
    <button type="button" disabled={busy} data-testid="quit-app" onclick={() => action(() => invoke('app_quit', { discard: false }))}>Quit HiveTeX</button>
  </div>
  <ul>
    {#each projects.filter((p) => p.role !== 'viewer') as project (project.id)}
      {@const selection = selected(project)}
      <li>
        <span>{project.slug}</span>
        {#if selection}
          {@const label = seedLabel(selection.stage, selection.status)}
          <span class="stage" class:warn={label.attention} data-testid="seed-stage-{project.slug}">{label.text}</span>
          <label><input type="checkbox" checked={selection.seedEnabled} disabled={busy} onchange={(e) => action(() => seedRequest('catalog.select', { project: selection.project, enabled: e.currentTarget.checked }))} />Seed</label>
          <button type="button" disabled={busy} onclick={() => action(() => seedRequest('catalog.pause', { project: selection.project, paused: !selection.paused }))}>{selection.paused ? 'Resume' : 'Work offline'}</button>
        {:else}
          <span class="stage">Not downloaded on this device</span>
          <button type="button" disabled={busy} onclick={() => action(() => downloadAndSeed(project, account))}>Download and seed</button>
        {/if}
      </li>
    {/each}
  </ul>
  {#if error}<p role="alert">{error}</p>{/if}
</details>

<style>
  .seeds { padding: 12px; border: 1px solid var(--border); border-radius: 8px; margin-block: 12px; }
  summary { cursor: pointer; font-weight: 500; }
  p, .stage { color: var(--muted); font-size: var(--text-sm); }
  .controls, li { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  ul { padding: 0; list-style: none; }
  li { padding-block: 6px; }
  li > span:first-child { min-width: 160px; }
  .stage { flex: 1; }
  .warn { color: var(--warning, #b45309); }
  .mapping { margin-block: 4px; }
</style>
