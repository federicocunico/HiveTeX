<script lang="ts" module>
  import type { Component } from 'svelte';

  export type MenuItem =
    | {
        label: string;
        onSelect: () => void;
        icon?: Component<any>;
        hint?: string;
        disabled?: boolean;
        danger?: boolean;
        testid?: string;
      }
    | 'separator';
</script>

<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import Kbd from './Kbd.svelte';

  /**
   * A button that opens a list of actions (WAI-ARIA menu button). Arrow keys move, Enter/Space run, Escape closes
   * and returns focus to the button. The popup is fixed-positioned so scrolling or clipping parents don't cut it.
   */
  let {
    label,
    items,
    trigger,
    triggerClass = '',
    align = 'end',
    testid,
    triggerTestid,
    tip,
  }: {
    label: string;
    items: MenuItem[];
    trigger: Snippet;
    triggerClass?: string;
    align?: 'start' | 'end';
    testid?: string;
    triggerTestid?: string;
    tip?: string;
  } = $props();

  let open = $state(false);
  let btn: HTMLButtonElement;
  let list = $state<HTMLElement>();
  let pos = $state({ x: 0, y: 0 });
  const menuId = `menu-${Math.random().toString(36).slice(2, 9)}`;

  function entries(): HTMLElement[] {
    return list ? [...list.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')] : [];
  }

  async function show(focus: 'first' | 'last' = 'first') {
    const r = btn.getBoundingClientRect();
    open = true;
    await tick();
    const w = list?.offsetWidth ?? 200;
    const h = list?.offsetHeight ?? 0;
    let x = align === 'end' ? r.right - w : r.left;
    x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
    let y = r.bottom + 4;
    if (y + h > window.innerHeight - 4) y = Math.max(4, r.top - h - 4);
    pos = { x, y };
    const els = entries();
    (focus === 'first' ? els[0] : els[els.length - 1])?.focus();
  }

  function close(refocus = true) {
    open = false;
    if (refocus) btn?.focus();
  }

  function onTriggerKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      void show(e.key === 'ArrowDown' ? 'first' : 'last');
    }
  }

  function onListKey(e: KeyboardEvent) {
    const els = entries();
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') els[(i + 1) % els.length]?.focus();
    else if (e.key === 'ArrowUp') els[(i - 1 + els.length) % els.length]?.focus();
    else if (e.key === 'Home') els[0]?.focus();
    else if (e.key === 'End') els[els.length - 1]?.focus();
    else if (e.key === 'Escape') close();
    else if (e.key === 'Tab') close(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function run(item: Exclude<MenuItem, 'separator'>) {
    close();
    item.onSelect();
  }

  function onWindowPointer(e: PointerEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (!list?.contains(t) && !btn.contains(t)) close(false);
  }
</script>

<svelte:window onpointerdown={onWindowPointer} onresize={() => open && close(false)} />

<button
  type="button"
  class="hx-menu-trigger {triggerClass}"
  aria-haspopup="menu"
  aria-expanded={open}
  aria-controls={open ? menuId : undefined}
  aria-label={label}
  data-tip={tip}
  data-testid={triggerTestid}
  bind:this={btn}
  onclick={() => (open ? close() : show())}
  onkeydown={onTriggerKey}
>
  {@render trigger()}
</button>

{#if open}
  <div class="hx-menu" id={menuId} role="menu" aria-label={label} tabindex="-1" data-testid={testid} bind:this={list} style:transform="translate({pos.x}px, {pos.y}px)" onkeydown={onListKey}>
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
{/if}

<style>
  .hx-menu {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 70;
    min-width: 200px;
    max-width: min(360px, calc(100vw - 8px));
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
