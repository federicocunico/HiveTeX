<script lang="ts">
  import { onMount } from 'svelte';
  import { auth, loadMe, logout } from './lib/auth.svelte.js';
  import { go, route } from './lib/router.svelte.js';
  import Account from './views/Account.svelte';
  import Admin from './views/Admin.svelte';
  import Auth from './views/Auth.svelte';
  import GithubContinue from './views/GithubContinue.svelte';
  import Projects from './views/Projects.svelte';

  onMount(loadMe);

  const sourceUrl = (import.meta.env.VITE_SOURCE_URL as string | undefined) ?? 'https://github.com/federicocunico/p2platex';
  const publicRoutes = ['/login', '/register', '/forgot', '/reset', '/verify'];

  // A GitHub authorization that lands here signed out continues after sign-in (same tab only).
  const PENDING_GH = 'p2platex.github-continue';

  $effect(() => {
    if (!auth.ready) return;
    if (!auth.user && !publicRoutes.includes(route.path)) {
      if (route.path === '/github-continue') {
        try {
          sessionStorage.setItem(PENDING_GH, location.hash);
        } catch {
          /* storage blocked: the user starts the GitHub link again */
        }
      }
      go('/login');
    }
    if (auth.user && (route.path === '/login' || route.path === '/register')) {
      let pending: string | null = null;
      try {
        pending = sessionStorage.getItem(PENDING_GH);
        sessionStorage.removeItem(PENDING_GH);
      } catch {
        pending = null;
      }
      if (pending?.startsWith('#/github-continue?')) location.hash = pending;
      else go('/');
    }
  });

  const projectId = $derived(route.path.startsWith('/p/') ? route.path.slice(3) : null);

  async function signOut() {
    await logout();
    go('/login');
  }
</script>

{#if !auth.ready}
  <div class="center"><p class="muted">Loading…</p></div>
{:else}
  <div class="shell">
    {#if !projectId}
      <header class="topbar">
        <a class="brand" href="#/">p2platex</a>
        <span class="spacer"></span>
        <a href={sourceUrl} target="_blank" rel="noreferrer noopener" title="p2platex is free software under the AGPL-3.0">Source</a>
        {#if auth.user}
          <a href="#/">Projects</a>
          {#if auth.user.isAdmin}<a href="#/admin">Admin</a>{/if}
          <a class="user" href="#/account" title={auth.user.username}>{auth.user.username}</a>
          <button class="small" onclick={signOut}>Sign out</button>
        {/if}
      </header>
    {:else}
      <div></div>
    {/if}

    <main style="min-height: 0; overflow: auto">
      {#if route.path === '/login'}<Auth mode="login" />
      {:else if route.path === '/register'}<Auth mode="register" />
      {:else if route.path === '/forgot'}<Auth mode="forgot" />
      {:else if route.path === '/reset'}<Auth mode="reset" />
      {:else if route.path === '/verify'}<Auth mode="verify" />
      {:else if !auth.user}<div class="center"><p class="muted">Redirecting…</p></div>
      {:else if projectId}{#await import('./views/Workspace.svelte')}<div class="center"><p class="muted">Loading editor…</p></div>{:then m}{#key projectId}<m.default {projectId} />{/key}{/await}
      {:else if route.path === '/github-continue' || route.path === '/github-done'}<GithubContinue />
      {:else if route.path === '/account'}<Account />
      {:else if route.path === '/admin' && auth.user.isAdmin}<Admin />
      {:else}<Projects />
      {/if}
    </main>
  </div>
  <footer class="sr-only">p2platex is open source (AGPL-3.0): {sourceUrl}</footer>
{/if}
