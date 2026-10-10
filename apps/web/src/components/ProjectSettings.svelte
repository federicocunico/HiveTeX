<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import GithubPanel from './GithubPanel.svelte';
  import type { ProjectSession } from '../lib/session.svelte.js';

  let { session, onClose, onDeleted }: { session: ProjectSession; onClose: () => void; onDeleted: () => void } = $props();

  interface Member {
    userId: string;
    username: string;
    role: 'owner' | 'editor' | 'viewer';
    joinedAt: string;
  }

  let members = $state<Member[]>([]);
  let bans = $state<string[]>([]);
  let defaultRole = $state(session.project.defaultRole);
  let roleTouched = false;
  let slug = $state(session.project.slug);
  let newPassword = $state('');
  let error = $state('');
  let info = $state('');
  let confirmDelete = $state(false);
  let engine = $state(String(session.model.settings.get('engine') ?? 'pdflatex'));
  let main = $state(String(session.model.settings.get('main') ?? 'main.tex'));
  let compileForOthers = $state(localStorage.getItem('hivetex.compileForOthers') !== '0');
  const isOwner = $derived(session.role === 'owner');
  const pid = session.project.id;

  async function load() {
    if (!isOwner) return;
    try {
      const r = await api<{ members: Member[]; bans: string[]; project: { defaultRole: string } }>('GET', `/projects/${pid}`);
      members = r.members;
      bans = r.bans;
      if (!roleTouched) defaultRole = r.project.defaultRole;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load members';
    }
  }
  onMount(load);

  async function act(fn: () => Promise<unknown>, ok = 'Saved') {
    error = '';
    info = '';
    try {
      await fn();
      info = ok;
      await session.refreshTicketNow(); // announce the new membership epoch to peers right away
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed';
    }
  }

  const setRole = (m: Member, role: string) => act(() => api('PATCH', `/projects/${pid}/members/${m.userId}`, { role }), `${m.username} is now ${role}`);
  const remove = (m: Member, ban: boolean) =>
    act(() => api('DELETE', `/projects/${pid}/members/${m.userId}`, { ban }), ban ? `${m.username} removed and banned` : `${m.username} removed`);
  const saveDefault = () =>
    act(async () => {
      await api('PATCH', `/projects/${pid}`, { defaultRole });
      roleTouched = false;
    });
  const saveSlug = () => act(() => api('PATCH', `/projects/${pid}`, { slug }), 'Project ID changed. Share the new ID with collaborators.');
  const savePassword = () => act(async () => { await api('PATCH', `/projects/${pid}`, { password: newPassword }); newPassword = ''; }, 'Password changed (existing members keep access)');
  const disablePassword = () => act(() => api('PATCH', `/projects/${pid}`, { password: null }), 'Password protection disabled');
  async function del() {
    await act(() => api('DELETE', `/projects/${pid}`), 'Deleted');
    if (!error) onDeleted();
  }

  function saveBuild() {
    session.model.settings.set('engine', engine);
    session.model.settings.set('main', main);
    session.setCompileForOthers(compileForOthers);
    info = 'Saved';
  }
  const texFiles = $derived(session.files.filter((f) => f.kind === 'text' && f.path.endsWith('.tex')));
</script>

<div class="dialog" role="dialog" aria-modal="true" aria-label="Project settings" data-testid="settings-dialog">
  <div class="card">
    <div class="row"><h2 class="spacer">Project settings</h2><button onclick={onClose}>Close</button></div>
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    {#if info}<div class="notice" role="status">{info}</div>{/if}

    <h3>Build</h3>
    <div class="row wrap">
      <label>Main file
        <select bind:value={main} disabled={!session.canWrite}>
          {#each texFiles as f}<option value={f.path}>{f.path}</option>{/each}
          {#if !texFiles.some((f) => f.path === main)}<option value={main}>{main}</option>{/if}
        </select>
      </label>
      <label>Engine
        <select bind:value={engine} disabled={!session.canWrite}>
          <option value="pdflatex">pdfLaTeX</option>
          <option value="xelatex">XeLaTeX</option>
          <option value="lualatex">LuaLaTeX (desktop)</option>
        </select>
      </label>
    </div>
    <label class="row" style="margin: 8px 0"><input type="checkbox" bind:checked={compileForOthers} disabled={!session.engine} /> Let this device compile for the others when it is the best available</label>
    <button onclick={saveBuild}>Save build settings</button>

    <GithubPanel {session} />

    {#if isOwner}
      <h3 style="margin-top: 24px">Members</h3>
      <div class="scroll-x">
        <table data-testid="members-table">
          <thead><tr><th>User</th><th>Role</th><th></th></tr></thead>
          <tbody>
            {#each members as m (m.userId)}
              <tr>
                <td>{m.username}</td>
                <td>
                  <select value={m.role} aria-label={`Role of ${m.username}`} onchange={(e) => setRole(m, (e.currentTarget as HTMLSelectElement).value)}>
                    <option value="owner">owner</option>
                    <option value="editor">editor</option>
                    <option value="viewer">viewer (read-only)</option>
                  </select>
                </td>
                <td style="text-align: right">
                  <button class="small" onclick={() => remove(m, false)}>Remove</button>
                  <button class="small danger" onclick={() => remove(m, true)}>Ban</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="muted">Removed members lose access to new updates within about a minute. They keep the copy already on their device.</p>

      <h3>Joining</h3>
      <div class="row wrap">
        <label>New members start as
          <select bind:value={defaultRole} aria-label="Default role" onchange={() => (roleTouched = true)}>
            <option value="viewer">viewer (read-only)</option>
            <option value="editor">editor</option>
          </select>
        </label>
        <button onclick={saveDefault}>Save</button>
      </div>
      <div class="row wrap" style="margin-top: 8px">
        <label class="spacer">Project ID <input type="text" bind:value={slug} /></label>
        <button onclick={saveSlug} disabled={slug === session.project.slug}>Change ID</button>
      </div>
      <div class="row wrap" style="margin-top: 8px">
        <label class="spacer">{session.project.passwordProtected ? 'Change password' : 'Set a password'} <input type="password" bind:value={newPassword} minlength="8" autocomplete="new-password" /></label>
        <button onclick={savePassword} disabled={newPassword.length < 8}>Save password</button>
        {#if session.project.passwordProtected}<button class="danger" onclick={disablePassword}>Remove password</button>{/if}
      </div>
      {#if bans.length}<p class="muted">{bans.length} banned user{bans.length === 1 ? '' : 's'}.</p>{/if}

      <h3 style="margin-top: 24px">Danger zone</h3>
      {#if confirmDelete}
        <p>This removes the project for everyone. Local copies on devices are kept.</p>
        <button class="danger" onclick={del}>Yes, delete project</button>
        <button onclick={() => (confirmDelete = false)}>Cancel</button>
      {:else}
        <button class="danger" onclick={() => (confirmDelete = true)}>Delete project…</button>
      {/if}
    {:else}
      <p class="muted">Only owners can manage members and access.</p>
    {/if}
  </div>
</div>
