<script lang="ts">
  import Dialog from '../../ui/Dialog.svelte';

  /** Pick a table size: hover the grid or type the numbers. */
  let { onInsert, onClose }: { onInsert: (rows: number, cols: number) => void; onClose: () => void } = $props();

  let rows = $state(3);
  let cols = $state(3);
  const MAX_R = 8;
  const MAX_C = 8;
</script>

<Dialog title="Insert a table" size="sm" {onClose} onsubmit={() => onInsert(rows, cols)} testid="table-dialog">
  <div class="grid" aria-hidden="true" style:--c={MAX_C}>
    {#each Array.from({ length: MAX_R * MAX_C }, (_, i) => i) as i (i)}
      {@const r = Math.floor(i / MAX_C) + 1}
      {@const c = (i % MAX_C) + 1}
      <button type="button" tabindex="-1" class="cell" class:on={r <= rows && c <= cols} onmouseenter={() => ((rows = r), (cols = c))} onclick={() => onInsert(r, c)} aria-label="{r} by {c}"></button>
    {/each}
  </div>
  <div class="nums">
    <label>Rows <input type="number" min="1" max="50" bind:value={rows} data-autofocus /></label>
    <span aria-hidden="true">×</span>
    <label>Columns <input type="number" min="1" max="20" bind:value={cols} /></label>
  </div>
  {#snippet footer()}
    <button type="button" onclick={onClose}>Cancel</button>
    <button type="submit" class="primary">Insert {rows} × {cols} table</button>
  {/snippet}
</Dialog>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(var(--c), 22px);
    gap: 3px;
    justify-content: center;
  }
  .cell {
    width: 22px;
    min-height: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--line-strong);
    border-radius: 3px;
    background: var(--surface);
  }
  .cell.on {
    background: var(--honey-soft);
    border-color: var(--honey);
  }
  .nums {
    display: flex;
    align-items: end;
    justify-content: center;
    gap: 10px;
  }
  .nums label {
    display: grid;
    gap: 4px;
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .nums input {
    width: 80px;
  }
</style>
