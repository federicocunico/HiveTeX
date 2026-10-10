<script lang="ts">
  import { initials, presenceSlot, presenceVar } from '../lib/presence.js';

  /** A person's initials in their presence color. A button when `onclick` is given, otherwise decorative. */
  let {
    name,
    size = 26,
    ring = false,
    tip,
    label,
    onclick,
  }: {
    name: string;
    size?: number | undefined;
    ring?: boolean | undefined;
    tip?: string | undefined;
    label?: string | undefined;
    onclick?: (() => void) | undefined;
  } = $props();

  const color = $derived(presenceVar(presenceSlot(name)));
</script>

{#if onclick}
  <button type="button" class="hx-avatar" class:ring style:--av={color} style:--sz="{size}px" aria-label={label ?? name} data-tip={tip ?? name} {onclick}>{initials(name)}</button>
{:else}
  <span class="hx-avatar" class:ring style:--av={color} style:--sz="{size}px" data-tip={tip} aria-hidden="true">{initials(name)}</span>
{/if}

<style>
  .hx-avatar {
    width: var(--sz);
    height: var(--sz);
    min-height: 0;
    padding: 0;
    flex: none;
    display: inline-grid;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: var(--av);
    color: var(--on-presence);
    font: 600 calc(var(--sz) * 0.42) / 1 var(--font-ui);
    letter-spacing: 0.02em;
    box-shadow: 0 0 0 2px var(--surface);
    cursor: default;
  }
  button.hx-avatar {
    cursor: pointer;
  }
  button.hx-avatar:hover {
    background: var(--av);
    filter: brightness(1.08);
  }
  .ring {
    box-shadow:
      0 0 0 2px var(--surface),
      0 0 0 4px var(--av);
  }
</style>
