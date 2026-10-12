<script lang="ts">
  // Desktop only: what the tray cannot say. Without a system tray, closing minimizes the window, and this notice
  // keeps Pause and Quit reachable. When Quit cannot save everything, the app stays open here: the member exports a
  // recovery copy from the project, or explicitly discards the unsaved edits.
  import { onMount } from 'svelte';
  import { isDesktop } from '../lib/api.js';
  import { go } from '../lib/router.svelte.js';
  import Button from '../ui/Button.svelte';
  import Dialog from '../ui/Dialog.svelte';

  let noTray = $state(false);
  let failed = $state<{ failing: string[] } | null>(null);
  let busy = $state(false);

  async function invoke<T>(cmd: string, args?: Record<string, unknown>) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }

  onMount(() => {
    if (!isDesktop) return;
    let gone = false;
    const offs: (() => void)[] = [];
    void invoke<{ tray: boolean }>('startup_get').then((s) => { if (!gone) noTray = !s.tray; }).catch(() => {});
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const a = await listen('app://no-tray', () => (noTray = true));
      const b = await listen<{ failing?: string[] }>('app://quit-failed', (e) => (failed = { failing: e.payload.failing ?? [] }));
      if (gone) { a(); b(); } else offs.push(a, b);
    });
    return () => { gone = true; for (const off of offs) off(); };
  });

  async function quit(discard: boolean) {
    busy = true;
    try { await invoke('app_quit', { discard }); } finally { busy = false; }
  }
  async function pauseAll() {
    const { seedRequest } = await import('../lib/seeds.js');
    await seedRequest('catalog.settings', { paused: true }).catch(() => {});
  }
  function openProject(id: string) {
    failed = null;
    go(`/p/${id}`);
  }
</script>

{#if noTray}
  <div class="no-tray" role="note" data-testid="no-tray">
    <span>This desktop has no system tray. Closing the window minimizes it and syncing continues.</span>
    <Button size="sm" onclick={pauseAll}>Pause all synchronization</Button>
    <Button size="sm" onclick={() => quit(false)} disabled={busy}>Quit HiveTeX</Button>
  </div>
{/if}

{#if failed}
  <Dialog title="Some edits could not be saved" onClose={() => (failed = null)} size="sm" testid="quit-failed">
    <p>HiveTeX did not quit because these projects could not save every change on this device:</p>
    <ul>
      {#each failed.failing as id (id)}
        <li><button type="button" class="linkish" onclick={() => openProject(id)}>{id}</button>: open it and use <em>Export recovery copy</em></li>
      {/each}
    </ul>
    <p class="muted">Quitting anyway loses the unsaved edits in these projects.</p>
    {#snippet footer()}
      <Button onclick={() => (failed = null)}>Keep HiveTeX open</Button>
      <Button variant="danger" disabled={busy} onclick={() => quit(true)} data-testid="quit-discard">Quit and discard unsaved edits</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .no-tray { position: fixed; inset-inline: 16px; bottom: 16px; z-index: 50; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface, #fff); font-size: var(--text-sm); }
  .no-tray span { flex: 1; min-width: 200px; }
  .linkish { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; text-decoration: underline; }
  .muted { color: var(--muted); }
</style>
