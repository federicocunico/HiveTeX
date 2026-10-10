<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  /** A small status label. Tone carries meaning together with the text, never instead of it. */
  let {
    tone = 'neutral',
    dot = false,
    children,
    class: cls = '',
    ...rest
  }: HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'honey' | 'ok' | 'warn' | 'bad'; dot?: boolean; children: Snippet } = $props();
</script>

<span class="pill {tone} {cls}" {...rest}>{#if dot}<span class="dot" aria-hidden="true"></span>{/if}{@render children()}</span>

<style>
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  }
</style>
