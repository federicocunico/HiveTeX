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
  import MenuList from './MenuList.svelte';

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
  <MenuList id={menuId} {label} {items} x={pos.x} y={pos.y} {testid} bind:el={list} onClose={close} />
{/if}
