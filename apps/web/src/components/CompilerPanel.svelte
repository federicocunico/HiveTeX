<script lang="ts">
  // Account → Compiler: what compiles on this device, and the downloads behind it (design D7).
  import { onMount } from 'svelte';
  import { apiBase, isDesktop } from '../lib/api.js';
  import { auth } from '../lib/auth.svelte.js';
  import { compilerLabel } from '../lib/compile-mode.js';
  import { type CompilerHealth, healthMessage, setSystemTexAside } from '../lib/compiler-health.js';
  import { PAIR_MESSAGES, forgetHelper, helperToken, pairWithDesktop } from '../lib/helper-engine.js';
  import { clearTexCache } from '../lib/wasm-engine.js';

  type Installed = { version: string; bytes: number } | null;
  interface ManagedStatus {
    tectonic: Installed;
    tinytex: Installed;
    tectonic_cache_bytes: number;
    tectonic_download: number | null;
    tinytex_download: number | null;
  }
  interface HelperInfo {
    running: boolean;
    port: number | null;
    enabled: boolean;
    pairings: { id: string; username: string; server: string; created: number }[];
  }

  const mb = (n: number) => `${Math.max(1, Math.round(n / 1048576))} MB`;

  let compiler = $state<string | null>(null);
  let managed = $state<ManagedStatus | null>(null);
  let texFiles = $state<{ files: number; bytes: number } | null>(null);
  let helper = $state<HelperInfo | null>(null);
  let busy = $state('');
  let progress = $state('');
  let message = $state('');
  let paired = $state(!!helperToken());
  let health = $state<CompilerHealth | null>(null);

  async function tauri() {
    const [core, ev] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
    return { invoke: core.invoke, listen: ev.listen };
  }

  /** The web app served by a self-hosted server may also use the helper (the default one always may). */
  function extraOrigins(): string[] {
    const o = new URL(apiBase()).origin;
    return o === 'https://hivetex.vercel.app' ? [] : [o];
  }

  async function refresh() {
    if (!isDesktop) return;
    const { invoke } = await tauri();
    const info = await invoke<{ flavor: string } | null>('tex_detect');
    compiler = info ? compilerLabel(info.flavor) : null;
    managed = await invoke<ManagedStatus>('managed_status');
    texFiles = await invoke<{ files: number; bytes: number }>('texcache_stats');
    helper = await invoke<HelperInfo>('helper_info');
    health = await invoke<CompilerHealth | null>('compiler_health').catch(() => null);
  }

  /** Compiles a minimal document now and repairs the compiler if it fails (as at every start). */
  async function checkNow(useSystemTex = false) {
    const { invoke } = await tauri();
    busy = 'check';
    message = 'Checking the compiler (a repair may download it again)…';
    try {
      health = await invoke<CompilerHealth>(useSystemTex ? 'compiler_use_system_tex' : 'compiler_health_check');
      message = healthMessage(health) ?? 'No LaTeX on this computer yet.';
    } catch (e) {
      message = `Could not check the compiler: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      busy = '';
      await refresh();
    }
  }

  onMount(() => {
    void refresh().catch((e) => (message = String(e)));
  });

  async function install(component: 'tectonic' | 'tinytex') {
    const { invoke, listen } = await tauri();
    busy = component;
    message = '';
    const un = await listen<{ component: string; received: number; total: number }>('managed://progress', (e) => {
      if (e.payload.component === component) progress = e.payload.total ? `${mb(e.payload.received)} / ${mb(e.payload.total)}` : mb(e.payload.received);
    });
    try {
      await invoke('managed_install', { component });
      message = component === 'tinytex' ? 'Full LaTeX is installed. Projects opened from now on use it.' : 'The quick compiler is ready.';
    } catch (e) {
      message = `Could not install: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      un();
      busy = progress = '';
      await refresh();
    }
  }

  async function remove(component: 'tectonic' | 'tinytex') {
    const { invoke } = await tauri();
    busy = component;
    try {
      await invoke('managed_remove', { component });
    } catch (e) {
      message = String(e);
    }
    busy = '';
    await refresh();
  }

  async function clearFiles() {
    busy = 'cache';
    message = '';
    try {
      if (isDesktop) {
        await clearTexCache(true);
        message = 'Compiler caches cleared. Documents and installed compilers are kept; packages are downloaded again when needed.';
      } else {
        await clearTexCache();
        message = 'Downloaded TeX files removed; they are fetched again when needed.';
      }
    } catch (e) {
      message = `Could not clear compiler caches: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      busy = '';
      await refresh();
    }
  }

  async function setHelper(enabled: boolean) {
    const { invoke } = await tauri();
    helper = await invoke<HelperInfo>('helper_configure', { enabled, origins: extraOrigins() });
  }

  async function revoke(id: string) {
    const { invoke } = await tauri();
    helper = await invoke<HelperInfo>('helper_revoke', { id });
  }

  async function pair() {
    if (!auth.user) return;
    busy = 'pair';
    message = 'Confirm in the HiveTeX desktop app…';
    const r = await pairWithDesktop(auth.user.username);
    busy = '';
    paired = r === 'paired';
    message = r === 'paired' ? 'Paired: projects you open in this browser compile with the desktop app while it runs.' : PAIR_MESSAGES[r];
  }

  function unpair() {
    forgetHelper();
    paired = false;
    message = 'This browser no longer uses the desktop app.';
  }
</script>

<div data-testid="compiler-panel" style="margin-top: 12px">
  {#if isDesktop}
    <p data-testid="current-compiler"><strong>On this computer:</strong> {compiler ?? 'no LaTeX yet (the quick compiler is set up at the first compile)'}</p>
    <div class="row wrap" style="gap: 8px; margin-bottom: 8px" data-testid="compiler-health">
      <small class={health && health.state !== 'ok' && health.state !== 'none' ? 'notice' : 'muted'}>
        {healthMessage(health) ?? 'The compiler is checked at every start.'}{health ? ` (${new Date(health.at).toLocaleString()})` : ''}
      </small>
      <button class="small" disabled={!!busy} onclick={() => checkNow()} data-testid="compiler-check">Check now</button>
      {#if setSystemTexAside(health)}
        <button class="small" disabled={!!busy} onclick={() => checkNow(true)} data-testid="use-system-tex">Use system TeX again</button>
      {/if}
    </div>
    {#if managed}
      <div class="row wrap" style="gap: 8px; margin-bottom: 8px">
        {#if managed.tectonic}
          <span>Quick compiler {managed.tectonic.version} · {mb(managed.tectonic.bytes + managed.tectonic_cache_bytes)}</span>
          <button class="small" disabled={!!busy} onclick={() => remove('tectonic')} data-testid="remove-tectonic">Remove</button>
        {:else if managed.tectonic_download}
          <button class="small" disabled={!!busy} onclick={() => install('tectonic')} data-testid="install-tectonic">Download the quick compiler ({mb(managed.tectonic_download)})</button>
        {/if}
      </div>
      <div class="row wrap" style="gap: 8px; margin-bottom: 8px">
        {#if managed.tinytex}
          <span>Full LaTeX (TinyTeX {managed.tinytex.version}) · {mb(managed.tinytex.bytes)}</span>
          <button class="small" disabled={!!busy} onclick={() => remove('tinytex')} data-testid="remove-tinytex">Remove</button>
        {:else if managed.tinytex_download}
          <button class="small" disabled={!!busy} onclick={() => install('tinytex')} data-testid="install-tinytex" title="TeX Live with pdfLaTeX, XeLaTeX and LuaLaTeX; missing packages are installed as documents need them.">Install full LaTeX ({mb(managed.tinytex_download)} download)</button>
        {/if}
      </div>
      {#if busy && progress}<p class="muted" role="status">Downloading {progress}…</p>{/if}
    {/if}
    <p class="row" style="gap: 8px">
      <button class="small" disabled={!!busy} onclick={clearFiles} data-testid="clear-compiler-cache">Clear compiler caches</button>
      <small class="muted">Build files and downloaded packages. Documents and installed compilers are kept.</small>
    </p>
    {#if texFiles && texFiles.files > 0}<p class="muted">In-browser compiler files: {texFiles.files} · {mb(texFiles.bytes)}</p>{/if}
    {#if helper}
      <label class="row" style="gap: 8px; align-items: flex-start">
        <input type="checkbox" checked={helper.enabled} disabled={!helper.running} onchange={(e) => setHelper((e.currentTarget as HTMLInputElement).checked)} data-testid="helper-enabled" />
        <span><strong>Let the web app compile here</strong><br /><small class="muted">Browsers on this computer that you allow can compile with this app{helper.running ? '' : ' (not available: its port is in use)'}.</small></span>
      </label>
      {#each helper.pairings as p (p.id)}
        <div class="row" style="gap: 8px; margin-left: 24px">
          <span>{p.username} on {p.server}</span>
          <button class="small" onclick={() => revoke(p.id)} data-testid="revoke-pairing">Revoke</button>
        </div>
      {/each}
    {/if}
  {:else}
    <p class="muted" style="margin-bottom: 6px">With the HiveTeX desktop app running on this computer, projects in this browser can compile there (faster, every package) instead of in the browser.</p>
    {#if paired}
      <button class="small" onclick={unpair} data-testid="unpair-desktop">Stop using the desktop app</button>
    {:else}
      <button class="small" disabled={busy === 'pair'} onclick={pair} data-testid="pair-desktop">Compile with my desktop app</button>
    {/if}
    <button class="small" disabled={!!busy} onclick={clearFiles}>Clear in-browser compiler files</button>
  {/if}
  {#if message}<p class="notice" role="status" style="margin-top: 8px">{message}</p>{/if}
</div>
