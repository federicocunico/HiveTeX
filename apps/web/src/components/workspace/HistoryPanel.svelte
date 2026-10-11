<script lang="ts">
  import type { HistorySnapshot } from '@hivetex/sync';
  import { onMount } from 'svelte';
  import type { ProjectSession } from '../../lib/session.svelte.js';
  import { toast } from '../../ui/toast.svelte.js';
  import PanelHead from './PanelHead.svelte';

  /** Local snapshots of the project; restoring one is an ordinary, undoable edit. */
  let { session }: { session: ProjectSession } = $props();

  let snapshots = $state<HistorySnapshot[]>([]);
  let loading = $state(true);
  let confirm = $state<string | null>(null);

  onMount(async () => {
    // Not while files are still arriving: a snapshot with empty stand-ins would restore as deletions.
    await session.model.captureSnapshot().catch((e) => toast(e instanceof Error ? e.message : 'No snapshot was taken', 'info'));
    snapshots = (await session.store.listSnapshots()).slice().reverse();
    loading = false;
  });

  async function restore(id: string) {
    confirm = null;
    try {
      await session.model.restore(id);
    } catch (e) {
      return toast(e instanceof Error ? e.message : 'Restore failed', 'error');
    }
    toast('Restored. The state before the restore was saved too, so you can undo it from History.');
    snapshots = (await session.store.listSnapshots()).slice().reverse();
  }
</script>

<section class="panel" aria-labelledby="history-title" data-testid="history-panel">
  <PanelHead title="History" id="history-title" />
  <p class="intro">Snapshots are kept on this device only. Restoring syncs to everyone and can be undone.</p>
  {#if loading}
    <p class="intro">Loading…</p>
  {:else if snapshots.length === 0}
    <p class="intro">No snapshots yet.</p>
  {/if}
  <ol class="snaps">
    {#each snapshots as sn, i (sn.id)}
      <li>
        <span class="dot" class:now={i === 0} aria-hidden="true"></span>
        <span class="info">
          <time datetime={new Date(sn.at).toISOString()}>{new Date(sn.at).toLocaleString()}</time>
          <span class="meta">{sn.files.length} file{sn.files.length === 1 ? '' : 's'}{i === 0 ? ' · just saved' : ''}</span>
        </span>
        {#if session.canWrite && i > 0}
          {#if confirm === sn.id}
            <button type="button" class="small primary" onclick={() => restore(sn.id)}>Restore?</button>
          {:else}
            <button type="button" class="small" onclick={() => (confirm = sn.id)}>Restore</button>
          {/if}
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
  }
  .intro {
    margin: 0 14px 10px;
    color: var(--muted);
    font-size: 12.5px;
  }
  .snaps {
    list-style: none;
    margin: 0;
    padding: 0 8px 8px 14px;
  }
  li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0 6px 16px;
    border-left: 1px solid var(--line);
  }
  .dot {
    position: absolute;
    left: -5px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--surface);
    border: 2px solid var(--line-strong);
  }
  .dot.now {
    border-color: var(--honey);
    background: var(--honey);
  }
  .info {
    display: grid;
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
  }
  .meta {
    color: var(--muted);
    font-size: var(--text-xs);
  }
</style>
