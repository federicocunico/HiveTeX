<script lang="ts">
  import { onMount } from 'svelte';
  import { isDesktop } from './lib/api.js';
  import AppHeader from './components/AppHeader.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import ShortcutsDialog from './components/ShortcutsDialog.svelte';
  import { auth, loadMe, logout } from './lib/auth.svelte.js';
  import { allCommands, commandForKey, registerCommands, registerSource } from './lib/commands.svelte.js';
  import { openPalette, openShortcuts, palette } from './lib/palette.svelte.js';
  import { setPref } from './lib/preferences.svelte.js';
  import { ArrowLeft, BookOpen, FolderOpen, Keyboard, LogOut, Monitor, Moon, Sun, User } from './ui/icons.js';
  import { SOURCE_URL } from './lib/links.js';
  import { go, route } from './lib/router.svelte.js';
  import Account from './views/Account.svelte';
  import Admin from './views/Admin.svelte';
  import Auth from './views/Auth.svelte';
  import GithubContinue from './views/GithubContinue.svelte';
  import Projects from './views/Projects.svelte';
  import Toaster from './ui/Toaster.svelte';

  onMount(loadMe);

  const publicRoutes = ['/login', '/register', '/forgot', '/reset', '/verify'];
  const isPublic = (hash: string) => publicRoutes.includes((hash.replace(/^#/, '').split('?')[0] ?? '') || '/');

  // A link opened while signed out (a project, a GitHub authorization, …) continues after sign-in (same tab only).
  const RESUME = 'hivetex.resume';

  /** Signed-out web visitors at the root see the landing page; the desktop app goes to sign-in. */
  const showLanding = $derived(auth.ready && !auth.user && !isDesktop && route.path === '/');

  $effect(() => {
    if (!auth.ready) return;
    if (!auth.user && !publicRoutes.includes(route.path) && !showLanding) {
      if (route.path !== '/') {
        try {
          sessionStorage.setItem(RESUME, location.hash);
        } catch {
          /* storage blocked: the user opens the link again */
        }
      }
      go('/login');
    }
    if (auth.user && (route.path === '/login' || route.path === '/register')) {
      let pending: string | null = null;
      try {
        pending = sessionStorage.getItem(RESUME);
        sessionStorage.removeItem(RESUME);
      } catch {
        pending = null;
      }
      if (pending?.startsWith('#/') && !isPublic(pending)) location.hash = pending;
      else go('/');
    }
  });

  const projectId = $derived(route.path.startsWith('/p/') ? route.path.slice(3) : null);

  // App-wide commands (palette, shortcuts, account, theme) and the page-wide keyboard handler.
  registerCommands([
    { id: 'palette', title: 'Command palette', group: 'Help', keys: ['Mod+K'], hidden: true, when: () => !!auth.user, run: () => openPalette() },
    { id: 'shortcuts', title: 'Keyboard shortcuts', group: 'Help', keys: ['Mod+Shift+/'], icon: Keyboard, aliases: ['help', 'keys', 'hotkeys'], run: openShortcuts },
    { id: 'go-projects', title: 'Go to your projects', group: 'Navigate', icon: ArrowLeft, aliases: ['home', 'dashboard'], when: () => !!auth.user, run: () => go('/') },
    { id: 'account', title: 'Account and preferences', group: 'Account', icon: User, aliases: ['settings', 'password', 'preferences'], when: () => !!auth.user, run: () => go('/account') },
    { id: 'theme-light', title: 'Theme: light', group: 'Account', icon: Sun, aliases: ['appearance'], run: () => setPref('theme', 'light') },
    { id: 'theme-dark', title: 'Theme: dark', group: 'Account', icon: Moon, aliases: ['appearance', 'night'], run: () => setPref('theme', 'dark') },
    { id: 'theme-system', title: 'Theme: follow the system', group: 'Account', icon: Monitor, aliases: ['appearance', 'auto'], run: () => setPref('theme', 'system') },
    { id: 'keys-default', title: 'Editor keys: default', group: 'Account', icon: Keyboard, aliases: ['keymap'], run: () => setPref('keymap', 'default') },
    { id: 'keys-vim', title: 'Editor keys: Vim', group: 'Account', icon: Keyboard, aliases: ['keymap', 'vi'], run: () => setPref('keymap', 'vim') },
    { id: 'keys-emacs', title: 'Editor keys: Emacs', group: 'Account', icon: Keyboard, aliases: ['keymap'], run: () => setPref('keymap', 'emacs') },
    { id: 'sign-out', title: 'Sign out', group: 'Account', icon: LogOut, aliases: ['log out', 'logout'], when: () => !!auth.user, run: () => void logout().then(() => go('/login')) },
    { id: 'source', title: 'Source code and documentation', group: 'Help', icon: BookOpen, aliases: ['github', 'docs'], run: () => window.open(SOURCE_URL, '_blank', 'noopener') },
  ]);

  // The account's projects, as cached by the projects page (also available offline).
  registerSource({
    id: 'projects',
    label: 'Projects',
    items: () => {
      if (!auth.user) return [];
      try {
        const list = JSON.parse(localStorage.getItem('hivetex.projects') ?? '[]') as Array<{ id: string; slug: string; role: string }>;
        return list.map((p) => ({ id: `project:${p.id}`, title: p.slug, detail: p.role, icon: FolderOpen, run: () => go(`/p/${p.id}`) }));
      } catch {
        return [];
      }
    },
  });

  // e2e: inspect the live registry (ids, shortcuts, availability) without going through the UI.
  if (localStorage.getItem('hivetex.test') === '1')
    (window as unknown as { __commands: unknown }).__commands = () =>
      allCommands().map((c) => ({ id: c.id, title: c.title, keys: c.keys ?? [], editor: !!c.editor, available: !c.when || c.when() }));

  function onKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented || palette.open || e.isComposing) return;
    const c = commandForKey(e);
    if (!c) return;
    e.preventDefault();
    c.run();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if !auth.ready}
  <div class="center"><p class="muted">Loading…</p></div>
{:else}
  <div class="shell">
    {#if auth.user && !projectId}
      <AppHeader />
    {:else}
      <div></div>
    {/if}

    <main style="min-height: 0; overflow: auto">
      {#if route.path === '/login'}<Auth mode="login" />
      {:else if route.path === '/register'}<Auth mode="register" />
      {:else if route.path === '/forgot'}<Auth mode="forgot" />
      {:else if route.path === '/reset'}<Auth mode="reset" />
      {:else if route.path === '/verify'}<Auth mode="verify" />
      {:else if showLanding}{#await import('./views/Landing.svelte') then m}<m.default />{/await}
      {:else if !auth.user}<div class="center"><p class="muted">Redirecting…</p></div>
      {:else if projectId}{#await import('./views/Workspace.svelte')}<div class="center"><p class="muted">Loading editor…</p></div>{:then m}{#key projectId}<m.default {projectId} />{/key}{/await}
      {:else if route.path === '/github-continue' || route.path === '/github-done'}<GithubContinue />
      {:else if route.path === '/account'}<Account />
      {:else if route.path === '/admin' && auth.user.isAdmin}<Admin />
      {:else}<Projects />
      {/if}
    </main>
  </div>
  <footer class="sr-only">HiveTeX is open source (AGPL-3.0): {SOURCE_URL}</footer>
{/if}
<Toaster />
{#if palette.open}<CommandPalette />{/if}
{#if palette.shortcuts}<ShortcutsDialog />{/if}
