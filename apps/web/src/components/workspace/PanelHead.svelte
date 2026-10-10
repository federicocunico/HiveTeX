<script lang="ts">
  import type { Snippet } from 'svelte';

  /** Title row of a side panel, with optional actions on the right. */
  let { title, id, children }: { title: string; id?: string; children?: Snippet } = $props();
</script>

<div class="panel-head">
  <h2 {id}>{title}</h2>
  {@render children?.()}
</div>

<style>
  .panel-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 40px;
    padding: 0 6px 0 14px;
  }
  h2 {
    margin: 0 auto 0 0;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
</style>
