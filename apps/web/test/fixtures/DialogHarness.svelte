<script lang="ts">
  import Dialog from '../../src/ui/Dialog.svelte';

  let open = $state(false);
</script>

<button type="button" onclick={() => (open = true)}>Open</button>
{#if open}
  <Dialog title="Share project" onClose={() => (open = false)} testid="dlg">
    <label for="f1">First</label><input id="f1" />
    <button type="button">Middle</button>
    {#snippet footer()}<button type="button">Done</button>{/snippet}
  </Dialog>
{/if}
