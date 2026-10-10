<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { TOUR_STEPS, type TourStep, markTourDone } from '../../lib/tour.js';

  /**
   * A short guided tour: a card next to each part of the workspace with a highlight ring. Skippable at any step;
   * finishing or skipping marks it done on this device. Escape skips. Not modal: the page stays usable.
   */
  let { onEnd }: { onEnd: () => void } = $props();

  const steps: TourStep[] = TOUR_STEPS.filter((s) => document.querySelector(s.target));
  let i = $state(0);
  let ring = $state({ x: 0, y: 0, w: 0, h: 0 });
  let card = $state({ x: 0, y: 0 });
  let box = $state<HTMLElement>();
  const step = $derived(steps[i]);

  async function place() {
    const el = step && document.querySelector<HTMLElement>(step.target);
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    ring = { x: r.left - 4, y: r.top - 4, w: r.width + 8, h: r.height + 8 };
    await tick();
    const cw = box.offsetWidth;
    const ch = box.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Prefer to the right of the target, then below, then above; always inside the window.
    let x = r.right + 14;
    let y = r.top;
    if (x + cw > vw - 8) {
      x = Math.min(Math.max(8, r.left), vw - cw - 8);
      y = r.bottom + 14;
      if (y + ch > vh - 8) y = Math.max(8, r.top - ch - 14);
    }
    // Large targets (the editor): sit inside their top-left corner.
    if (r.width > vw * 0.4 && r.height > vh * 0.4) {
      x = Math.min(r.left + 24, vw - cw - 8);
      y = Math.min(r.top + 56, vh - ch - 8);
    }
    card = { x: Math.max(8, x), y: Math.max(8, Math.min(y, vh - ch - 8)) };
  }

  function end() {
    markTourDone();
    onEnd();
  }

  function go(n: number) {
    if (n >= steps.length) return end();
    i = Math.max(0, n);
    void place().then(() => box?.querySelector<HTMLElement>('[data-primary]')?.focus());
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      end();
    }
  }

  onMount(() => {
    if (!steps.length) return end();
    void place().then(() => box?.querySelector<HTMLElement>('[data-primary]')?.focus());
    window.addEventListener('resize', place);
  });
  onDestroy(() => window.removeEventListener('resize', place));
</script>

{#if step}
  <div class="ring" aria-hidden="true" style:transform="translate({ring.x}px, {ring.y}px)" style:width="{ring.w}px" style:height="{ring.h}px"></div>
  <div
    class="tour"
    role="dialog"
    aria-modal="false"
    aria-labelledby="tour-title"
    aria-describedby="tour-text"
    tabindex="-1"
    data-testid="tour"
    bind:this={box}
    onkeydown={onKey}
    style:transform="translate({card.x}px, {card.y}px)"
  >
    <p class="count">Step {i + 1} of {steps.length}</p>
    <h2 id="tour-title">{step.title}</h2>
    <p id="tour-text">{step.text}</p>
    <div class="row">
      <button type="button" class="link" onclick={end}>Skip tour</button>
      <span class="sp"></span>
      {#if i > 0}<button type="button" class="small" onclick={() => go(i - 1)}>Back</button>{/if}
      <button type="button" class="small primary" data-primary onclick={() => go(i + 1)}>{i === steps.length - 1 ? 'Done' : 'Next'}</button>
    </div>
  </div>
{/if}

<style>
  .ring {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 55;
    border: 2px solid var(--honey);
    border-radius: var(--r-l);
    box-shadow: 0 0 0 4px var(--honey-soft);
    pointer-events: none;
    transition: transform 0.2s ease, width 0.2s ease, height 0.2s ease;
  }
  .tour {
    position: fixed;
    top: 0;
    left: 0;
    z-index: 56;
    width: min(340px, calc(100vw - 16px));
    display: grid;
    gap: 8px;
    padding: 16px 18px;
    background: var(--raised);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: var(--r-l);
    box-shadow: var(--shadow-2);
    outline: none;
  }
  .count {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--honey-ink);
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
  }
  #tour-text {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-sm);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .sp {
    flex: 1;
  }
  .link {
    min-height: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font-size: var(--text-sm);
    font-weight: 400;
    text-decoration: underline;
  }
</style>
