<script lang="ts" module>
  export type Person = { name: string; tip?: string; label?: string; ring?: boolean; onclick?: () => void };
</script>

<script lang="ts">
  import Avatar from './Avatar.svelte';

  /** Overlapping avatars; shows `max` and a "+N" for the rest. `label` names the group for screen readers. */
  let { people, max = 4, size = 26, label }: { people: Person[]; max?: number; size?: number; label: string } = $props();

  const shown = $derived(people.slice(0, max));
  const rest = $derived(people.length - shown.length);
</script>

<div class="hx-avstack" role="group" aria-label={label}>
  {#each shown as p (p.name)}
    <Avatar name={p.name} {size} ring={p.ring} tip={p.tip} label={p.label} onclick={p.onclick} />
  {/each}
  {#if rest > 0}<span class="more" style:--sz="{size}px" data-tip={people.slice(max).map((p) => p.name).join(', ')}>+{rest}</span>{/if}
</div>

<style>
  .hx-avstack {
    display: inline-flex;
    align-items: center;
    padding-left: 6px;
  }
  .hx-avstack > :global(*) {
    margin-left: -6px;
  }
  .more {
    width: var(--sz);
    height: var(--sz);
    display: inline-grid;
    place-items: center;
    border-radius: 50%;
    background: var(--sunken);
    color: var(--muted);
    font: 600 11px/1 var(--font-ui);
    box-shadow: 0 0 0 2px var(--surface);
  }
</style>
