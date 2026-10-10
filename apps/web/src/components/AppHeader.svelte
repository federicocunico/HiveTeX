<script lang="ts">
  import { auth, logout } from '../lib/auth.svelte.js';
  import { SOURCE_URL } from '../lib/links.js';
  import { openPalette, openShortcuts } from '../lib/palette.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import { BookOpen, Help, Keyboard, LogOut, Search, User, Users } from '../ui/icons.js';
  import Avatar from '../ui/Avatar.svelte';
  import Icon from '../ui/Icon.svelte';
  import Kbd from '../ui/Kbd.svelte';
  import Logo from '../ui/Logo.svelte';
  import Menu, { type MenuItem } from '../ui/Menu.svelte';

  /** Header of the signed-in screens outside a project: home, search/commands, help and the account menu. */
  const user = $derived(auth.user);

  async function signOut() {
    await logout();
    go('/login');
  }

  const helpItems: MenuItem[] = [
    { label: 'Keyboard shortcuts', icon: Keyboard, hint: 'Mod+Shift+/', onSelect: openShortcuts },
    { label: 'Source code and documentation', icon: BookOpen, onSelect: () => window.open(SOURCE_URL, '_blank', 'noopener') },
  ];

  const accountItems = $derived<MenuItem[]>([
    { label: 'Account and preferences', icon: User, onSelect: () => go('/account') },
    ...(user?.isAdmin ? [{ label: 'Administration', icon: Users, onSelect: () => go('/admin') } as MenuItem] : []),
    'separator',
    { label: 'Sign out', icon: LogOut, onSelect: () => void signOut() },
  ]);
</script>

<header class="apphead">
  <a class="home" href="#/" aria-label="HiveTeX, your projects"><Logo /></a>
  <span class="sp"></span>
  <button type="button" class="search" aria-label="Search projects and commands" onclick={() => openPalette()} data-testid="open-palette">
    <Icon icon={Search} />
    <span class="ph">Search projects and commands</span>
    <Kbd keys="Mod+K" />
  </button>
  <span class="sp"></span>
  <Menu label="Help" items={helpItems} triggerClass="iconlike" tip="Help">
    {#snippet trigger()}<Icon icon={Help} size={18} />{/snippet}
  </Menu>
  {#if user}
    <span class="who" title={user.username}>{user.username}</span>
    <Menu label="Account menu" items={accountItems} triggerClass="avatar-trigger" tip={user.username} testid="account-menu">
      {#snippet trigger()}<Avatar name={user.username} size={30} />{/snippet}
    </Menu>
  {/if}
</header>

<style>
  .apphead {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 0 max(16px, env(safe-area-inset-left, 0px));
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }
  .home {
    text-decoration: none;
    flex: none;
  }
  .sp {
    flex: 1;
  }
  .search {
    flex: 0 1 380px;
    min-width: 0;
    justify-content: flex-start;
    gap: 8px;
    height: 34px;
    min-height: 34px;
    padding: 0 8px 0 10px;
    border: 1px solid var(--line);
    background: var(--sunken);
    color: var(--muted);
    font-weight: 400;
  }
  .search:hover {
    border-color: var(--line-strong);
  }
  .ph {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
  }
  .who {
    max-width: 16ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: var(--text-sm);
  }
  .apphead :global(.iconlike),
  .apphead :global(.avatar-trigger) {
    min-height: 0;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--muted);
  }
  .apphead :global(.iconlike:hover) {
    background: var(--sunken);
    color: var(--ink);
  }
  @media (max-width: 640px) {
    .ph,
    .search :global(.kbds),
    .who {
      display: none;
    }
    .search {
      flex: none;
      width: 34px;
      padding: 0;
      justify-content: center;
    }
  }
</style>
