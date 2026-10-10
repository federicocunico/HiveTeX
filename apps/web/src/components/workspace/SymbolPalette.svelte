<script lang="ts">
  import { onMount } from 'svelte';
  import type { MathSymbol, SymbolCategory } from '../../lib/symbols.js';
  import Dialog from '../../ui/Dialog.svelte';

  /** Search symbols by name ("less or equal") or command ("leq"); click or Enter inserts. */
  let { onInsert, onClose }: { onInsert: (command: string) => void; onClose: () => void } = $props();

  let lib = $state<typeof import('../../lib/symbols.js') | null>(null);
  let q = $state('');
  let category = $state<SymbolCategory | 'All'>('All');

  onMount(async () => {
    lib = await import('../../lib/symbols.js');
  });

  const shown = $derived<MathSymbol[]>(lib ? lib.searchSymbols(q, category === 'All' ? undefined : category) : []);

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && shown[0]) {
      e.preventDefault();
      onInsert(shown[0].command);
    }
  }
</script>

<Dialog title="Insert a symbol" size="lg" {onClose} testid="symbol-palette">
  <input type="search" bind:value={q} placeholder="Search by name or command, e.g. “less or equal” or “leq”" aria-label="Search symbols" onkeydown={onKey} data-autofocus />
  <div class="cats" role="group" aria-label="Category">
    {#each ['All', ...(lib?.SYMBOL_CATEGORIES ?? [])] as c (c)}
      <button type="button" class="cat" aria-pressed={category === c} onclick={() => (category = c as SymbolCategory | 'All')}>{c}</button>
    {/each}
  </div>
  {#if !lib}
    <p class="muted">Loading symbols…</p>
  {:else if shown.length === 0}
    <p class="muted">No symbol matches “{q}”.</p>
  {:else}
    <ul class="grid">
      {#each shown as s (s.category + s.command)}
        <li>
          <button type="button" class="sym" aria-label="{s.name} ({s.command})" data-tip="{s.name}: {s.command}" onclick={() => onInsert(s.command)}>
            <span class="glyph" aria-hidden="true">{s.glyph}</span>
            <code aria-hidden="true">{s.command}</code>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="muted note">Outside math, symbols are wrapped in $…$ for you. Symbols marked amssymb need \usepackage{'{'}amssymb{'}'}.</p>
</Dialog>

<style>
  input[type='search'] {
    width: 100%;
  }
  .cats {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .cat {
    min-height: 26px;
    padding: 0 10px;
    border-radius: 999px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted);
    border-color: var(--line);
  }
  .cat[aria-pressed='true'] {
    background: var(--honey-soft);
    border-color: var(--honey);
    color: var(--honey-ink);
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
    gap: 6px;
    max-height: 46vh;
    overflow: auto;
  }
  .sym {
    width: 100%;
    min-height: 64px;
    display: grid;
    gap: 2px;
    justify-items: center;
    padding: 6px 4px;
    font-weight: 400;
  }
  .glyph {
    font: 22px/1.1 var(--font-display);
  }
  code {
    font-size: 10.5px;
    color: var(--muted);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note {
    margin: 0;
    font-size: var(--text-xs);
  }
</style>
