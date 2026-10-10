<script lang="ts">
  import { type ChangeSet, patchHunks } from '@hivetex/sync';
  import type { ProjectSession } from '../lib/session.svelte.js';

  let { session, onClose }: { session: ProjectSession; onClose: () => void } = $props();

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

  const badge = (c: ChangeSet) =>
    c.source.kind === 'folder' ? '📁' : c.source.kind === 'peer' ? '👤' : c.source.kind === 'undo' ? '↶' : '✎';

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

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="changes-title" data-testid="changes-panel" tabindex="-1" onkeydown={onKey}>
  <div class="card changes-card">
    <div class="row">
      <h2 id="changes-title" class="spacer">Changes</h2>
      <button onclick={onClose}>Close</button>
    </div>
    <p class="muted">
      Every change to the project, grouped by who made it: 📁 edits made in the folder on this device (for example by
      Claude Code or Codex), ✎ edits in this app, 👤 edits by co-authors. Changes sync automatically; nothing is locked.
      Kept on this device only.
    </p>
    {#if message}<div class="notice" role="status" data-testid="changes-message">{message}</div>{/if}
    {#if session.changes.length === 0}
      <p class="muted">No changes recorded on this device yet.</p>
    {/if}
    <ul class="sets">
      {#each session.changes as c (c.id)}
        <li class="set" data-testid="change-set" data-source={c.source.kind}>
          <div class="row">
            <button class="ghost head" aria-expanded={open === c.id} onclick={() => (open = open === c.id ? null : c.id)}>
              <span aria-hidden="true">{badge(c)}</span>
              <strong>{c.source.name}</strong>
              <span class="muted">· {c.files.length} file{c.files.length === 1 ? '' : 's'} · {ago(c.endedAt)}</span>
            </button>
            <span class="spacer"></span>
            {#if session.canWrite}
              <button class="small" disabled={busy === c.id} onclick={() => undo(c)} data-testid="undo-change">Undo</button>
            {/if}
          </div>
          {#if open === c.id}
            <ul class="files">
              {#each c.files as f (f.fileId + f.op)}
                <li>
                  <button class="ghost" onclick={() => (openFile = openFile === c.id + f.fileId ? null : c.id + f.fileId)}>
                    <code>{f.path}</code> {opLabel[f.op]}{f.from ? ` (from ${f.from})` : ''}
                    {#if f.added !== undefined}<span class="add">+{f.added}</span> <span class="del">−{f.removed}</span>{/if}
                  </button>
                  {#if openFile === c.id + f.fileId && f.patch}
                    <div class="diff" data-testid="change-diff">
                      {#each patchHunks(f.patch) as hunk, i}
                        {#if i > 0}<div class="sep">…</div>{/if}
                        <pre>{#each hunk as part}<span class={part.op === 1 ? 'ins' : part.op === -1 ? 'rem' : ''}>{part.text}</span>{/each}</pre>
                      {/each}
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
            {#if c.partial?.length}<p class="muted">Partially undone: {c.partial.join(', ')}</p>{/if}
          {/if}
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .changes-card {
    width: min(760px, 100%);
    max-height: 85vh;
    overflow: auto;
  }
  .sets,
  .files {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .set {
    border-top: 1px solid var(--line);
    padding: 6px 0;
  }
  .files {
    padding-left: 22px;
  }
  .head {
    display: flex;
    gap: 6px;
    align-items: center;
    text-align: left;
  }
  .add {
    color: #2a9d55;
  }
  .del {
    color: #c0392b;
  }
  .diff pre {
    white-space: pre-wrap;
    font-size: 12px;
    margin: 4px 0;
    padding: 6px;
    background: var(--panel);
    border-radius: 4px;
    max-height: 320px;
    overflow: auto;
  }
  .ins {
    background: rgba(42, 157, 85, 0.22);
  }
  .rem {
    background: rgba(192, 57, 43, 0.22);
    text-decoration: line-through;
  }
  .sep {
    color: var(--muted, #888);
    font-size: 12px;
  }
</style>
