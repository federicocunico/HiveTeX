<script lang="ts">
  /** The HiveTeX mark (a hive cell holding a LaTeX backslash) with the word mark. */
  let { size = 24, word = true }: { size?: number; word?: boolean } = $props();
</script>

<span class="hx-logo">
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 2.5 20.5 7.3v9.4L12 21.5 3.5 16.7V7.3z" fill="var(--honey-soft)" stroke="var(--honey)" stroke-width="2.2" stroke-linejoin="round" />
    <path d="M9.6 8.4 14.4 15.6" stroke="var(--honey-ink)" stroke-width="2.1" stroke-linecap="round" />
  </svg>
  {#if word}<span class="word">HiveTeX</span>{/if}
</span>

<style>
  .hx-logo {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--ink);
    font-weight: 700;
    font-size: var(--text-lg);
    letter-spacing: -0.01em;
  }
</style>
