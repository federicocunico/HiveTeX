<script lang="ts">
  // Desktop only: the HiveTeX web app asks to compile on this computer (local compile helper). The user decides here.
  import { onMount } from 'svelte';
  import { isDesktop } from '../lib/api.js';

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
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="pair-title" data-testid="pair-request">
    <div class="card">
      <h2 id="pair-title">Compile for the web app?</h2>
      <p>
        The HiveTeX web app (<strong>{current.username}</strong> on <code>{current.server}</code>, page
        <code>{current.origin}</code>) asks to compile its projects on this computer.
      </p>
      <p class="muted">
        Allow it only if you just chose <em>Compile with my desktop app</em> in your browser. You can revoke it any time in
        Account → Compiler.
      </p>
      <div class="row" style="justify-content: flex-end; gap: 8px">
        <button onclick={() => answer(false)}>Deny</button>
        <button class="primary" onclick={() => answer(true)}>Allow</button>
      </div>
    </div>
  </div>
{/if}
