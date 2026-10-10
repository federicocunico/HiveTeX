<script lang="ts">
  import { onMount } from 'svelte';
  import { type Match, replaceProject, searchProject } from '../../lib/search.js';
  import type { ProjectSession } from '../../lib/session.svelte.js';
  import { toast } from '../../ui/toast.svelte.js';
  import PanelHead from './PanelHead.svelte';

  /** Search (and, for editors, replace) across every text file of the project. */
  let { session, onOpen }: { session: ProjectSession; onOpen: (fileId: string, line: number) => void } = $props();

  let query = $state('');
  let replacement = $state('');
  let matches = $state<Match[]>([]);
  let opts = $state({ caseSensitive: false, regex: false, wholeWord: false });
  let input: HTMLInputElement;

  onMount(() => input?.focus());

  async function run() {
    if (!query) {
      matches = [];
      return;
    }
    await session.mesh.prefetchAll();
    matches = await searchProject(session.model, query, opts);
  }

  async function replaceAll() {
    if (!query) return;
    const n = await replaceProject(session.model, query, replacement, opts);
    toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'}`);
    await run();
  }

  const files = $derived(new Set(matches.map((m) => m.path)).size);
</script>

<section class="panel" aria-labelledby="search-title" data-testid="search-panel">
  <PanelHead title="Search" id="search-title" />
  <div class="form">
    <input bind:this={input} type="search" placeholder="Search project" bind:value={query} oninput={run} aria-label="Search project" />
    {#if session.canWrite}<input type="text" placeholder="Replace with" bind:value={replacement} aria-label="Replacement" />{/if}
    <div class="opts">
      <label data-tip="Match case"><input type="checkbox" bind:checked={opts.caseSensitive} onchange={run} /> Aa</label>
      <label data-tip="Whole words only"><input type="checkbox" bind:checked={opts.wholeWord} onchange={run} /> Word</label>
      <label data-tip="Regular expression"><input type="checkbox" bind:checked={opts.regex} onchange={run} /> .*</label>
      {#if session.canWrite}<button type="button" class="small" onclick={replaceAll} disabled={!matches.length}>Replace all ({matches.length})</button>{/if}
    </div>
  </div>
  {#if query}
    <p class="count" aria-live="polite">{matches.length} result{matches.length === 1 ? '' : 's'}{matches.length ? ` in ${files} file${files === 1 ? '' : 's'}` : ''}</p>
  {/if}
  <ul class="hits">
    {#each matches.slice(0, 200) as m, i (i)}
      <li><button type="button" class="hit" onclick={() => onOpen(m.fileId, m.line)}><span class="where">{m.path}:{m.line}</span><span class="preview">{m.preview}</span></button></li>
    {/each}
  </ul>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .form {
    display: grid;
    gap: 6px;
    padding: 0 10px 8px;
  }
  .form input[type='search'],
  .form input[type='text'] {
    min-height: 32px;
    width: 100%;
  }
  .opts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    align-items: center;
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .opts label {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .opts button {
    margin-left: auto;
  }
  .count {
    margin: 0 14px 4px;
    color: var(--muted);
    font-size: var(--text-xs);
  }
  .hits {
    list-style: none;
    margin: 0;
    padding: 0 6px 8px;
    overflow: auto;
  }
  .hit {
    display: grid;
    justify-items: start;
    width: 100%;
    min-height: 0;
    padding: 4px 8px;
    border: 0;
    border-radius: var(--r-s);
    background: none;
    font-weight: 400;
    text-align: left;
    white-space: normal;
  }
  .hit:hover {
    background: var(--sunken);
  }
  .where {
    font: 500 12px var(--font-code);
    color: var(--honey-ink);
  }
  .preview {
    font-size: 12.5px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
</style>
