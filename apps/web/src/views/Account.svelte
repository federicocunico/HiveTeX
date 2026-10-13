<script lang="ts">
  import { api, apiBase, defaultServer, isDesktop, parseServerUrl, safeStorage, serverLabel, setServerUrl, useDefaultServer } from '../lib/api.js';
  import { auth, logoutAll } from '../lib/auth.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import { texliveEndpoint } from '../lib/wasm-engine.js';
  import CompilerPanel from '../components/CompilerPanel.svelte';
  import { COMPILE_MODES, COMPILE_MODE_KEY, type CompileMode, readCompileMode } from '../lib/compile-mode.js';
  import { resetLayout } from '../lib/layout.svelte.js';
  import { FONT_MAX, FONT_MIN, type Keymap, prefs, setPref } from '../lib/preferences.svelte.js';
  import { Monitor, Moon, Sun } from '../ui/icons.js';
  import Icon from '../ui/Icon.svelte';

  let compileMode = $state<CompileMode>(readCompileMode());
  function saveCompileMode(mode: CompileMode) {
    compileMode = mode;
    safeStorage(COMPILE_MODE_KEY, mode);
  }

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
      updateMsg = 'Update installed. Restarting HiveTeX…';
      // A durable quit first (one seed, one network identity), then the new version starts.
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('app_restart');
    } catch (e) {
      updateMsg = e instanceof Error ? e.message : 'Could not check for updates';
    }
  }

  async function saveConnection(e: Event) {
    e.preventDefault();
    error = info = '';
    try {
      // Only an actual change becomes a custom server; the default stays the default (and follows future builds).
      if (isDesktop && serverUrl.trim() && parseServerUrl(serverUrl) !== apiBase()) {
        const {stopRuntimes}=await import('../lib/runtimes.js');
        await stopRuntimes();
        setServerUrl(serverUrl);
      }
      if (texUrl.trim()) {
        const t = new URL(texUrl.trim());
        if (t.protocol !== 'https:' && t.hostname !== 'localhost') throw new Error('The TeX server URL must use https://');
        safeStorage('texliveUrl', t.href.endsWith('/') ? t.href : `${t.href}/`);
        sessionStorage.removeItem('hivetex.texserver');
      } else safeStorage('texliveUrl', null);
      info = 'Saved. Reload the app for the new settings to take effect.';
    } catch (err) {
      error = err instanceof Error ? err.message : 'Invalid URL';
    }
  }
</script>

