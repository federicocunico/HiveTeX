<script lang="ts">
  import { CircleAlert, CircleCheck, Info, X } from './icons.js';
  import Icon from './Icon.svelte';
  import { dismissToast, toasts } from './toast.svelte.js';

  const icons = { ok: CircleCheck, error: CircleAlert, info: Info };
</script>

<!-- Each toast is its own polite status message. -->
<div class="hx-toaster">
  {#each toasts as t (t.id)}
    <div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
      <Icon icon={icons[t.kind]} />
      <span>{t.text}</span>
      <button type="button" aria-label="Dismiss" onclick={() => dismissToast(t.id)}><Icon icon={X} size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .hx-toaster {
    position: fixed;
    right: 16px;
    bottom: calc(40px + env(safe-area-inset-bottom, 0px));
    z-index: 80;
    display: grid;
    gap: 8px;
    justify-items: end;
    pointer-events: none;
  }
  /* With a dialog open, toasts move to the top so they never cover its buttons (they sit in the dialog's footer). */
  :global(body:has(.hx-scrim)) .hx-toaster {
    top: calc(12px + env(safe-area-inset-top, 0px));
    bottom: auto;
    right: 50%;
    transform: translateX(50%);
    justify-items: center;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(420px, calc(100vw - 32px));
    padding: 10px 8px 10px 14px;
    background: var(--raised);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: var(--r-l);
    box-shadow: var(--shadow-2);
  }
  .toast.ok :global(svg:first-child) {
    color: var(--ok);
  }
  .toast.error :global(svg:first-child) {
    color: var(--bad);
  }
  .toast button {
    min-height: 24px;
    width: 24px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
  }
</style>
