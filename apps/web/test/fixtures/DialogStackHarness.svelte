<script lang="ts">
  import Dialog from '../../src/ui/Dialog.svelte';

  let outer = $state(true);
  let inner = $state(true);
  let { closes = [] }: { closes?: string[] } = $props();
</script>

{#if outer}
  <Dialog title="Project settings" onClose={() => { closes.push('outer'); outer = false; }} testid="outer">
    <button type="button">Change ID</button>
    {#if inner}
      <Dialog title="Confirm" onClose={() => { closes.push('inner'); inner = false; }} testid="inner">
        <button type="button">Yes</button>
      </Dialog>
    {/if}
  </Dialog>
{/if}
