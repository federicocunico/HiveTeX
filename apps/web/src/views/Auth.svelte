<script lang="ts">
  import { ApiError, api } from '../lib/api.js';
  import { login, register } from '../lib/auth.svelte.js';
  import { go, route } from '../lib/router.svelte.js';

  let { mode }: { mode: 'login' | 'register' | 'forgot' | 'reset' | 'verify' } = $props();

  let identifier = $state('');
  let username = $state('');
  let email = $state('');
  let password = $state('');
  let confirm = $state('');
  let busy = $state(false);
  let error = $state('');
  let info = $state('');

  const token = $derived(route.query.get('token') ?? '');

  async function run(fn: () => Promise<void>) {
    error = '';
    info = '';
    busy = true;
    try {
      await fn();
    } catch (e) {
      error = e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong';
    } finally {
      busy = false;
    }
  }

  const submit = (e: Event) => {
    e.preventDefault();
    return run(async () => {
      if (mode === 'login') {
        await login(identifier, password);
        go('/');
      } else if (mode === 'register') {
        if (password !== confirm) throw new Error('Passwords do not match');
        await register(username, email, password);
        go('/');
      } else if (mode === 'forgot') {
        const r = await api<{ message: string }>('POST', '/auth/forgot', { email });
        info = r.message;
      } else if (mode === 'reset') {
        if (password !== confirm) throw new Error('Passwords do not match');
        await api('POST', '/auth/reset', { token, password });
        info = 'Password updated. You can sign in now.';
        setTimeout(() => go('/login'), 1200);
      }
    });
  };

  $effect(() => {
    if (mode === 'verify' && token) {
      void run(async () => {
        await api('POST', '/auth/verify-email', { token });
        info = 'Email verified. Thank you!';
      });
    }
  });
</script>

<div class="center">
  <form class="card narrow" onsubmit={submit}>
    <h1>
      {#if mode === 'login'}Sign in{:else if mode === 'register'}Create account{:else if mode === 'forgot'}Reset password{:else if mode === 'reset'}Choose a new password{:else}Verify email{/if}
    </h1>
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    {#if info}<div class="notice" role="status">{info}</div>{/if}

    {#if mode === 'login'}
      <label class="field">Username or email
        <input type="text" bind:value={identifier} autocomplete="username" required />
      </label>
      <label class="field">Password
        <input type="password" bind:value={password} autocomplete="current-password" required />
      </label>
    {:else if mode === 'register'}
      <label class="field">Username <small>3–32 characters: a–z, 0–9, _ or -</small>
        <input type="text" bind:value={username} autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_\-]+" />
      </label>
      <label class="field">Email <small>used for account recovery only</small>
        <input type="email" bind:value={email} autocomplete="email" required />
      </label>
      <label class="field">Password <small>at least 12 characters</small>
        <input type="password" bind:value={password} autocomplete="new-password" required minlength="12" />
      </label>
      <label class="field">Repeat password
        <input type="password" bind:value={confirm} autocomplete="new-password" required />
      </label>
    {:else if mode === 'forgot'}
      <label class="field">Email
        <input type="email" bind:value={email} autocomplete="email" required />
      </label>
    {:else if mode === 'reset'}
      {#if !token}<div class="error">This reset link is incomplete. Request a new one.</div>{/if}
      <label class="field">New password <small>at least 12 characters</small>
        <input type="password" bind:value={password} autocomplete="new-password" required minlength="12" />
      </label>
      <label class="field">Repeat password
        <input type="password" bind:value={confirm} autocomplete="new-password" required />
      </label>
    {:else if busy}
      <p class="muted">Verifying…</p>
    {/if}

    {#if mode !== 'verify'}
      <button class="primary" type="submit" disabled={busy} style="width: 100%">
        {#if mode === 'login'}Sign in{:else if mode === 'register'}Create account{:else if mode === 'forgot'}Send reset link{:else}Update password{/if}
      </button>
    {/if}

    <p class="muted" style="margin-bottom: 0">
      {#if mode === 'login'}
        <a href="#/register">Create an account</a> · <a href="#/forgot">Forgot password?</a>
      {:else}
        <a href="#/login">Back to sign in</a>
      {/if}
    </p>
  </form>
</div>
