<script lang="ts">
  import Icon from './Icon.svelte';
  import Kbd from './Kbd.svelte';
  import type { MenuItem } from './Menu.svelte';

  /**
   * The popup list shared by Menu (a menu button) and ContextMenu (right-click): WAI-ARIA menu items, arrow keys move,
   * Home/End jump, Enter/Space run, Escape closes (refocusing what opened it), Tab closes and moves on.
   * Fixed-positioned at `x`, `y` so scrolling or clipping parents don't cut it.
   */
  let {
    id,
    label,
    items,
    x,
    y,
    testid,
    onClose,
    el = $bindable(),
  }: {
    id: string;
    label: string;
    items: MenuItem[];
    x: number;
    y: number;
    testid?: string | undefined;
    /** `refocus`: give focus back to what opened the menu (false when focus is moving elsewhere anyway). */
    onClose: (refocus: boolean) => void;
    el?: HTMLElement | undefined;
  } = $props();

  export function entries(): HTMLElement[] {
    return el ? [...el.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')] : [];
  }

  function onKey(e: KeyboardEvent) {
    const els = entries();
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') els[(i + 1) % els.length]?.focus();
    else if (e.key === 'ArrowUp') els[(i - 1 + els.length) % els.length]?.focus();
    else if (e.key === 'Home') els[0]?.focus();
    else if (e.key === 'End') els[els.length - 1]?.focus();
    else if (e.key === 'Escape') onClose(true);
    else if (e.key === 'Tab') onClose(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function run(item: Exclude<MenuItem, 'separator'>) {
    onClose(true);
    item.onSelect();
  }
</script>

<div class="hx-menu" {id} role="menu" aria-label={label} tabindex="-1" data-testid={testid} bind:this={el} style:transform="translate({x}px, {y}px)" onkeydown={onKey}>
  {#each items as item, i (i)}
    {#if item === 'separator'}
      <div class="sep" role="separator"></div>
    {:else}
      <button type="button" role="menuitem" tabindex="-1" class:danger={item.danger} disabled={item.disabled} data-testid={item.testid} onclick={() => run(item)}>
        {#if item.icon}<Icon icon={item.icon} />{:else}<span class="noicon"></span>{/if}
        <span class="lbl">{item.label}</span>
        {#if item.hint}<Kbd keys={item.hint} />{/if}
      </button>
    {/if}
  {/each}
</div>

<style>
  .hx-menu {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 70;
    min-width: 200px;
    max-width: min(360px, calc(100vw - 8px));
    max-height: calc(100dvh - 8px);
    overflow-y: auto;
    padding: 4px;
    display: grid;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: var(--r-l);
    box-shadow: var(--shadow-2);
    outline: none;
  }
  .hx-menu [role='menuitem'] {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
    min-height: 32px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--r-m);
    background: transparent;
    color: var(--ink);
    font-weight: 400;
    text-align: left;
  }
  .hx-menu [role='menuitem']:hover:not(:disabled),
  .hx-menu [role='menuitem']:focus-visible {
    background: var(--honey-soft);
    outline: none;
  }
  .hx-menu [role='menuitem'].danger {
    color: var(--bad);
  }
  .hx-menu [role='menuitem'] :global(svg) {
    color: var(--muted);
  }
  .lbl {
    flex: 1;
  }
  .noicon {
    width: 16px;
  }
  .sep {
    height: 1px;
    margin: 4px 6px;
    background: var(--line);
  }
</style>
