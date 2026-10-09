<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, api } from '../lib/api.js';
  import { auth } from '../lib/auth.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import type { ProjectInfo } from '../lib/session.svelte.js';
  import { ARCHIVE_ACCEPT, itemsFromFiles, readArchive, readLoose } from '../lib/import/sources.js';

  let projects = $state<ProjectInfo[]>([]);
  let loading = $state(true);
  let error = $state('');

  // create
  let slug = $state('');
  let password = $state('');
  let unprotected = $state(false);
  let creating = $state(false);

  // join
  let joinSlug = $state('');
  let joinPassword = $state('');
  let joining = $state(false);

  // import
  let importFiles = $state<File[]>([]);
  let importIsFolder = $state(false);
  let archiveInput: HTMLInputElement;
  let folderInput: HTMLInputElement;

  const cacheKey = 'p2platex.projects';

  async function load() {
    loading = true;
    try {
      const r = await api<{ projects: ProjectInfo[] }>('GET', '/projects');
      projects = r.projects;
      localStorage.setItem(cacheKey, JSON.stringify(projects));
    } catch (e) {
      // Offline: show the projects this device already knows about.
      try {
        projects = JSON.parse(localStorage.getItem(cacheKey) ?? '[]');
      } catch {
        projects = [];
      }
      if (!(e instanceof ApiError && e.status === 0)) error = e instanceof Error ? e.message : 'Failed to load projects';
    } finally {
      loading = false;
    }
  }
  onMount(load);

  async function create(e: Event) {
    e.preventDefault();
    error = '';
    creating = true;
    try {
      const r = await api<{ project: ProjectInfo }>('POST', '/projects', {
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(unprotected ? { passwordProtected: false } : { password }),
      });
      pendingImport = importRequest();
      go(`/p/${r.project.id}`);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not create project';
    } finally {
      creating = false;
    }
  }

  async function join(e: Event) {
    e.preventDefault();
    error = '';
    joining = true;
    try {
      const r = await api<{ project: ProjectInfo }>('POST', '/projects/join', { slug: joinSlug.trim(), password: joinPassword });
      go(`/p/${r.project.id}`);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not join';
    } finally {
      joining = false;
    }
  }

  function pickImport(e: Event, folder: boolean) {
    importFiles = [...((e.currentTarget as HTMLInputElement).files ?? [])];
    importIsFolder = folder;
    // only one source at a time
    if (folder && archiveInput) archiveInput.value = '';
    if (!folder && folderInput) folderInput.value = '';
  }

  function importRequest(): ImportRequest | null {
    const files = importFiles;
    if (files.length === 0) return null;
    if (importIsFolder) {
      const name = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0] || 'folder';
      return { kind: 'load', name, fresh: true, load: (p) => readLoose(name, itemsFromFiles(files), { stripRoot: true }, p) };
    }
    const f = files[0] as File;
    return { kind: 'load', name: f.name, fresh: true, load: async () => readArchive(f.name, new Uint8Array(await f.arrayBuffer())) };
  }
</script>

<script lang="ts" module>
  import type { ImportRequest } from '../components/ImportDialog.svelte';

  /** Import chosen on the "new project" form; consumed by the workspace right after creation (never persisted). */
  export let pendingImport: ImportRequest | null = null;
  export function takePendingImport() {
    const f = pendingImport;
    pendingImport = null;
    return f;
  }
</script>

<div class="page">
  <h1>Your projects</h1>
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  {#if auth.offline}
    <div class="notice">You are offline. Projects stored on this device still open and can be edited.</div>
  {/if}

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if projects.length === 0}
    <p class="muted">No projects yet. Create one, or join a collaborator's project with its ID.</p>
  {:else}
    <div class="list" data-testid="project-list">
      {#each projects as p (p.id)}
        <a class="item" href={`#/p/${p.id}`} style="text-decoration: none; color: inherit">
          <strong>{p.slug}</strong>
          <span class={`pill ${p.role}`}>{p.role}</span>
          {#if p.passwordProtected}<span class="pill" title="Password protected">🔒</span>{/if}
          <span class="spacer"></span>
          <span class="muted">Open →</span>
        </a>
      {/each}
    </div>
  {/if}

  <div class="row wrap" style="align-items: flex-start; margin-top: 24px; gap: 16px">
    <form class="card" style="flex: 1 1 320px" onsubmit={create}>
      <h2>New project</h2>
      <label class="field">Project ID <small>optional, 6–48 chars (a–z, 0–9, -). Leave empty for a random one.</small>
        <input type="text" bind:value={slug} placeholder="my-paper-2026" />
      </label>
      <label class="field">Project password <small>collaborators need it to join</small>
        <input type="password" bind:value={password} disabled={unprotected} required={!unprotected} minlength="8" autocomplete="new-password" />
      </label>
      <label class="row" style="margin-bottom: 12px"><input type="checkbox" bind:checked={unprotected} /> No password (anyone with the ID can join)</label>
      <fieldset class="field" style="border: 0; padding: 0; margin: 0 0 12px">
        <legend>Start from existing sources <small>optional: Overleaf/GitHub .zip, arXiv .tar.gz, or a folder</small></legend>
        <label class="field" style="margin-bottom: 4px">Archive
          <input bind:this={archiveInput} type="file" accept={ARCHIVE_ACCEPT} onchange={(e) => pickImport(e, false)} data-testid="create-archive" />
        </label>
        <label class="field" style="margin-bottom: 0">…or folder
          <input bind:this={folderInput} type="file" webkitdirectory onchange={(e) => pickImport(e, true)} data-testid="create-folder" />
        </label>
      </fieldset>
      <button class="primary" type="submit" disabled={creating}>Create project</button>
    </form>

    <form class="card" style="flex: 1 1 320px" onsubmit={join}>
      <h2>Join a project</h2>
      <label class="field">Project ID
        <input type="text" bind:value={joinSlug} required />
      </label>
      <label class="field">Project password
        <input type="password" bind:value={joinPassword} autocomplete="off" />
      </label>
      <button class="primary" type="submit" disabled={joining}>Join</button>
    </form>
  </div>
</div>
