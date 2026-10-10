<script lang="ts">
  import { keyLabel, keyParts } from './keys.js';

  let { keys }: { keys: string } = $props();
</script>

<span class="kbds">
  <span class="sr-only">{keyLabel(keys)}</span>
  {#each keyParts(keys) as k, i (i)}<kbd class="kbd" aria-hidden="true">{k}</kbd>{/each}
</span>

<style>
  .kbds {
    display: inline-flex;
    gap: 3px;
    align-items: center;
  }
</style>
