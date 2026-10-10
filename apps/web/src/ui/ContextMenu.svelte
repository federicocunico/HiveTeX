<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { MenuItem } from './Menu.svelte';
  import MenuList from './MenuList.svelte';

  /**
   * A context menu (right-click, the ContextMenu key or Shift+F10) at `x`, `y`, kept inside the window. The first item
   * is focused; Escape or running an item gives focus back to `returnFocus` (what was right-clicked).
   */
  let {
    label,
    items,
    x,
    y,
    returnFocus,
    testid,
    onClose,
  }: {
    label: string;
    items: MenuItem[];
    x: number;
    y: number;
    returnFocus?: HTMLElement | null;
    testid?: string;
    onClose: () => void;
  } = $props();

  let list = $state<HTMLElement>();
  let pos = $state({ x: -9999, y: -9999 });
  const menuId = `ctx-${Math.random().toString(36).slice(2, 9)}`;

  onMount(async () => {
    await tick();
    const w = list?.offsetWidth ?? 200;
    const h = list?.offsetHeight ?? 0;
    pos = {
      x: Math.max(4, Math.min(x, window.innerWidth - w - 4)),
      y: y + h > window.innerHeight - 4 ? Math.max(4, y - h) : y,
    };
    list?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  });

  function close(refocus: boolean) {
    // read the props first: closing clears the parent's state they come from
    const back = returnFocus;
    onClose();
    if (refocus) back?.focus();
  }

  function onWindowPointer(e: PointerEvent) {
    if (!(e.target as Element | null)?.closest?.(`#${menuId}`)) close(false);
  }
</script>

<svelte:window onpointerdown={onWindowPointer} onresize={() => close(false)} onblur={() => close(false)} />

<MenuList id={menuId} {label} {items} x={pos.x} y={pos.y} {testid} bind:el={list} onClose={close} />
