<script lang="ts" module>
  /** Open dialogs, oldest first: Escape outside every dialog closes only the topmost one. */
  const openDialogs: HTMLElement[] = [];
</script>

<script lang="ts">
  import { onDestroy, onMount, tick, type Snippet } from 'svelte';
  import { focusInitial, trapTab } from './focus.js';
  import { X } from './icons.js';
  import Icon from './Icon.svelte';

  /**
   * Modal dialog: moves focus in on open, keeps Tab inside, closes on Escape (unless `dismissible` is false), and
   * returns focus to whatever had it before. With `onsubmit` the body is a <form> whose <h2> is the title, so
   * `form:has(h2:text("…"))` selectors keep working.
   */
  let {
    title,
    onClose,
    onsubmit,
    dismissible = true,
    size = 'md',
    testid,
    describedby,
    children,
    footer,
    headerExtra,
  }: {
    title: string;
    onClose: () => void;
    onsubmit?: (e: SubmitEvent) => void;
    dismissible?: boolean;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    testid?: string | undefined;
    describedby?: string | undefined;
    children: Snippet;
    footer?: Snippet;
    headerExtra?: Snippet;
  } = $props();

  const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;
  let box: HTMLElement;
  const opener = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

  onMount(() => {
    openDialogs.push(box);
    void tick().then(() => focusInitial(box));
  });

  onDestroy(() => {
    const i = openDialogs.indexOf(box);
    if (i >= 0) openDialogs.splice(i, 1);
    // Return focus where it came from, if that element is still in the page.
    if (opener && opener.isConnected) queueMicrotask(() => opener.focus());
  });

  /**
   * Escape while focus is outside every dialog: a focused button that became disabled during an action (Change ID,
   * Save) drops focus to the page body, and the dialog's own key handler never sees the key. The topmost dialog closes.
   */
  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !dismissible || e.defaultPrevented || openDialogs.at(-1) !== box) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.closest('[role="dialog"]')) return;
    e.preventDefault();
    onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && dismissible) {
      e.stopPropagation();
      e.preventDefault();
      onClose();
      return;
    }
    trapTab(e, box);
  }

  function onScrim(e: MouseEvent) {
    if (dismissible && e.target === e.currentTarget) onClose();
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    onsubmit?.(e);
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="hx-scrim" onclick={onScrim}>
  <div
    class="hx-dialog {size}"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    aria-describedby={describedby}
    data-testid={testid}
    tabindex="-1"
    bind:this={box}
    onkeydown={onKey}
  >
    {#snippet body()}
      <header class="dlg-head">
        <h2 id={titleId}>{title}</h2>
        {@render headerExtra?.()}
        {#if dismissible}
          <button type="button" class="dlg-close" aria-label="Close" data-dialog-close onclick={onClose}><Icon icon={X} /></button>
        {/if}
      </header>
      <div class="dlg-body">{@render children()}</div>
      {#if footer}<footer class="dlg-foot">{@render footer()}</footer>{/if}
    {/snippet}
    {#if onsubmit}
      <form class="dlg-form" onsubmit={submit}>{@render body()}</form>
    {:else}
      {@render body()}
    {/if}
  </div>
</div>

<style>
  .hx-scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--scrim);
  }
  .hx-dialog {
    width: min(var(--dlg-w), 100%);
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: var(--r-xl);
    box-shadow: var(--shadow-2);
    outline: none;
  }
  .hx-dialog.sm { --dlg-w: 420px; }
  .hx-dialog.md { --dlg-w: 560px; }
  .hx-dialog.lg { --dlg-w: 720px; }
  .hx-dialog.xl { --dlg-w: 900px; }
  .dlg-form {
    display: contents;
  }
  .dlg-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--line);
  }
  .dlg-head h2 {
    margin: 0 auto 0 0;
    font-size: var(--text-lg);
    font-weight: 600;
    line-height: 1.3;
  }
  .dlg-close {
    width: 32px;
    min-height: 32px;
    padding: 0;
    border-color: transparent;
    background: transparent;
    color: var(--muted);
  }
  .dlg-body {
    padding: 18px 20px;
    overflow: auto;
    display: grid;
    gap: 16px;
    align-content: start;
  }
  .dlg-foot {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--line);
    background: var(--sunken);
    border-radius: 0 0 var(--r-xl) var(--r-xl);
  }
</style>
