<script lang="ts">
  import type { OutlineEntry } from '../../lib/outline.js';
  import PanelHead from './PanelHead.svelte';

  /** Headings of the whole document in reading order; the one holding the cursor is marked. Click to jump. */
  let {
    entries,
    current,
    onGo,
  }: { entries: OutlineEntry[]; current: OutlineEntry | null; onGo: (file: string, line: number) => void } = $props();

  const minLevel = $derived(entries.length ? Math.min(...entries.map((e) => e.level)) : 0);
</script>

<section class="panel" aria-labelledby="outline-title" data-testid="outline-panel">
  <PanelHead title="Outline" id="outline-title" />
  {#if entries.length === 0}
    <p class="intro">No headings yet. Add <code>\section{'{'}…{'}'}</code> to the main document and its sections appear here.</p>
  {:else}
    <ol class="entries">
      {#each entries as e, i (i)}
        <li>
          <button
            type="button"
            class="entry"
            class:cur={current === e}
            aria-current={current === e ? 'location' : undefined}
            style:padding-left="{10 + (e.level - minLevel) * 14}px"
            data-tip="{e.file}, line {e.line}"
            onclick={() => onGo(e.file, e.line)}
          >
            {#if e.number}<span class="num">{e.number}</span>{/if}
            <span class="title">{e.title}</span>
          </button>
        </li>
      {/each}
    </ol>
  {/if}
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
  .entries {
    list-style: none;
    margin: 0;
    padding: 0 6px 8px;
  }
  .entry {
    width: 100%;
    min-height: 28px;
    justify-content: flex-start;
    gap: 8px;
    padding-right: 8px;
    border: 0;
    border-radius: var(--r-s);
    background: none;
    color: var(--muted);
    font-weight: 400;
    font-size: 13px;
    text-align: left;
  }
  .entry:hover {
    background: var(--sunken);
    color: var(--ink);
  }
  .entry.cur {
    background: var(--honey-soft);
    color: var(--ink);
    font-weight: 500;
  }
  .num {
    flex: none;
    font-variant-numeric: tabular-nums;
    color: var(--faint);
    font-size: 12px;
  }
  .entry.cur .num {
    color: var(--honey-ink);
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
