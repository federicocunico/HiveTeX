<script lang="ts">
  /**
   * A draggable, keyboard-operable divider (WAI-ARIA window splitter). The parent owns the size: the splitter reports
   * pointer deltas and arrow-key steps through `onresize(delta)` and shows `value` within `min`…`max`.
   */
  let {
    label,
    value,
    min = 0,
    max = 100,
    step = 24,
    orientation = 'vertical',
    onresize,
    ondblclick,
    testid,
  }: {
    label: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
    /** `vertical` separates left and right panes (it is a vertical bar). */
    orientation?: 'vertical' | 'horizontal';
    onresize: (delta: number) => void;
    ondblclick?: () => void;
    testid?: string;
  } = $props();

  let dragging = $state(false);
  let last = 0;

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    last = orientation === 'vertical' ? e.clientX : e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function move(e: PointerEvent) {
    if (!dragging) return;
    const now = orientation === 'vertical' ? e.clientX : e.clientY;
    const d = now - last;
    if (d) {
      last = now;
      onresize(d);
    }
  }

  function up(e: PointerEvent) {
    dragging = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  function key(e: KeyboardEvent) {
    const back = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back) onresize(-step);
    else if (e.key === fwd) onresize(step);
    else if (e.key === 'Home') onresize(min - value);
    else if (e.key === 'End') onresize(max - value);
    else return;
    e.preventDefault();
  }
</script>

<div
  class="hx-splitter {orientation}"
  class:dragging
  role="separator"
  aria-orientation={orientation}
  aria-label={label}
  aria-valuenow={Math.round(value)}
  aria-valuemin={Math.round(min)}
  aria-valuemax={Math.round(max)}
  tabindex="0"
  data-testid={testid}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onkeydown={key}
  {ondblclick}
></div>

<style>
  .hx-splitter {
    position: relative;
    flex: none;
    background: var(--line);
    touch-action: none;
    z-index: 2;
  }
  .hx-splitter.vertical {
    width: 1px;
    cursor: col-resize;
  }
  .hx-splitter.horizontal {
    height: 1px;
    cursor: row-resize;
  }
  /* A wider invisible hit area around the 1px line. */
  .hx-splitter::before {
    content: '';
    position: absolute;
    inset: 0 -4px;
  }
  .hx-splitter.horizontal::before {
    inset: -4px 0;
  }
  .hx-splitter:hover,
  .hx-splitter.dragging,
  .hx-splitter:focus-visible {
    background: var(--honey);
  }
  .hx-splitter:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--honey-ink);
  }
</style>
