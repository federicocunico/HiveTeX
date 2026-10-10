<script lang="ts">
  import type { Diagnostic } from '@hivetex/compile';
  import type { Snippet } from 'svelte';
  import { ChevronDown, ChevronUp, CircleAlert, Info, TriangleAlert } from '../../ui/icons.js';
  import Icon from '../../ui/Icon.svelte';
  import IconButton from '../../ui/IconButton.svelte';

  /**
   * Compile errors and warnings under the editor: where they are, the original message, and (from the help table)
   * what it means and how to fix it. The raw log is one click away.
   */
  let {
    diagnostics,
    failed = false,
    log = '',
    compileError = '',
    note = '',
    expanded,
    onToggle,
    onGo,
    help,
  }: {
    diagnostics: Diagnostic[];
    /** The last compile failed. */
    failed?: boolean;
    log?: string;
    compileError?: string;
    /** Why this device cannot compile (no TeX, …). */
    note?: string;
    expanded: boolean;
    onToggle: () => void;
    onGo: (file: string, line: number) => void;
    /** Plain-language explanation and fixes for one diagnostic. */
    help?: Snippet<[Diagnostic]>;
  } = $props();

  let showLog = $state(false);
  const errors = $derived(diagnostics.filter((d) => d.severity === 'error').length);
  const warnings = $derived(diagnostics.filter((d) => d.severity === 'warning').length);
  const visible = $derived(diagnostics.length > 0 || failed || !!compileError || !!note);
  const sevIcon = { error: CircleAlert, warning: TriangleAlert, info: Info } as const;
</script>

{#if visible}
  <section class="problems" aria-label="Problems" data-testid="diagnostics">
    <div class="head">
      <button type="button" class="title" aria-expanded={expanded} onclick={onToggle}>
        <strong>Problems</strong>
        {#if errors}<span class="pill bad">{errors} error{errors === 1 ? '' : 's'}</span>{/if}
        {#if warnings}<span class="pill warn">{warnings} warning{warnings === 1 ? '' : 's'}</span>{/if}
        {#if !errors && !warnings && !failed && !compileError}<span class="pill ok">No problems</span>{/if}
      </button>
      {#if log}<button type="button" class="link" aria-pressed={showLog} onclick={() => (showLog = !showLog)}>{showLog ? 'Hide raw log' : 'Raw log'}</button>{/if}
      <IconButton icon={expanded ? ChevronDown : ChevronUp} size={26} label={expanded ? 'Collapse problems' : 'Expand problems'} onclick={onToggle} />
    </div>
    {#if expanded}
      <div class="body">
        {#if compileError}<div class="error msg" role="alert">{compileError}</div>{/if}
        {#if note}<div class="notice msg">{note}</div>{/if}
        {#if failed && diagnostics.length === 0}
          <div class="error msg">The compile failed without a message that points to a line. Open the raw log for details.</div>
        {/if}
        <ul>
          {#each diagnostics as d, i (i)}
            <li class={d.severity}>
              <Icon icon={sevIcon[d.severity] ?? Info} class="sev" />
              <div class="text">
                <div class="what">{d.message}</div>
                {#if d.file || d.line}<div class="where">{d.file || 'main document'}{d.line ? `, line ${d.line}` : ''}</div>{/if}
                {@render help?.(d)}
              </div>
              {#if d.line}<button type="button" class="small" onclick={() => onGo(d.file, d.line)}>Go to line</button>{/if}
            </li>
          {/each}
        </ul>
        {#if showLog}<pre class="log">{log.slice(-6000)}</pre>{/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .problems {
    flex: none;
    border-top: 1px solid var(--line);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    max-height: 40%;
    min-height: 0;
  }
  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 0 6px 0 4px;
  }
  .title {
    flex: 1;
    min-height: 0;
    justify-content: flex-start;
    gap: 8px;
    padding: 2px 8px;
    border: 0;
    background: none;
    font-size: var(--text-sm);
  }
  .link {
    min-height: 0;
    padding: 2px 6px;
    border: 0;
    background: none;
    color: var(--honey-ink);
    font-size: var(--text-xs);
  }
  .body {
    overflow: auto;
    padding: 0 0 8px;
  }
  .msg {
    margin: 4px 12px;
    padding: 6px 10px;
    font-size: var(--text-sm);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
    padding: 8px 12px;
    border-top: 1px solid var(--line);
  }
  li :global(.sev) {
    margin-top: 2px;
  }
  li.error :global(.sev) {
    color: var(--bad);
  }
  li.warning :global(.sev) {
    color: var(--warn);
  }
  li.info :global(.sev) {
    color: var(--muted);
  }
  .what {
    font-weight: 500;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  .where {
    color: var(--muted);
    font-size: var(--text-xs);
    font-family: var(--font-code);
  }
  .log {
    margin: 6px 12px 0;
    padding: 8px;
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    font-size: 11.5px;
    background: var(--sunken);
    border-radius: var(--r-s);
  }
</style>
