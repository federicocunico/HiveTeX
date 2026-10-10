<script lang="ts">
  import { allCommands, type CommandGroup } from '../lib/commands.svelte.js';
  import { closeShortcuts } from '../lib/palette.svelte.js';
  import Dialog from '../ui/Dialog.svelte';
  import Kbd from '../ui/Kbd.svelte';

  /** Every shortcut, grouped by area: the registry's commands plus the editor's own text-editing keys. */
  const ORDER: Array<CommandGroup | 'Editor'> = ['Compile', 'View', 'Navigate', 'Insert', 'Files', 'Project', 'Account', 'Help', 'Editor'];

  const EDITOR_KEYS: Array<{ title: string; keys: string[] }> = [
    { title: 'Toggle comment', keys: ['Mod+/'] },
    { title: 'Find in file', keys: ['Mod+F'] },
    { title: 'Find next', keys: ['Mod+G'] },
    { title: 'Select next occurrence', keys: ['Mod+D'] },
    { title: 'Undo', keys: ['Mod+Z'] },
    { title: 'Redo', keys: ['Mod+Shift+Z'] },
    { title: 'Indent or accept completion', keys: ['Tab'] },
    { title: 'Show completions', keys: ['Ctrl+Space'] },
  ];

  const groups = $derived.by(() => {
    const map = new Map<string, Array<{ title: string; keys: string[] }>>();
    for (const c of allCommands()) {
      if (!c.keys?.length) continue;
      const list = map.get(c.group) ?? [];
      if (!list.some((x) => x.title === c.title)) list.push({ title: c.title, keys: c.keys });
      map.set(c.group, list);
    }
    map.set('Editor', EDITOR_KEYS);
    return ORDER.filter((g) => map.has(g)).map((g) => ({ label: g, items: map.get(g) ?? [] }));
  });
</script>

<Dialog title="Keyboard shortcuts" size="lg" onClose={closeShortcuts} testid="shortcuts-dialog">
  <p class="muted intro">Mod means Ctrl, or Cmd on a Mac. Every action is also in the command palette (<Kbd keys="Mod+K" />).</p>
  <div class="cols">
    {#each groups as g (g.label)}
      <section>
        <h3>{g.label}</h3>
        <dl>
          {#each g.items as it (it.title)}
            <div class="row">
              <dt>{it.title}</dt>
              <dd>{#each it.keys as k, i (k)}{#if i > 0}<span class="or">or</span>{/if}<Kbd keys={k} />{/each}</dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}
  </div>
</Dialog>

<style>
  .intro {
    margin: 0;
  }
  .cols {
    columns: 2 280px;
    column-gap: 32px;
  }
  section {
    break-inside: avoid;
    margin-bottom: 18px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  dl {
    margin: 0;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 0;
    border-bottom: 1px solid var(--line);
  }
  dt {
    font-size: var(--text-sm);
  }
  dd {
    margin: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }
  .or {
    font-size: var(--text-xs);
    color: var(--muted);
  }
</style>
