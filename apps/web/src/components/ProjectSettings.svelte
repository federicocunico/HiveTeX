<script lang="ts">
  import { onMount } from 'svelte';
  import { ProjectAdmin } from '../lib/project-admin.svelte.js';
  import type { ProjectSession } from '../lib/session.svelte.js';
  import Dialog from '../ui/Dialog.svelte';
  import JoiningSection from './JoiningSection.svelte';
  import MembersSection from './MembersSection.svelte';

  let { session, onClose, onDeleted }: { session: ProjectSession; onClose: () => void; onDeleted: () => void } = $props();

  const admin = new ProjectAdmin(session);
  let confirmDelete = $state(false);
  let engine = $state(String(session.model.settings.get('engine') ?? 'pdflatex'));
  let main = $state(String(session.model.settings.get('main') ?? 'main.tex'));
  onMount(() => void admin.load());

  async function del() {
    if (await admin.deleteProject()) onDeleted();
  }

  function saveBuild() {
    if (!session.canWrite) return;
    session.model.settings.set('engine', engine);
    session.model.settings.set('main', main);
    admin.info = 'Saved';
  }
  const texFiles = $derived(session.files.filter((f) => f.kind === 'text' && f.path.endsWith('.tex')));
</script>

<Dialog title={session.role === 'owner' ? 'Project settings' : 'Settings'} size="lg" {onClose} testid="settings-dialog">
  {#if admin.error}<div class="error msg" role="alert">{admin.error}</div>{/if}
  {#if admin.info}<div class="notice msg" role="status">{admin.info}</div>{/if}

  <section>
    <h3>Build</h3>
    <div class="grid">
      <label for="ps-main">Main document</label>
      <select id="ps-main" bind:value={main} disabled={!session.canWrite}>
        {#each texFiles as f (f.id)}<option value={f.path}>{f.path}</option>{/each}
        {#if !texFiles.some((f) => f.path === main)}<option value={main}>{main}</option>{/if}
      </select>
      <label for="ps-engine">Engine</label>
      <select id="ps-engine" bind:value={engine} disabled={!session.canWrite}>
        <option value="pdflatex">pdfLaTeX</option>
        <option value="xelatex">XeLaTeX</option>
        <option value="lualatex">LuaLaTeX (desktop)</option>
      </select>
    </div>
    <p class="muted">Each device builds its own PDF locally.</p>
    <div><button type="button" onclick={saveBuild} disabled={!session.canWrite}>Save build settings</button></div>
    <p class="muted note">GitHub backup has its own panel: the cloud icon in the left rail.</p>
  </section>

  {#if admin.isOwner}
    <MembersSection {admin} />
    <JoiningSection {admin} />
    <section class="danger-zone">
      <h3>Danger zone</h3>
      {#if confirmDelete}
        <p>This removes the project for everyone. Local copies on devices are kept.</p>
        <div class="row">
          <button type="button" class="danger" onclick={del}>Yes, delete project</button>
          <button type="button" onclick={() => (confirmDelete = false)}>Cancel</button>
        </div>
      {:else}
        <div><button type="button" class="danger" onclick={() => (confirmDelete = true)}>Delete project…</button></div>
      {/if}
    </section>
  {:else}
    <p class="muted">Only owners can manage members and access.</p>
  {/if}
</Dialog>

<style>
  section {
    display: grid;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: var(--text-sm);
  }
  .msg {
    padding: 8px 10px;
    margin: 0;
  }
  .grid {
    display: grid;
    grid-template-columns: 170px minmax(0, 1fr);
    gap: 8px;
    align-items: center;
    max-width: 520px;
  }
  .grid label {
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-sm);
  }
  .note {
    margin: 0;
    font-size: var(--text-xs);
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .danger-zone {
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }
  .danger-zone p {
    margin: 0;
  }
</style>
