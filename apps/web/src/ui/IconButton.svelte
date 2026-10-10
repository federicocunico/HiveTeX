<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';

  /** An icon-only button. `label` is required: it is the accessible name and the tooltip text. */
  let {
    icon,
    label,
    tip = label,
    tipSide,
    size = 32,
    active = false,
    badge,
    children,
    class: cls = '',
    type = 'button',
    ...rest
  }: HTMLButtonAttributes & {
    icon: Component<any>;
    label: string;
    tip?: string | undefined;
    tipSide?: 'bottom' | 'right' | 'top' | undefined;
    size?: number | undefined;
    active?: boolean | undefined;
    badge?: string | number | undefined;
    children?: Snippet | undefined;
  } = $props();
</script>

<button
  {type}
  class="hx-iconbtn {cls}"
  class:active
  aria-label={label}
  data-tip={tip}
  data-tip-side={tipSide}
  style:--ib-size="{size}px"
  {...rest}
>
  <Icon {icon} size={size >= 36 ? 19 : 16} />
  {#if badge !== undefined && badge !== '' && badge !== 0}<span class="badge" aria-hidden="true">{badge}</span>{/if}
  {@render children?.()}
</button>

<style>
  .hx-iconbtn {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: var(--ib-size);
    height: var(--ib-size);
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: var(--r-m);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .hx-iconbtn:hover:not(:disabled) {
    background: var(--sunken);
    color: var(--ink);
  }
  .hx-iconbtn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .hx-iconbtn.active {
    color: var(--ink);
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  .badge {
    position: absolute;
    top: 2px;
    right: 1px;
    min-width: 15px;
    height: 15px;
    padding: 0 3px;
    border-radius: 8px;
    background: var(--honey);
    color: var(--on-honey);
    font: 600 10px/15px var(--font-ui);
    text-align: center;
  }
</style>
