<script lang="ts">
  import { onMount } from 'svelte';
  import { Download, X } from '../ui/icons.js';
  import Icon from '../ui/Icon.svelte';
  import { checkForUpdate, dismissUpdate, isDismissed, type UpdateInfo } from '../lib/update-check.js';

  /** Desktop only: announces a newer published release once per start, with a button to its download page. */
  let {
    current,
    check = checkForUpdate,
    open,
  }: {
    current: string;
    check?: (current: string) => Promise<UpdateInfo | null>;
    open: (url: string) => void | Promise<void>;
  } = $props();

  let update = $state<UpdateInfo | null>(null);

  onMount(() => {
    check(current)
      .then((u) => {
        if (u && !isDismissed(u.version)) update = u;
      })
      .catch(() => {});
  });

  function dismiss() {
    if (update) dismissUpdate(update.version);
    update = null;
  }
</script>

{#if update}
  <div class="update" role="status" data-testid="update-badge">
    <span class="msg">Version <strong>{update.version}</strong> is available</span>
    <button type="button" class="dl" data-testid="update-download" onclick={() => update && void open(update.url)}>
      <Icon icon={Download} size={14} />Download
    </button>
    <button type="button" class="x" aria-label="Dismiss update notice" data-tip="Dismiss" onclick={dismiss}>
      <Icon icon={X} size={14} />
    </button>
  </div>
{/if}

<style>
  .update {
    position: fixed;
    right: max(16px, env(safe-area-inset-right, 0px));
    bottom: max(16px, env(safe-area-inset-bottom, 0px));
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: calc(100vw - 32px);
    padding: 8px 8px 8px 14px;
    background: var(--honey-soft);
    color: var(--honey-ink);
    border: 1px solid var(--honey);
    border-radius: var(--r-m);
    box-shadow: var(--shadow-2);
    font-size: var(--text-sm);
  }
  .dl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
  }
  .x {
    display: inline-flex;
    padding: 4px;
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
  }
</style>
