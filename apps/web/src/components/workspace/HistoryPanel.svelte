<script lang="ts">
  import type { HistorySnapshot } from '@hivetex/sync';
  import { onMount } from 'svelte';
  import type { ProjectSession } from '../../lib/session.svelte.js';
  import { toast } from '../../ui/toast.svelte.js';
  import PanelHead from './PanelHead.svelte';
  import RecoverySection from './RecoverySection.svelte';

  /** Local snapshots of the project; restoring one is an ordinary, undoable edit. */
  let { session }: { session: ProjectSession } = $props();

  let snapshots = $state<HistorySnapshot[]>([]);
  let loading = $state(true);
  let confirm = $state<string | null>(null);
  let previewRevision = $state<number | undefined>(undefined);
  let previewRequestId = $state<string | undefined>(undefined);
  /** Interrupted undos and restores (prepared checkpoints): each can be completed or cancelled (D4). */
  type Interrupted = { kind: 'undo' | 'restore'; id: string; snapshotId?: string; label: string; files: string[]; at?: number };
  let interrupted = $state<Interrupted[]>([]);
  let resolving = $state<string | null>(null);

  async function loadInterrupted() {
    const out: Interrupted[] = [];
    // Two key ranges, never a scan of every retained history record (D6).
    for (const key of await session.store.listMetaKeys?.('restore:pending:') ?? []) {
      const r = await session.store.getMeta(key) as { stage?: string; snapshotId?: string; at?: number } | undefined;
      if (r?.stage === 'prepared' && r.snapshotId) out.push({ kind: 'restore', id: key.slice(16), snapshotId: r.snapshotId, label: 'Restore of a version', files: [], ...(r.at ? { at: r.at } : {}) });
    }
    for (const r of await session.changelog?.interruptedUndos?.() ?? []) {
      out.push({ kind: 'undo', id: r.changeSetId, label: `Undo of ${r.label ?? 'a change'}`, files: r.done.map((s) => s.path), ...(r.at ? { at: r.at } : {}) });
    }
    interrupted = out;
  }

  onMount(async () => {
    // Not while files are still arriving: a snapshot with empty stand-ins would restore as deletions.
    await session.model.captureSnapshot().catch((e) => toast(e instanceof Error ? e.message : 'No snapshot was taken', 'info'));
    snapshots = (await session.store.listSnapshots()).slice().reverse();
    await loadInterrupted().catch((e) => toast(e instanceof Error ? e.message : 'Interrupted operations could not be read', 'error'));
    loading = false;
  });

  async function resolve(op: Interrupted, complete: boolean) {
    resolving = op.id;
    try {
      if (op.kind === 'restore') {
        if (complete) await session.model.restore(op.snapshotId!, () => session.canWrite, undefined, op.id);
        else await session.model.abandonRestore(op.id, () => session.canWrite);
      } else if (complete) {
        const set = (await session.changelog?.list() ?? []).find((c) => c.id === op.id);
        if (!set) throw new Error('The undone change is no longer in Changes; cancel the interrupted undo instead.');
        await session.undoChange(set);
      } else await session.changelog?.abandonUndo(op.id, () => session.canWrite);
      toast(complete ? 'Completed.' : 'Cancelled. The files it had changed were put back.');
      snapshots = (await session.store.listSnapshots()).slice().reverse();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The interrupted operation could not be resolved', 'error');
    } finally {
      resolving = null;
      await loadInterrupted().catch(() => {});
    }
  }

  async function restore(id: string) {
    confirm = null;
    try {
      await session.model.restore(id, () => session.canWrite, previewRevision, previewRequestId);
    } catch (e) {
      return toast(e instanceof Error ? e.message : 'Restore failed', 'error');
    }
    toast('Restored. The state before the restore was saved too, so you can undo it from History.');
    snapshots = (await session.store.listSnapshots()).slice().reverse();
  }

  async function preview(id: string) {
    try {
      const result = await session.model.previewRestore(id);
      previewRevision = result.revision;
      previewRequestId = result.requestId;
      confirm = id;
    } catch (error) { toast(error instanceof Error ? error.message : 'Preview failed', 'error'); }
  }
</script>

<section class="panel" aria-labelledby="history-title" data-testid="history-panel">
  <PanelHead title="History" id="history-title" />
  <p class="intro">Snapshots are kept on this device only. Restoring syncs to everyone and can be undone.</p>
  {#each interrupted as op (op.kind + op.id)}
    <div class="intro interrupted" role="status" data-testid="interrupted-operation" data-kind={op.kind}>
      <p><strong>{op.label} was interrupted.</strong>
        {#if op.files.length}Already changed: {op.files.join(', ')}.{/if}
        Complete it, or cancel it to put back what it changed. A recovery snapshot was saved before it started.</p>
      {#if session.canWrite}
        <button type="button" class="small primary" disabled={resolving !== null} onclick={() => resolve(op, true)}>Complete</button>
        <button type="button" class="small" disabled={resolving !== null} onclick={() => resolve(op, false)}>Cancel</button>
      {/if}
    </div>
  {/each}
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
            <button type="button" class="small primary" onclick={() => restore(sn.id)}>Restore {sn.files.length} files and settings?</button>
          {:else}
            <button type="button" class="small" onclick={() => preview(sn.id)}>Preview restore</button>
          {/if}
        {/if}
      </li>
    {/each}
  </ol>
  <RecoverySection {session} />
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
