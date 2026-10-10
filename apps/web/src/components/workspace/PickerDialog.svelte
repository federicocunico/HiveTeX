<script lang="ts" module>
  export type PickItem = { id: string; primary: string; secondary?: string | undefined; meta?: string | undefined };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { fuzzy } from '../../lib/fuzzy.js';
  import Dialog from '../../ui/Dialog.svelte';

  /** A searchable list to pick one item from (citations, labels, images). Arrow keys move, Enter picks. */
  let {
    title,
    items,
    placeholder,
    empty,
    onPick,
    onClose,
    testid,
  }: {
    title: string;
    items: PickItem[];
    placeholder: string;
    /** Shown when the project has nothing to pick (explain how to add some). */
    empty: Snippet;
    onPick: (item: PickItem) => void;
    onClose: () => void;
    testid?: string;
  } = $props();

  let q = $state('');
  let selected = $state(0);
  const listId = `pick-${Math.random().toString(36).slice(2, 8)}`;

  const shown = $derived.by(() => {
    if (!q.trim()) return items.slice(0, 200);
    return items
      .map((it) => ({ it, m: fuzzy(q, `${it.primary} ${it.secondary ?? ''} ${it.meta ?? ''}`) }))
      .filter((x) => x.m)
      .sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0))
      .map((x) => x.it)
      .slice(0, 200);
  });

  $effect(() => {
    void shown;
    selected = 0;
  });

  function pick(it: PickItem | undefined) {
    if (!it) return;
    onPick(it);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') selected = Math.min(shown.length - 1, selected + 1);
    else if (e.key === 'ArrowUp') selected = Math.max(0, selected - 1);
    else if (e.key === 'Enter') pick(shown[selected]);
    else return;
    e.preventDefault();
    document.getElementById(`${listId}-${selected}`)?.scrollIntoView({ block: 'nearest' });
  }
</script>

<Dialog {title} size="md" {onClose} {testid}>
  <!-- The search box is always there, so focus has a stable home even while the list fills in. -->
  <input
      type="search"
      class="q"
      bind:value={q}
      {placeholder}
      aria-label={placeholder}
      role="combobox"
      aria-expanded="true"
      aria-controls={listId}
      aria-activedescendant={shown[selected] ? `${listId}-${selected}` : undefined}
      onkeydown={onKey}
      data-autofocus
    />
  {#if items.length === 0}
    {@render empty()}
  {:else}
    <ul class="list" id={listId} role="listbox" aria-label={title}>
      {#each shown as it, i (it.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li id="{listId}-{i}" role="option" aria-selected={i === selected} onclick={() => pick(it)} onmousemove={() => (selected = i)}>
          <span class="primary">{it.primary}</span>
          {#if it.secondary}<span class="secondary">{it.secondary}</span>{/if}
          {#if it.meta}<span class="meta">{it.meta}</span>{/if}
        </li>
      {:else}
        <li class="none" role="presentation">Nothing matches “{q}”.</li>
      {/each}
    </ul>
  {/if}
</Dialog>

<style>
  .q {
    width: 100%;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: var(--r-m);
  }
  li[role='option'] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 12px;
    padding: 8px 10px;
    cursor: pointer;
  }
  li[role='option'] + li {
    border-top: 1px solid var(--line);
  }
  li[aria-selected='true'] {
    background: var(--honey-soft);
  }
  .primary {
    font: 500 var(--text-sm) var(--font-code);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    grid-row: 1;
    grid-column: 2;
    color: var(--muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .secondary {
    grid-column: 1 / -1;
    color: var(--muted);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .none {
    padding: 12px;
    color: var(--muted);
  }
</style>
