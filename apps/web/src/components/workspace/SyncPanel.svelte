<script lang="ts">
  import type { ProjectSession } from '../../lib/session.svelte.js';
  import { presenceColor } from '../../lib/presence.js';
  import { editorsByFile, sinceText, syncLabel } from '../../lib/sync-view.js';
  import { RefreshCw } from '../../ui/icons.js';
  import Icon from '../../ui/Icon.svelte';
  import PanelHead from './PanelHead.svelte';

  /** How far the sync is, per file, who is editing what, and a way to force a sync. */
  let { session, onOpenFile, onConflicts }: { session: ProjectSession; onOpenFile?: (path: string) => void; onConflicts?: () => void } = $props();

  const status = $derived(session.syncStatus);
  const editors = $derived(editorsByFile(session.presence));
  let showAll = $state(false);
  const LIMIT = 200;

  // Not-received files first (what the user wants to know about), then files someone is editing, then the rest.
  const rows = $derived.by(() => {
    const files = [...(status?.files ?? [])];
    const rank = (f: (typeof files)[number]) => (f.have ? ((editors.get(f.path)?.length ?? 0) > 0 ? 1 : 2) : 0);
    files.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : 1));
    return showAll ? files : files.slice(0, LIMIT);
  });
  const stateText = { received: 'received', receiving: 'receiving', waiting: 'waiting for a co-author' } as const;
</script>

<section class="panel" aria-labelledby="sync-title" data-testid="sync-panel">
  <PanelHead title="Sync" id="sync-title" />
  <div class="summary">
    <p class="line" data-testid="sync-line">{syncLabel(status)}</p>
    {#if status && status.percent !== null}
      <div class="bar" role="progressbar" aria-label="Files received" aria-valuemin="0" aria-valuemax="100" aria-valuenow={status.percent}>
        <span style:width="{status.percent}%"></span>
      </div>
      <p class="meta" data-testid="sync-count">{status.received} of {status.total} files received</p>
    {:else if status && status.total > 0}
      <p class="meta">{status.total} files in the project, nothing to compare with yet.</p>
    {/if}
    <p class="meta" data-testid="last-sync">Last synced: {sinceText(status?.lastSyncAt ?? null)}</p>
    <p class="meta">{status?.peers ?? 0} connected{status?.connecting ? `, ${status.connecting} connecting` : ''}</p>
    {#if session.unsharedWork}<p class="meta" data-testid="sync-unshared">Changes made while nobody else was connected: merged when a co-author connects.</p>{/if}
    {#if session.lastMerge && (session.lastMerge.merged.length || session.lastMerge.taken.length)}
      <p class="meta" data-testid="sync-merged">
        Last offline merge: {session.lastMerge.taken.length} file{session.lastMerge.taken.length === 1 ? '' : 's'} taken as is{session.lastMerge.merged.length ? `, merged with others' changes: ${session.lastMerge.merged.join(', ')}` : ''}.
      </p>
    {/if}
    {#if session.conflicts.length}
      <p class="meta bad" data-testid="sync-conflicts">
        {session.conflicts.length} conflict{session.conflicts.length === 1 ? '' : 's'} with your offline changes.
        <button type="button" class="small" onclick={onConflicts}>Resolve</button>
      </p>
    {/if}
    <button type="button" class="primary" onclick={() => void session.syncNow()} disabled={session.syncingNow} data-testid="sync-now">
      <Icon icon={RefreshCw} />{session.syncingNow ? 'Syncing…' : 'Sync now'}
    </button>
    {#if session.syncNowResult}<p class="result" role="status" data-testid="sync-now-result">{session.syncNowResult}</p>{/if}
  </div>

  {#if status && status.files.length > 0}
    <h3>Files</h3>
    <ul class="files" data-testid="sync-files">
      {#each rows as f (f.id)}
        {@const who = editors.get(f.path) ?? []}
        <li data-state={f.state}>
          <button type="button" class="name" onclick={() => onOpenFile?.(f.path)} title={f.path}>{f.path}</button>
          <span class="st">
            {#each who as w (w)}<span class="pdot" style:background={presenceColor(w)} aria-hidden="true"></span>{/each}
            {#if who.length}<span class="who">{who.join(', ')} editing</span>{:else}<span class:muted={f.have}>{stateText[f.state]}</span>{/if}
          </span>
        </li>
      {/each}
    </ul>
    {#if !showAll && status.files.length > LIMIT}
      <button type="button" class="more" onclick={() => (showAll = true)}>Show all {status.files.length} files</button>
    {/if}
  {/if}
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
  }
  .summary {
    display: grid;
    gap: 6px;
    padding: 4px 14px 10px;
  }
  .line {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .meta,
  .result {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }
  .result {
    color: var(--text);
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--line, #8883);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent, #2f6feb);
    transition: width 0.25s;
  }
  button.primary {
    justify-self: start;
  }
  h3 {
    margin: 4px 14px;
    font-size: var(--text-sm);
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 0 8px 12px;
  }
  .files li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 6px;
    font-size: var(--text-xs);
  }
  .files li[data-state='receiving'],
  .files li[data-state='waiting'] {
    font-style: italic;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    background: none;
    border: 0;
    padding: 0;
    color: inherit;
    cursor: pointer;
  }
  .st {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .muted {
    color: var(--muted);
  }
  .pdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .more {
    margin: 0 14px 12px;
  }
</style>
