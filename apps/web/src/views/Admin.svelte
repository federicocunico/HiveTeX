<script lang="ts">
  import { ApiError, api } from '../lib/api.js';

  interface U {
    id: string;
    username: string;
    email: string;
    isAdmin: boolean;
    mustReset: boolean;
  }

  let q = $state('');
  let users = $state<U[]>([]);
  let needReauth = $state(false);
  let password = $state('');
  let error = $state('');
  let info = $state('');
  let confirm = $state<string | null>(null);

  async function search() {
    error = '';
    try {
      users = (await api<{ users: U[] }>('GET', `/auth/admin/users?q=${encodeURIComponent(q)}`)).users;
      needReauth = false;
    } catch (e) {
      handle(e);
    }
  }

  function handle(e: unknown) {
    if (e instanceof ApiError && e.code === 'reauth_required') needReauth = true;
    else error = e instanceof Error ? e.message : 'Failed';
  }

  async function reauth(e: Event) {
    e.preventDefault();
    try {
      await api('POST', '/auth/reauth', { password });
      password = '';
      needReauth = false;
      await search();
    } catch (err) {
      handle(err);
    }
  }

  async function force(u: U) {
    error = info = '';
    try {
      const r = await api<{ emailed: boolean }>('POST', '/auth/admin/force-reset', { userId: u.id });
      info = `Password of ${u.username} was reset${r.emailed ? ' and a recovery email was sent' : ' (their email is not verified, so no email was sent)'}.`;
      confirm = null;
      await search();
    } catch (err) {
      handle(err);
    }
  }
</script>

<div class="page admin">
  <h1>Platform administration</h1>
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  {#if info}<div class="notice" role="status">{info}</div>{/if}

  {#if needReauth}
    <form class="card" onsubmit={reauth} style="max-width: 380px">
      <p>Confirm your password to continue (valid for 10 minutes).</p>
      <label class="field">Password <input type="password" bind:value={password} autocomplete="current-password" required /></label>
      <button class="primary" type="submit">Confirm</button>
    </form>
  {:else}
    <form class="row" onsubmit={(e) => { e.preventDefault(); void search(); }}>
      <input type="search" placeholder="Username or email (prefix)" bind:value={q} aria-label="Find user" />
      <button type="submit">Search</button>
    </form>
    <div class="scroll-x">
      <table style="margin-top: 12px">
        <thead><tr><th>User</th><th>Email</th><th></th></tr></thead>
        <tbody>
          {#each users as u (u.id)}
            <tr>
              <td>{u.username} {#if u.isAdmin}<span class="pill">admin</span>{/if} {#if u.mustReset}<span class="pill warn">reset pending</span>{/if}</td>
              <td>{u.email}</td>
              <td style="text-align: right">
                {#if confirm === u.id}
                  <button class="danger small" onclick={() => force(u)}>Confirm force reset</button>
                  <button class="small" onclick={() => (confirm = null)}>Cancel</button>
                {:else}
                  <button class="small" onclick={() => (confirm = u.id)}>Force password reset</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .admin {
    width: min(900px, 100%);
    padding: 32px clamp(16px, 4vw, 40px) 48px;
    display: grid;
    gap: 16px;
    align-content: start;
  }
  h1 {
    margin: 0;
    font-size: var(--text-2xl);
  }
  .admin :global(table) {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-l);
  }
</style>
