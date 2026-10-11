<script lang="ts">
  // Resolves the conflicts between this device's offline work and co-authors' changes (offline-mode-git-merge D4).
  import type { FileChoice, HunkDecision, MergeConflict } from '@hivetex/sync';
  import type { ProjectSession } from '../../lib/session.svelte.js';
  import Button from '../../ui/Button.svelte';
  import Dialog from '../../ui/Dialog.svelte';
  import { toast } from '../../ui/toast.svelte.js';

  let { session: s, onClose, initial = null }: { session: ProjectSession; onClose: () => void; initial?: string | null } = $props();

  let selectedId = $state<string | null>(initial);
  const list = $derived(s.conflicts);
  const current = $derived(list.find((c) => c.id === selectedId) ?? list[0] ?? null);
  /** Decisions for the hunks of the current text conflict, by hunk index. */
  let decisions = $state<Array<HunkDecision | undefined>>([]);
  let editing = $state<number | null>(null);
  let editText = $state('');
  let busy = $state(false);

  $effect(() => {
    void current?.id;
    decisions = [];
    editing = null;
  });

  const label = (c: MergeConflict) => {
    if (c.kind === 'text') return c.path;
    const k = c.conflict;
    if (k.type === 'add-add') return k.path;
    if (k.type === 'rename-rename') return `${k.mine} / ${k.theirs}`;
    return k.path;
  };
  const hunks = $derived(current?.kind === 'text' ? current.regions.flatMap((r) => ('conflict' in r ? [r.conflict] : [])) : []);
  const complete = $derived(hunks.length > 0 && hunks.every((_, i) => decisions[i] !== undefined));

  function decide(i: number, d: HunkDecision) {
    const next = [...decisions];
    next[i] = d;
    decisions = next;
    editing = null;
  }

  async function applyText() {
    if (!current || current.kind !== 'text') return;
    busy = true;
    try {
      const r = await s.resolveTextConflict(current.id, decisions);
      if (r === 'conflict-again') toast(`Co-authors changed the same lines of ${current.path} meanwhile: decide again.`, 'error');
      else toast(`${current.path}: merged and shared.`, 'ok');
      decisions = [];
    } finally {
      busy = false;
    }
  }

  async function chooseFile(choice: FileChoice) {
    if (!current || current.kind !== 'file') return;
    busy = true;
    try {
      await s.resolveFileConflict(current.id, choice);
    } finally {
      busy = false;
    }
  }

  const decisionLabel = (d: HunkDecision | undefined) => (d === undefined ? 'Not decided' : d === 'mine' ? 'Keep mine' : d === 'theirs' ? 'Keep theirs' : d === 'both' ? 'Keep both' : 'Edited');
</script>

