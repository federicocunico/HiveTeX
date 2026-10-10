<script lang="ts">
  import { api, apiBase, isDesktop, safeStorage, setServerUrl } from '../lib/api.js';
  import { auth, logoutAll } from '../lib/auth.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import { texliveEndpoint } from '../lib/wasm-engine.js';

  let current = $state('');
  let next = $state('');
  let error = $state('');
  let info = $state('');
  let serverUrl = $state(apiBase());
  let texUrl = $state(texliveEndpoint());

  async function resendVerification() {
    error = info = '';
    try {
      const r = await api<{ alreadyVerified?: boolean }>('POST', '/auth/resend-verification', {});
      info = r.alreadyVerified ? 'Your email is already verified.' : `A new verification link was sent to ${auth.user?.email}.`;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed';
    }
  }

  async function change(e: Event) {
    e.preventDefault();
    error = info = '';
    try {
      await api('POST', '/auth/change-password', { current, password: next });
      info = 'Password changed. Other devices were signed out.';
      current = next = '';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed';
    }
  }

  async function signOutEverywhere() {
    await logoutAll();
    go('/login');
  }

  let updateMsg = $state('');
  async function checkUpdates() {
    updateMsg = 'Checking…';
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const u = await check();
      if (!u) return void (updateMsg = 'You are up to date.');
      updateMsg = `Version ${u.version} is available. Downloading…`;
      await u.downloadAndInstall();
      updateMsg = 'Update installed. Restart p2platex to use it.';
    } catch (e) {
      updateMsg = e instanceof Error ? e.message : 'Could not check for updates';
    }
  }

  function saveConnection(e: Event) {
    e.preventDefault();
    error = info = '';
    try {
      if (isDesktop) {
        setServerUrl(serverUrl);
      }
      if (texUrl.trim()) {
        const t = new URL(texUrl.trim());
        if (t.protocol !== 'https:' && t.hostname !== 'localhost') throw new Error('The TeX server URL must use https://');
        safeStorage('texliveUrl', t.href.endsWith('/') ? t.href : `${t.href}/`);
        sessionStorage.removeItem('p2platex.texserver');
      } else safeStorage('texliveUrl', null);
      info = 'Saved. Reload the app for the new settings to take effect.';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Invalid URL';
    }
  }
</script>

<div class="page">
  <h1>Account</h1>
  {#if auth.user}
    <p><strong>{auth.user.username}</strong> · {auth.user.email} {#if !auth.user.emailVerified}<span class="pill warn">email not verified — recovery needs a verified email</span> <button class="small" onclick={resendVerification} data-testid="resend-verification">Send a new verification link</button>{/if}</p>
  {/if}
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  {#if info}<div class="notice" role="status">{info}</div>{/if}
  <form class="card" onsubmit={change} style="max-width: 420px">
    <h2>Change password</h2>
    <label class="field">Current password <input type="password" bind:value={current} autocomplete="current-password" required /></label>
    <label class="field">New password <small>at least 12 characters</small> <input type="password" bind:value={next} autocomplete="new-password" required minlength="12" /></label>
    <button class="primary" type="submit">Change password</button>
  </form>

  <form class="card" onsubmit={saveConnection} style="max-width: 420px; margin-top: 16px">
    <h2>Connections</h2>
    {#if isDesktop}
      <label class="field">p2platex server <small>the hosted control plane (accounts, project lookup, connection setup)</small>
        <input type="text" bind:value={serverUrl} placeholder="https://your-app.vercel.app" />
      </label>
    {/if}
    <label class="field">TeX package server <small>used by the in-browser compiler only; leave empty for the default</small>
      <input type="text" bind:value={texUrl} placeholder="https://texlive.example.org/" />
    </label>
    <button type="submit">Save</button>
  </form>

  {#if isDesktop}
    <p style="margin-top: 16px"><button onclick={checkUpdates} data-testid="check-updates">Check for updates</button> <span class="muted" role="status">{updateMsg}</span></p>
  {/if}

  <p style="margin-top: 24px"><button class="danger" onclick={signOutEverywhere}>Sign out of all devices</button></p>
</div>
