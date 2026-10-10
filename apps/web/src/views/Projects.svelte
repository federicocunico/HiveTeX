<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, api } from '../lib/api.js';
  import { auth } from '../lib/auth.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import type { ProjectInfo } from '../lib/session.svelte.js';
  import { ARCHIVE_ACCEPT, itemsFromFiles, readArchive, readLoose } from '../lib/import/sources.js';
  import { type PickedFolder, foldersSupported, markFreshFolderProject, pickProjectFolder, readFolderMarker, rememberFolder, slugFromFolder } from '../lib/folders.js';
  import { type Location, allLocations } from '../lib/locations.js';

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

  // folders (where each project lives on this device)
  const folders = foldersSupported();
  let locations = $state<Record<string, Location>>({});
  /** "In a folder…" chosen on the new-project form. */
  let createFolder = $state<PickedFolder | null>(null);
  /** "Open folder…": a folder that is not a project folder yet, offered as a new project with that tree. */
  let fromFolder = $state<PickedFolder | null>(null);
  let fromSlug = $state('');
  let fromPassword = $state('');
  let fromUnprotected = $state(false);
  /** A folder whose marker names a project this account has not joined yet: joined, then bound. */
  let joinFolder = $state<PickedFolder | null>(null);
  let folderMessage = $state('');

  async function openFolder() {
    error = '';
    folderMessage = '';
    fromFolder = null;
    let f: PickedFolder | null;
    try {
      f = await pickProjectFolder('Open a project folder');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return;
    }
    if (!f) return;
    const marker = await readFolderMarker(f).catch(() => null);
    await loaded; // the account's projects decide between "open" and "join"
    const known = marker?.project ? projects.find((p) => p.id === marker.project?.id) : undefined;
    if (known) {
      await rememberFolder(known.id, f);
      go(`/p/${known.id}`);
    } else if (marker?.project) {
      // A collaborator's project folder (e.g. a clone of its GitHub backup): join it, then use this folder.
      joinSlug = marker.project.slug;
      joinFolder = f;
      folderMessage = `“${f.label}” belongs to the project ${marker.project.slug}. Enter its password to join; the folder will be used for it on this device.`;
    } else {
      fromFolder = f;
      fromSlug = slugFromFolder(f.label);
    }
  }

  async function chooseCreateFolder() {
    try {
      createFolder = (await pickProjectFolder('Choose the folder for the new project')) ?? createFolder;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function createFromFolder(e: Event) {
    e.preventDefault();
    if (!fromFolder) return;
    error = '';
    creating = true;
    try {
      const r = await api<{ project: ProjectInfo }>('POST', '/projects', {
        slug: fromSlug.trim(),
        ...(fromUnprotected ? { passwordProtected: false } : { password: fromPassword }),
      });
      await rememberFolder(r.project.id, fromFolder);
      markFreshFolderProject(r.project.id);
      go(`/p/${r.project.id}`);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not create project';
    } finally {
      creating = false;
    }
  }

  /** "just now", "5 minutes ago", "3 days ago"... */
  function ago(iso: string) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (s < 45) return 'just now';
    for (const [unit, secs] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
      if (s >= secs) return rtf.format(-Math.floor(s / secs), unit);
    }
    return rtf.format(-1, 'minute');
  }

  let loaded: Promise<void> = Promise.resolve();
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
  onMount(() => {
    loaded = load();
    void allLocations()
      .then((l) => (locations = l))
      .catch(() => {});
  });

  async function create(e: Event) {
    e.preventDefault();
    error = '';
    creating = true;
    try {
      const r = await api<{ project: ProjectInfo }>('POST', '/projects', {
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(unprotected ? { passwordProtected: false } : { password }),
      });
      if (createFolder) {
        await rememberFolder(r.project.id, createFolder);
        markFreshFolderProject(r.project.id);
      }
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
      if (joinFolder && r.project.slug === joinSlug.trim()) await rememberFolder(r.project.id, joinFolder);
      joinFolder = null;
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
  <div class="row wrap" style="align-items: center; gap: 12px">
    <h1 style="margin-right: auto">Your projects</h1>
    {#if folders}
      <button onclick={openFolder} data-testid="open-folder" title="Open a folder on this device (e.g. a git clone) as a project">Open folder…</button>
    {:else}
      <small class="muted" data-testid="folders-unsupported" style="max-width: 360px">Opening folders from your disk needs the desktop app or a Chromium browser (Chrome, Edge). Here, projects live in the app; import a folder or a .zip below.</small>
    {/if}
  </div>
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  {#if folderMessage}<div class="notice" role="status" data-testid="folder-message">{folderMessage}</div>{/if}

  {#if fromFolder}
    <form class="card" onsubmit={createFromFolder} data-testid="from-folder" style="margin-bottom: 16px">
      <h2>New project from “{fromFolder.label}”</h2>
      <p class="muted">The project gets this folder's files and tree, and stays in sync with it: edits made here or by any tool in the folder reach every collaborator.</p>
      <label class="field">Project ID <small>6–48 chars (a–z, 0–9, -)</small>
        <input type="text" bind:value={fromSlug} required pattern="[a-z0-9-]{'{'}6,48{'}'}" data-testid="from-folder-slug" />
      </label>
      <label class="field">Project password <small>collaborators need it to join</small>
        <input type="password" bind:value={fromPassword} disabled={fromUnprotected} required={!fromUnprotected} minlength="8" autocomplete="new-password" data-testid="from-folder-password" />
      </label>
      <label class="row" style="margin-bottom: 12px"><input type="checkbox" bind:checked={fromUnprotected} /> No password (anyone with the ID can join)</label>
      <div class="row">
        <button class="primary" type="submit" disabled={creating} data-testid="from-folder-create">Create project</button>
        <button type="button" onclick={() => (fromFolder = null)}>Cancel</button>
      </div>
    </form>
  {/if}
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
          {#if locations[p.id]?.kind === 'folder'}
            {@const label = (locations[p.id] as Location & { label: string }).label}
            <span class="pill" title={`Files are in the folder ${label} on this device`} data-testid="folder-badge">📁 {label}</span>
          {/if}
          <span class="spacer"></span>
          {#if p.lastOpenedAt}<small class="muted" data-testid="opened-ago" title={new Date(p.lastOpenedAt).toLocaleString()}>opened {ago(p.lastOpenedAt)}</small>{/if}
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
      {#if folders}
        <fieldset class="field" style="border: 0; padding: 0; margin: 0 0 12px">
          <legend>Where to keep the files on this device</legend>
          <label class="row"><input type="radio" name="where" checked={!createFolder} onchange={() => (createFolder = null)} /> In the app</label>
          <label class="row"><input type="radio" name="where" checked={!!createFolder} onclick={chooseCreateFolder} data-testid="create-in-folder" />
            {createFolder ? `In the folder “${createFolder.label}”` : 'In a folder…'}</label>
          {#if createFolder}<small class="muted">Edit the files there with any tool (Claude Code, Codex, an editor); changes sync with everyone.</small>{/if}
        </fieldset>
      {/if}
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