<Dialog title="Resolve conflicts" {onClose} size="xl" testid="conflict-dialog">
  {#if !current}
    <p data-testid="no-conflicts">No conflicts left. Your offline changes are merged and shared.</p>
  {:else}
    <p class="muted intro">
      You and your co-authors changed the same lines while you were working without each other. Your version stays on this computer until you decide; co-authors keep seeing theirs.
    </p>
    <div class="layout">
      <ul class="files" aria-label="Files with conflicts">
        {#each list as c (c.id)}
          <li><button type="button" class:on={c.id === current.id} onclick={() => (selectedId = c.id)} data-testid="conflict-file">{label(c)}</button></li>
        {/each}
      </ul>
      <section class="detail" aria-label={`Conflict in ${label(current)}`}>
        {#if current.kind === 'text'}
          {#each hunks as h, i (i)}
            <div class="hunk" data-testid="hunk">
              <div class="hunk-head"><strong>Conflict {i + 1} of {hunks.length}</strong> <span class="pill">{decisionLabel(decisions[i])}</span></div>
              <div class="sides">
                <div><h4>Yours (offline)</h4><pre data-testid="hunk-mine">{h.mine || '(removed)'}</pre></div>
                <div><h4>Co-authors'</h4><pre data-testid="hunk-theirs">{h.theirs || '(removed)'}</pre></div>
              </div>
              <details><summary>Before either change</summary><pre>{h.base || '(nothing)'}</pre></details>
              {#if editing === i}
                <label class="edit">Result <textarea rows="6" bind:value={editText} data-testid="hunk-edit"></textarea></label>
                <div class="acts">
                  <Button onclick={() => decide(i, { text: editText.endsWith('\n') || !editText ? editText : `${editText}\n` })}>Use this text</Button>
                  <Button onclick={() => (editing = null)}>Cancel</Button>
                </div>
              {:else}
                <div class="acts">
                  <Button onclick={() => decide(i, 'mine')} data-testid="keep-mine">Keep mine</Button>
                  <Button onclick={() => decide(i, 'theirs')} data-testid="keep-theirs">Keep theirs</Button>
                  <Button onclick={() => decide(i, 'both')} data-testid="keep-both">Keep both</Button>
                  <Button onclick={() => { editing = i; editText = `${h.mine}${h.theirs}`; }} data-testid="edit-hunk">Edit…</Button>
                </div>
              {/if}
            </div>
          {/each}
          <div class="apply">
            <Button variant="primary" disabled={!complete || busy} onclick={() => void applyText()} data-testid="apply-resolution">Apply and share {current.path}</Button>
            {#if !complete}<span class="muted">Decide every conflict in this file first.</span>{/if}
          </div>
        {:else}
          {@const k = current.conflict}
          <div class="hunk">
            {#if k.type === 'delete-modify' && k.deletedBy === 'mine'}
              <p>You deleted <code>{k.path}</code> while co-authors changed it.</p>
              <div class="acts"><Button onclick={() => void chooseFile('keep')} data-testid="file-keep">Keep their version</Button><Button onclick={() => void chooseFile('delete')} data-testid="file-delete">Delete it</Button></div>
            {:else if k.type === 'delete-modify'}
              <p>Co-authors deleted <code>{k.path}</code> while you changed it.</p>
              <div class="acts"><Button onclick={() => void chooseFile('keep')} data-testid="file-keep">Keep my version</Button><Button onclick={() => void chooseFile('delete')} data-testid="file-delete">Leave it deleted</Button></div>
            {:else if k.type === 'rename-rename'}
              <p>You and co-authors renamed the same file differently.</p>
              <div class="acts"><Button onclick={() => void chooseFile('mine')} data-testid="file-mine">Use <code>{k.mine}</code></Button><Button onclick={() => void chooseFile('theirs')} data-testid="file-theirs">Use <code>{k.theirs}</code></Button></div>
            {:else if k.type === 'binary'}
              <p>You and co-authors replaced <code>{k.path}</code> with different files.</p>
              <div class="acts"><Button onclick={() => void chooseFile('mine')} data-testid="file-mine">Keep mine</Button><Button onclick={() => void chooseFile('theirs')} data-testid="file-theirs">Keep theirs</Button></div>
            {:else}
              <p>You and co-authors both created <code>{k.path}</code>.</p>
              <div class="acts">
                <Button onclick={() => void chooseFile('both')} data-testid="file-both">Keep both (mine renamed)</Button>
                <Button onclick={() => void chooseFile('mine')} data-testid="file-mine">Use mine</Button>
                <Button onclick={() => void chooseFile('theirs')} data-testid="file-theirs">Use theirs</Button>
              </div>
            {/if}
          </div>
        {/if}
      </section>
    </div>
  {/if}
  {#snippet footer()}
    <Button onclick={onClose}>Close</Button>
  {/snippet}
</Dialog>

<style>
  .intro {
    margin-top: 0;
  }
  .layout {
    display: grid;
    grid-template-columns: minmax(140px, 220px) 1fr;
    gap: 16px;
    min-height: 0;
  }
  @media (max-width: 720px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
    align-content: start;
  }
  .files button {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    padding: 6px 8px;
    font-family: var(--font-code);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  .files button.on {
    border-color: var(--honey-ink);
    background: var(--honey-soft);
  }
  .detail {
    display: grid;
    gap: 12px;
    min-width: 0;
  }
  .hunk {
    border: 1px solid var(--line);
    border-radius: var(--r-l);
    padding: 10px 12px;
    display: grid;
    gap: 8px;
  }
  .hunk-head {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .sides {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  @media (max-width: 720px) {
    .sides {
      grid-template-columns: 1fr;
    }
  }
  h4 {
    margin: 0 0 4px;
    font-size: var(--text-xs);
    color: var(--muted);
  }
  pre {
    margin: 0;
    padding: 8px;
    max-height: 220px;
    overflow: auto;
    background: var(--sunken, var(--surface));
    border-radius: var(--r-m);
    font-family: var(--font-code);
    font-size: var(--text-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .acts,
  .apply {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .edit {
    display: grid;
    gap: 4px;
  }
  textarea {
    font-family: var(--font-code);
  }
</style>
