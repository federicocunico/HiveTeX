<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';

  let {
    variant = 'secondary',
    size = 'md',
    icon,
    children,
    type = 'button',
    class: cls = '',
    ...rest
  }: HTMLButtonAttributes & {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    icon?: Component<any>;
    children?: Snippet;
  } = $props();
</script>

<button {type} class="hx-btn {variant} {size} {cls}" {...rest}>
  {#if icon}<Icon {icon} size={size === 'lg' ? 18 : 16} />{/if}
  {@render children?.()}
</button>

<style>
  .hx-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: var(--control-h);
    padding: 0 12px;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-m);
    background: var(--surface);
    color: var(--ink);
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }
  .hx-btn:hover:not(:disabled) {
    background: var(--sunken);
  }
  .hx-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .primary {
    background: var(--honey);
    border-color: var(--honey);
    color: var(--on-honey);
    font-weight: 600;
  }
  .primary:hover:not(:disabled) {
    background: var(--honey-hover);
  }
  .ghost {
    background: transparent;
    border-color: transparent;
  }
  .danger {
    color: var(--bad);
    border-color: var(--bad);
  }
  .danger:hover:not(:disabled) {
    background: var(--bad-soft);
  }
  .sm {
    min-height: 28px;
    padding: 0 10px;
    font-size: var(--text-sm);
  }
  .lg {
    min-height: 44px;
    padding: 0 20px;
    font-size: var(--text-lg);
    border-radius: var(--r-l);
  }
</style>
