<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { auth } from '../lib/auth.svelte.js';
  import { route } from '../lib/router.svelte.js';

  let status = $state<'working' | 'ok' | 'error'>('working');
  let message = $state('');

  onMount(async () => {
    if (route.path === '/github-done') {
      status = route.query.get('ok') === '1' ? 'ok' : 'error';
      if (status === 'error') message = 'GitHub did not complete the authorization.';
      return;
    }
    const code = route.query.get('code') ?? '';
    const state = route.query.get('state') ?? '';
    // The authorization code must not linger in the address bar or history.
    history.replaceState(null, '', `${location.pathname}#/github-done`);
    try {
      const r = await api<{ login: string }>('POST', '/github/complete', { code, state });
      status = 'ok';
      message = `GitHub account @${r.login} is now linked to ${auth.user?.username ?? 'your account'}.`;
    } catch (e) {
      status = 'error';
      message = e instanceof Error ? e.message : 'Could not link GitHub';
    }
  });
</script>

<div class="page" data-testid="github-continue">
  <h1>GitHub</h1>
  {#if status === 'working'}
    <p class="muted">Linking your GitHub account…</p>
  {:else if status === 'ok'}
    <div class="notice" role="status" data-testid="github-continue-ok">{message || 'GitHub linked.'}</div>
    <p class="muted">You can close this window and go back to HiveTeX (web or desktop): the backup settings update automatically.</p>
  {:else}
    <div class="error" role="alert" data-testid="github-continue-error">{message}</div>
    <p class="muted">Nothing was linked. Start again from <em>Project settings → GitHub</em>, signed in with your own account.</p>
  {/if}
</div>
