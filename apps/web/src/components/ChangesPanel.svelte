<script lang="ts">
  import { type ChangeSet, patchHunks } from '@hivetex/sync';
  import type { ProjectSession } from '../lib/session.svelte.js';
  import { ChevronDown, ChevronRight, FolderOpen, Pencil, Undo, User } from '../ui/icons.js';
  import Icon from '../ui/Icon.svelte';
  import PanelHead from './workspace/PanelHead.svelte';

  /** Every change to the project, newest first, grouped by who made it, with per-file diffs and undo. */
  let { session }: { session: ProjectSession } = $props();

  let open = $state<string | null>(null);
  let openFile = $state<string | null>(null);
  let busy = $state<string | null>(null);
  let message = $state('');

  const ago = (t: number) => {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(t).toLocaleString();
  };

  const icon = (c: ChangeSet) => (c.source.kind === 'folder' ? FolderOpen : c.source.kind === 'peer' ? User : c.source.kind === 'undo' ? Undo : Pencil);
  const sourceLabel = (c: ChangeSet) =>
    c.source.kind === 'folder' ? 'In the folder on this device' : c.source.kind === 'peer' ? `Co-author · ${c.source.origin ?? 'legacy'}` : c.source.kind === 'undo' ? 'Undo' : c.source.kind === 'restore' ? 'Version restore' : c.source.kind === 'import' ? 'Import' : 'In this app';

  const opLabel: Record<string, string> = { edit: 'edited', create: 'created', delete: 'deleted', rename: 'renamed', binary: 'replaced' };

  async function undo(c: ChangeSet) {
    busy = c.id;
    message = '';
    try {
      const r = await session.undoChange(c);
      message = r?.partial?.length
        ? `Partially undone: ${r.partial.join(', ')} changed again later in the same place.`
        : 'Undone. The undo itself appears in the list and can be undone too.';
    } catch (e) {
      message = e instanceof Error ? e.message : 'Undo failed';
    } finally {
      busy = null;
    }
  }
</script>

<section class="panel" aria-labelledby="changes-title" data-testid="changes-panel">
  <PanelHead title="Changes" id="changes-title" />
  <p class="intro">
    File changes grouped by author and device, with the original origin shown when verified. Retained peer history
    is received separately from the current sources. Private folder recovery copies stay on this device.
  </p>
  <p class="intro" role="status" data-testid="history-sync-status">
    {#if session.historyStatus.quarantined}An unsafe or unsupported sync update was held in private Recovery. Update the sending peer before retrying.
    {:else if session.historyStatus.legacyPeers}A connected older peer cannot supply verified history. Original authors may be unknown.
    {:else if session.historyStatus.pending}Receiving retained history from peers…
    {:else if session.historyStatus.complete}Retained history received from connected peers.
    {:else}History held on this device; source sync status is shown separately.{/if}
  </p>
  {#if message}<div class="notice" role="status" data-testid="changes-message">{message}</div>{/if}
  {#if session.changes.length === 0}
    <p class="empty">No changes recorded on this device yet.</p>
  {/if}
  <ul class="sets">
    {#each session.changes as c (c.id)}
      <li class="set" data-testid="change-set" data-source={c.source.kind}>
        <div class="row">
          <button type="button" class="head" aria-expanded={open === c.id} onclick={() => (open = open === c.id ? null : c.id)}>
            <Icon icon={open === c.id ? ChevronDown : ChevronRight} size={14} />
            <span class="src" data-tip={sourceLabel(c)}><Icon icon={icon(c)} size={14} /></span>
            <span class="who">
              <strong>{c.source.name}</strong>
              {#if c.source.actorName && c.source.actorName !== c.source.name}<span class="meta">By {c.source.actorName}</span>{/if}
              {#if c.source.device}<span class="meta">Device {c.source.device} · {c.source.provenance === 'verified' ? 'verified origin' : 'local record'}</span>{/if}
              <span class="meta">{c.files.length} file{c.files.length === 1 ? '' : 's'} · {ago(c.endedAt)}</span>
            </span>
          </button>
          {#if session.canWrite}
            <button type="button" class="undo" disabled={busy === c.id} onclick={() => undo(c)} data-testid="undo-change">Undo</button>
          {/if}
        </div>
        {#if open === c.id}
          <ul class="files">
            {#each c.files as f, fileIndex (f.fileId + f.op + fileIndex)}
              <li>
                <button type="button" class="file" onclick={() => (openFile = openFile === c.id + f.fileId ? null : c.id + f.fileId)}>
                  <code>{f.path}</code> {opLabel[f.op]}{f.from ? ` (from ${f.from})` : ''}
                  {#if f.added !== undefined}<span class="add">+{f.added}</span> <span class="del">−{f.removed}</span>{/if}
                </button>
                {#if openFile === c.id + f.fileId && f.patch}
                  <div class="diff" data-testid="change-diff">
                    {#each patchHunks(f.patch) as hunk, i (i)}
                      {#if i > 0}<div class="sep">…</div>{/if}
                      <pre>{#each hunk as part, j (j)}<span class={part.op === 1 ? 'ins' : part.op === -1 ? 'rem' : ''}>{part.text}</span>{/each}</pre>
                    {/each}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
          {#if c.partial?.length}<p class="meta">Partially undone: {c.partial.join(', ')}</p>{/if}
        {/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
  }
  .intro,
  .empty {
    margin: 0 14px 10px;
    color: var(--muted);
    font-size: 12.5px;
  }
  .notice {
    margin: 0 10px 8px;
    padding: 6px 10px;
    font-size: var(--text-sm);
  }
  .sets,
  .files {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .set {
    border-top: 1px solid var(--line);
    padding: 6px 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .head {
    flex: 1;
    min-width: 0;
    min-height: 0;
    justify-content: flex-start;
    gap: 6px;
    padding: 4px;
    border: 0;
    background: none;
    font-weight: 400;
    text-align: left;
  }
  .src {
    display: inline-flex;
    color: var(--muted);
  }
  .who {
    display: grid;
    min-width: 0;
  }
  .who strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--muted);
    font-size: var(--text-xs);
  }
  .undo {
    min-height: 26px;
    padding: 0 8px;
    font-size: var(--text-xs);
  }
  .files {
    padding-left: 24px;
  }
  .file {
    min-height: 0;
    padding: 3px 4px;
    border: 0;
    background: none;
    font-weight: 400;
    font-size: var(--text-xs);
    text-align: left;
    white-space: normal;
    justify-content: flex-start;
  }
  .add {
    color: var(--ok);
  }
  .del {
    color: var(--bad);
  }
  .diff pre {
    white-space: pre-wrap;
    font-size: 12px;
    margin: 4px 0;
    padding: 6px;
    background: var(--sunken);
    border-radius: var(--r-s);
    max-height: 320px;
    overflow: auto;
  }
  .ins {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .rem {
    background: var(--bad-soft);
    color: var(--bad);
    text-decoration: line-through;
  }
  .sep {
    color: var(--muted);
    font-size: 12px;
  }
</style>
