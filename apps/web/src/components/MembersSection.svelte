<script lang="ts">
  import type { ProjectAdmin } from '../lib/project-admin.svelte.js';
  import Avatar from '../ui/Avatar.svelte';

  /** Owner view of members: role per person, remove, ban. */
  let { admin }: { admin: ProjectAdmin } = $props();
</script>

<section class="members">
  <h3>Members</h3>
  <ul class="list" data-testid="members-table">
    {#each admin.members as m (m.userId)}
      <li>
        <Avatar name={m.username} size={28} />
        <span class="who">
          <strong>{m.username}{m.username === admin.session.user.username ? ' (you)' : ''}</strong>
          <small>{admin.session.peers.some((p) => p.uname === m.username) ? 'Online now' : `Joined ${new Date(m.joinedAt).toLocaleDateString()}`}</small>
        </span>
        {#if m.username === admin.session.user.username}
          <!-- your own membership: changing or removing it here would only lock you out -->
          <span class="pill honey self">{m.role}</span>
          <span></span>
        {:else}
          <select value={m.role} aria-label={`Role of ${m.username}`} onchange={(e) => admin.setRole(m, (e.currentTarget as HTMLSelectElement).value)}>
            <option value="owner">owner</option>
            <option value="editor">editor</option>
            <option value="viewer">viewer (read-only)</option>
          </select>
          <span class="acts">
            <button type="button" class="small" onclick={() => admin.remove(m, false)}>Remove</button>
            <button type="button" class="small danger" onclick={() => admin.remove(m, true)} data-tip="Remove and keep them from joining again">Ban</button>
          </span>
        {/if}
      </li>
    {/each}
  </ul>
  <p class="muted note">Removed members lose access to new updates within about a minute. They keep the copy already on their device.</p>
  {#if admin.bans.length}<p class="muted note">{admin.bans.length} banned user{admin.bans.length === 1 ? '' : 's'}.</p>{/if}
</section>

<style>
  h3 {
    margin: 0 0 8px;
    font-size: var(--text-sm);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r-m);
  }
  li {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto auto;
    gap: 10px;
    align-items: center;
    padding: 8px 12px;
  }
  li + li {
    border-top: 1px solid var(--line);
  }
  .who {
    display: grid;
    min-width: 0;
  }
  .who strong {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .who small {
    color: var(--muted);
    font-size: var(--text-xs);
  }
  select {
    width: auto;
    min-height: 30px;
    font-size: var(--text-sm);
  }
  .acts {
    display: flex;
    gap: 4px;
  }
  .self {
    text-transform: capitalize;
    justify-self: start;
  }
  .note {
    margin: 6px 0 0;
    font-size: var(--text-xs);
  }
  @media (max-width: 560px) {
    li {
      grid-template-columns: 28px minmax(0, 1fr);
    }
    select,
    .acts {
      grid-column: 2;
    }
  }
</style>
