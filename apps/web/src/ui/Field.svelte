<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * A labeled form field. The label is always visible. `hint` sits under the control; `error` replaces the hint and
   * is announced. The control snippet receives the ids to wire up: `<input id={f.id} aria-describedby={f.describedBy}
   * aria-invalid={f.invalid}>`.
   */
  let {
    id,
    label,
    hint,
    error,
    ok = false,
    children,
  }: {
    id: string;
    label: string;
    hint?: Snippet | string;
    error?: string;
    ok?: boolean;
    children: Snippet<[{ id: string; describedBy: string | undefined; invalid: boolean }]>;
  } = $props();

  const hintId = `${id}-hint`;
  const errId = `${id}-error`;
  const describedBy = $derived(error ? errId : hint ? hintId : undefined);
</script>

<div class="hx-field">
  <label for={id}>{label}</label>
  {@render children({ id, describedBy, invalid: !!error })}
  {#if error}
    <p class="msg err" id={errId} role="alert">{error}</p>
  {:else if hint}
    <p class="msg" class:ok id={hintId}>{#if typeof hint === 'string'}{hint}{:else}{@render hint()}{/if}</p>
  {/if}
</div>

<style>
  .hx-field {
    display: grid;
    gap: 6px;
  }
  label {
    font-weight: 500;
    font-size: var(--text-sm);
  }
  .msg {
    margin: 0;
    font-size: 12.5px;
    color: var(--muted);
  }
  .msg.ok {
    color: var(--ok);
  }
  .msg.err {
    color: var(--bad);
  }
</style>