<div class="page account">
  <h1>Account and preferences</h1>
  {#if auth.user}
    <p><strong>{auth.user.username}</strong> · {auth.user.email} {#if !auth.user.emailVerified}<span class="pill warn">email not verified — recovery needs a verified email</span> <button class="small" onclick={resendVerification} data-testid="resend-verification">Send a new verification link</button>{/if}</p>
  {/if}
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  {#if info}<div class="notice" role="status">{info}</div>{/if}
  <p class="card" data-testid="network-link">Can't connect to a co-author? <button type="button" class="linkish" onclick={() => go('/network')}>Network diagnostics</button></p>

  <section class="card" data-testid="preferences" aria-labelledby="prefs-title">
    <h2 id="prefs-title">Preferences</h2>
    <p class="muted" style="margin-top: 0">For this device only. They are never sent to the server or to co-authors.</p>
    <fieldset class="seg-field">
      <legend>Theme</legend>
      <div class="seg">
        {#each [['system', 'System', Monitor], ['light', 'Light', Sun], ['dark', 'Dark', Moon]] as const as [value, label, icon] (value)}
          <label class:on={prefs.theme === value}>
            <input type="radio" name="theme" {value} checked={prefs.theme === value} onchange={() => setPref('theme', value)} />
            <Icon {icon} size={14} />{label}
          </label>
        {/each}
      </div>
    </fieldset>
    <label class="field">Editor text size <small>{prefs.editorFontSize} px</small>
      <input type="range" min={FONT_MIN} max={FONT_MAX} value={prefs.editorFontSize} oninput={(e) => setPref('editorFontSize', Number(e.currentTarget.value))} data-testid="pref-font-size" />
    </label>
    <label class="row"><input type="checkbox" checked={prefs.toolbar} onchange={(e) => setPref('toolbar', e.currentTarget.checked)} data-testid="pref-toolbar" /> Show the formatting toolbar above the editor</label>
    <label class="field">Editor keys
      <select value={prefs.keymap} onchange={(e) => setPref('keymap', e.currentTarget.value as Keymap)} data-testid="pref-keymap">
        <option value="default">Default</option>
        <option value="vim">Vim</option>
        <option value="emacs">Emacs</option>
      </select>
    </label>
    <div><button type="button" onclick={() => (resetLayout(), (info = 'Layout reset: panels and pane sizes are back to their defaults.'))}>Reset workspace layout</button></div>
  </section>

  <form class="card" onsubmit={change}>
    <h2>Change password</h2>
    <label class="field">Current password <input type="password" bind:value={current} autocomplete="current-password" required /></label>
    <label class="field">New password <small>at least 12 characters</small> <input type="password" bind:value={next} autocomplete="new-password" required minlength="12" /></label>
    <button class="primary" type="submit">Change password</button>
  </form>

  <div class="card" data-testid="compiler-settings">
    <h2>Compiler</h2>
    <p class="muted" style="margin-top: 0">How this device takes part in building PDFs, for every project.</p>
    {#each COMPILE_MODES as m (m.id)}
      <label class="row" style="align-items: flex-start; gap: 8px; margin-bottom: 6px">
        <input type="radio" name="compile-mode" value={m.id} checked={compileMode === m.id} onchange={() => saveCompileMode(m.id)} />
        <span><strong>{m.label}</strong><br /><small class="muted">{m.hint}</small></span>
      </label>
    {/each}
    <CompilerPanel />
  </div>

  <form class="card" onsubmit={saveConnection}>
    <h2>Connections</h2>
    {#if isDesktop}
      <label class="field">HiveTeX server <small>accounts, project lookup and connection setup; your documents never go there</small>
        <input type="text" bind:value={serverUrl} placeholder={serverLabel(defaultServer())} data-testid="account-server" />
      </label>
      {#if safeStorage('serverUrl')}
        <p class="muted" style="margin-top: -6px"><button type="button" class="small" onclick={async () => { const {stopRuntimes}=await import('../lib/runtimes.js'); await stopRuntimes(); useDefaultServer(); location.reload(); }} data-testid="account-server-default">Use the default server ({serverLabel(defaultServer())})</button></p>
      {/if}
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

<style>
  .account {
    width: min(760px, 100%);
    padding: 32px clamp(16px, 4vw, 40px) 48px;
    display: grid;
    gap: 16px;
    align-content: start;
  }
  h1 {
    margin: 0;
    font-size: var(--text-2xl);
  }
  .account :global(.card) {
    display: grid;
    gap: 10px;
    padding: 18px 20px;
  }
  .account :global(.card h2) {
    margin: 0;
    font-size: var(--text-lg);
  }
  .account :global(.field) {
    margin: 0;
  }
  .seg-field {
    margin: 0;
    padding: 0;
    border: 0;
    display: grid;
    gap: 6px;
  }
  .seg-field legend {
    padding: 0;
    margin-bottom: 4px;
    font-weight: 500;
  }
  .seg {
    display: inline-flex;
    width: fit-content;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-m);
    overflow: hidden;
  }
  .seg label {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: var(--text-sm);
    cursor: pointer;
    color: var(--muted);
  }
  .seg label + label {
    border-left: 1px solid var(--line);
  }
  .seg label.on {
    background: var(--honey-soft);
    color: var(--ink);
    font-weight: 500;
  }
  .seg label:focus-within {
    outline: 2px solid var(--honey-ink);
    outline-offset: -2px;
  }
  .seg input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  input[type='range'] {
    width: min(320px, 100%);
    accent-color: var(--honey-ink);
  }
  select {
    width: auto;
  }
</style>
