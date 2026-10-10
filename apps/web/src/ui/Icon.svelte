<script lang="ts">
  import type { Component } from 'svelte';

  // Decorative by default: the control that holds the icon carries the accessible name.
  let { icon, size = 16, class: cls = '' }: { icon: Component<any>; size?: number; class?: string } = $props();
  const Glyph = $derived(icon);
</script>

<Glyph {size} strokeWidth={1.75} aria-hidden="true" focusable="false" class="icon {cls}" />

<style>
  :global(svg.icon) {
    flex: none;
    vertical-align: middle;
  }
</style>
