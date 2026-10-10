<script lang="ts">
  // Desktop only: the HiveTeX web app asks to compile on this computer (local compile helper). The user decides here.
  import { onMount } from 'svelte';
  import { isDesktop } from '../lib/api.js';
  import Button from '../ui/Button.svelte';
  import Dialog from '../ui/Dialog.svelte';

  interface Request {
    id: string;
    username: string;
    server: string;
    origin: string;
  }

  let queue = $state<Request[]>([]);
  const current = $derived(queue[0]);

  onMount(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    let gone = false;
    void import('@tauri-apps/api/event').then((ev) =>
      ev.listen<Request>('helper://pair-request', (e) => (queue = [...queue, e.payload])).then((u) => {
        if (gone) u();
        else unlisten = u;
      }),
    );
    return () => {
      gone = true;
      unlisten?.();
    };
  });

  async function answer(allow: boolean) {
    const req = current;
    if (!req) return;
    queue = queue.slice(1);
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('helper_answer', { id: req.id, allow });
  }
</script>

{#if current}
  {#key current.id}
    <!-- Not dismissible: the request waits for an explicit Allow or Deny. -->
    <Dialog title="Compile for the web app?" onClose={() => answer(false)} dismissible={false} size="sm" testid="pair-request">
      <p>
        The HiveTeX web app (<strong>{current.username}</strong> on <code>{current.server}</code>, page
        <code>{current.origin}</code>) asks to compile its projects on this computer.
      </p>
      <p class="muted">
        Allow it only if you just chose <em>Compile with my desktop app</em> in your browser. You can revoke it any time in
        Account → Compiler.
      </p>
      {#snippet footer()}
        <Button onclick={() => answer(false)}>Deny</Button>
        <Button variant="primary" onclick={() => answer(true)}>Allow</Button>
      {/snippet}
    </Dialog>
  {/key}
{/if}
