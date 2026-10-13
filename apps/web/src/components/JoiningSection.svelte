<script lang="ts">
  import type { ProjectAdmin } from '../lib/project-admin.svelte.js';

  /** How people join: their starting role, the project ID and the password. Owners only. */
  let { admin, showId = true }: { admin: ProjectAdmin; showId?: boolean } = $props();
  let slugInput = $state<HTMLInputElement>();
  const id = `join-${Math.random().toString(36).slice(2, 7)}`;
</script>

<section class="joining">
  <h3>Joining</h3>
  <div class="row">
    <label for="{id}-role">Default role for new members</label>
    <select id="{id}-role" bind:value={admin.defaultRole} onchange={() => admin.touchDefaultRole()}>
      <option value="viewer">viewer (read-only)</option>
      <option value="editor">editor</option>
    </select>
    <button type="button" onclick={() => admin.saveDefault()}>Save</button>
  </div>
  {#if showId}
    <div class="row">
      <label for="{id}-slug">Project name or current ID</label>
      <input id="{id}-slug" type="text" bind:this={slugInput} bind:value={admin.slug} maxlength="48" aria-describedby="{id}-hint" />
      <button type="button" onclick={async () => { if (await admin.saveSlug()) slugInput?.focus(); }} disabled={admin.slug === admin.session.project.slug}>Change ID</button>
    </div>
    <p class="hint" id="{id}-hint">Enter a new name to change it. A unique suffix is added automatically; co-authors need the full new ID.</p>
  {/if}
  <div class="row">
    <label for="{id}-pw">{admin.session.project.passwordProtected ? 'Change password' : 'Set a password'}</label>
    <input id="{id}-pw" type="password" bind:value={admin.newPassword} minlength="8" autocomplete="new-password" />
    <button type="button" onclick={() => admin.savePassword()} disabled={admin.newPassword.length < 8}>Save password</button>
    {#if admin.session.project.passwordProtected}<button type="button" class="danger" onclick={() => admin.disablePassword()}>Remove password</button>{/if}
  </div>
</section>

<style>
  h3 {
    margin: 0 0 8px;
    font-size: var(--text-sm);
  }
  .joining {
    display: grid;
    gap: 8px;
  }
  .row {
    display: grid;
    grid-template-columns: 170px minmax(0, 1fr) auto auto;
    gap: 8px;
    align-items: center;
  }
  label {
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .row input,
  .row select {
    width: 100%;
  }
  @media (max-width: 560px) {
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    label {
      grid-column: 1 / -1;
    }
  }
</style>
