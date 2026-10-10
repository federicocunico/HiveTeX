<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { availableCommands, gotoLineHandler, paletteSources, type PaletteItem } from '../lib/commands.svelte.js';
  import { fuzzy, highlightParts } from '../lib/fuzzy.js';
  import { closePalette, openShortcuts, palette } from '../lib/palette.svelte.js';
  import { trapTab } from '../ui/focus.js';
  import { ArrowLeft, Command as CommandIcon, Search } from '../ui/icons.js';
  import Icon from '../ui/Icon.svelte';
  import Kbd from '../ui/Kbd.svelte';

  /**
   * Ctrl/Cmd+K: run any action, open a file, jump to a heading or a line, or open a project.
   * Prefixes: ">" actions only, "@" headings of the open file, ":" a line number, "?" the shortcut reference.
   */
  type Row = PaletteItem & { group: string; keys?: string[] | undefined; aliases?: string[] | undefined; ranges: Array<[number, number]>; score: number };

  let query = $state(palette.initial);
  let selected = $state(0);
  let input: HTMLInputElement;
  let box: HTMLElement;
  let list = $state<HTMLElement>();
  const opener = document.activeElement as HTMLElement | null;

  onMount(() => {
    void tick().then(() => {
      input?.focus();
      input?.setSelectionRange(query.length, query.length);
    });
  });
  onDestroy(() => {
    if (opener?.isConnected) queueMicrotask(() => opener.focus());
  });

  const mode = $derived(query.startsWith('>') ? 'commands' : query.startsWith('@') ? 'outline' : query.startsWith(':') ? 'line' : query.startsWith('?') ? 'help' : 'all');
  const text = $derived(mode === 'all' ? query : query.slice(1));

  function score(items: Array<Omit<Row, 'ranges' | 'score'>>, q: string, extra: (r: Omit<Row, 'ranges' | 'score'>) => string = () => ''): Row[] {
    const out: Row[] = [];
    for (const it of items) {
      const m = fuzzy(q, it.title);
      const alt = m ? null : fuzzy(q, extra(it));
      if (m) out.push({ ...it, ranges: m.ranges, score: m.score });
      else if (alt) out.push({ ...it, ranges: [], score: alt.score - 50 });
    }
    return q.trim() ? out.sort((a, b) => b.score - a.score) : out;
  }

  const rows = $derived.by((): Row[] => {
    if (mode === 'line') {
      const n = Number.parseInt(text, 10);
      const go = gotoLineHandler();
      if (!go) return [{ id: 'line-none', group: 'Go to line', title: 'Open a file first to go to a line', run: () => {}, ranges: [], score: 0 }];
      return Number.isFinite(n) && n > 0 ? [{ id: `line-${n}`, group: 'Go to line', title: `Go to line ${n}`, run: () => go(n), ranges: [], score: 0 }] : [];
    }
    if (mode === 'help') return [{ id: 'help', group: 'Help', title: 'Show all keyboard shortcuts', icon: CommandIcon, run: openShortcuts, ranges: [], score: 0 }];
    const groups: Row[][] = [];
    if (mode === 'all' || mode === 'commands') {
      const cmds = availableCommands()
        .filter((c) => !c.hidden)
        .map((c) => ({ id: `cmd:${c.id}`, group: 'Actions', title: c.title, icon: c.icon, keys: c.keys, run: c.run, aliases: c.aliases }));
      groups.push(score(cmds, text, (r) => (r.aliases ?? []).join(' ')).slice(0, mode === 'all' ? 8 : 60));
    }
    for (const src of paletteSources()) {
      if (mode === 'commands') continue;
      if (mode === 'outline' && src.id !== 'outline') continue;
      if (mode === 'all' && !text.trim()) continue; // the empty palette shows actions only
      const items = src
        .items()
        .filter((i) => mode !== 'outline' || i.inOpenFile)
        .map((i) => ({ ...i, group: src.label }));
      groups.push(score(items, text, (r) => r.detail ?? '').slice(0, mode === 'outline' ? 60 : 6));
    }
    // The group with the best match comes first, so Enter runs what the query is most likely about.
    const best = (g: Row[]) => g[0]?.score ?? Number.NEGATIVE_INFINITY;
    if (text.trim()) groups.sort((a, b) => best(b) - best(a));
    return groups.flat();
  });

  $effect(() => {
    void rows;
    selected = 0;
  });

  function run(r: Row | undefined) {
    if (!r) return;
    closePalette();
    // Let the palette unmount and give focus back before the action moves it.
    queueMicrotask(() => r.run());
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') selected = Math.min(rows.length - 1, selected + 1);
    else if (e.key === 'ArrowUp') selected = Math.max(0, selected - 1);
    else if (e.key === 'Home' && e.ctrlKey) selected = 0;
    else if (e.key === 'End' && e.ctrlKey) selected = rows.length - 1;
    else if (e.key === 'Enter') run(rows[selected]);
    else if (e.key === 'Escape') closePalette();
    else if (e.key === 'Tab') {
      trapTab(e, box);
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
    void tick().then(() => list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  }

  const groups = $derived.by(() => {
    const g: Array<{ label: string; rows: Array<Row & { index: number }> }> = [];
    rows.forEach((r, index) => {
      const last = g[g.length - 1];
      if (last && last.label === r.group) last.rows.push({ ...r, index });
      else g.push({ label: r.group, rows: [{ ...r, index }] });
    });
    return g;
  });

  const PLACEHOLDER = 'Search actions, files and projects';
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={(e) => e.target === e.currentTarget && closePalette()}>
  <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" data-testid="palette" bind:this={box} onkeydown={onKey}>
    <div class="in">
      <Icon icon={mode === 'line' ? ArrowLeft : Search} size={18} />
      <input
        bind:this={input}
        bind:value={query}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={rows[selected] ? `pal-${selected}` : undefined}
        aria-autocomplete="list"
        aria-label="Command palette"
        placeholder={PLACEHOLDER}
        autocomplete="off"
        spellcheck="false"
        data-testid="palette-input"
      />
      <kbd class="kbd">Esc</kbd>
    </div>
    <ul class="list" id="palette-list" role="listbox" aria-label="Results" bind:this={list}>
      {#each groups as g (g.label)}
        <li class="group" role="presentation">{g.label}</li>
        {#each g.rows as r (r.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id="pal-{r.index}"
            class="item"
            role="option"
            aria-selected={r.index === selected}
            onclick={() => run(r)}
            onmousemove={() => (selected = r.index)}
          >
            {#if r.icon}<Icon icon={r.icon} />{:else}<span class="noicon"></span>{/if}
            <span class="title">{#each highlightParts(r.title, r.ranges) as part, i (i)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
            {#if r.detail}<span class="detail">{r.detail}</span>{/if}
            {#if r.keys?.[0]}<Kbd keys={r.keys[0]} />{/if}
          </li>
        {/each}
      {:else}
        <li class="empty" role="presentation">{mode === 'line' ? 'Type a line number' : 'Nothing matches'}</li>
      {/each}
    </ul>
    <div class="foot" aria-hidden="true">
      <span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> Move</span>
      <span><kbd class="kbd">Enter</kbd> Run</span>
      <span><kbd class="kbd">&gt;</kbd> Actions</span>
      <span><kbd class="kbd">@</kbd> Headings</span>
      <span><kbd class="kbd">:</kbd> Line</span>
      <span><kbd class="kbd">?</kbd> Shortcuts</span>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 75;
    display: grid;
    justify-items: center;
    align-items: start;
    padding: 12vh 16px 16px;
    background: var(--scrim);
  }
  .palette {
    width: min(640px, 100%);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--raised);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-2);
    overflow: hidden;
  }
  .in {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border-bottom: 1px solid var(--line);
    color: var(--muted);
  }
  .in input {
    flex: 1;
    min-height: 52px;
    border: 0;
    padding: 0;
    background: transparent;
    font-size: var(--text-lg);
    color: var(--ink);
  }
  .in input:focus-visible {
    outline: none;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow: auto;
  }
  .group {
    padding: 8px 10px 4px;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    padding: 0 10px;
    border-radius: var(--r-m);
    cursor: pointer;
  }
  .item[aria-selected='true'] {
    background: var(--honey-soft);
  }
  .item :global(svg) {
    color: var(--muted);
  }
  .noicon {
    width: 16px;
    flex: none;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  mark {
    background: none;
    color: var(--honey-ink);
    font-weight: 600;
  }
  .detail {
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: var(--text-xs);
    font-family: var(--font-code);
  }
  .empty {
    padding: 16px 10px;
    color: var(--muted);
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    padding: 8px 14px;
    border-top: 1px solid var(--line);
    font-size: var(--text-xs);
    color: var(--muted);
  }
  .foot span {
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
</style>
