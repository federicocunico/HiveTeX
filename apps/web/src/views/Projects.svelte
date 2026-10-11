<script lang="ts">
  import { onMount } from 'svelte';
  import TemplateGallery from '../components/TemplateGallery.svelte';
  import { ApiError, api } from '../lib/api.js';
  import { registerCommands } from '../lib/commands.svelte.js';
  import { auth } from '../lib/auth.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import type { ProjectInfo } from '../lib/session.svelte.js';
  import { ARCHIVE_ACCEPT, itemsFromFiles, readArchive, readLoose } from '../lib/import/sources.js';
  import { markCreatedHere } from '../lib/created-here.js';
  import { type PickedFolder, foldersSupported, markFreshFolderProject, pickProjectFolder, readFolderMarker, rememberFolder, slugFromFolder } from '../lib/folders.js';
  import { type Location, allLocations } from '../lib/locations.js';
  import { DEFAULT_TEMPLATE, TEMPLATES, templateFiles } from '../lib/templates.js';
  import { type LocalProject, createLocalProject, listLocalProjects } from '../lib/local-projects.js';
  import LocalProjectActions from '../components/LocalProjectActions.svelte';
  import { ChevronRight, CloudUpload, FolderOpen, Link, Lock, Plus, Search } from '../ui/icons.js';
  import Dialog from '../ui/Dialog.svelte';
  import Icon from '../ui/Icon.svelte';

  let projects = $state<ProjectInfo[]>([]);
  /** Projects that exist only on this computer (local mode). */
  let localProjects = $state<LocalProject[]>(listLocalProjects());
  let loading = $state(true);
  let error = $state('');

  // list controls
  let tab = $state<'all' | 'owned' | 'shared'>('all');
  let sort = $state<'opened' | 'name'>('opened');
  let filter = $state('');

  // create
  let showNew = $state(false);
  let template = $state(DEFAULT_TEMPLATE);
  let slug = $state('');
  let password = $state('');
  let unprotected = $state(false);
  let creating = $state(false);

  // join
  let showJoin = $state(false);
  let joinSlug = $state('');
  let joinPassword = $state('');
  let joining = $state(false);

  // import
  let importFiles = $state<File[]>([]);
  let importIsFolder = $state(false);
  let archiveInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();

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

  const counts = $derived({
    all: projects.length,
    owned: projects.filter((p) => p.role === 'owner').length,
    shared: projects.filter((p) => p.role !== 'owner').length,
  });

  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const list = projects.filter((p) => (tab === 'all' || (tab === 'owned') === (p.role === 'owner')) && (!q || p.slug.toLowerCase().includes(q)));
    if (sort === 'name') return [...list].sort((a, b) => a.slug.localeCompare(b.slug));
    // The server returns the account's projects most recently opened first; keep that order.
    return list;
  });

  const ROLE_LABEL: Record<string, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };

  function openNew() {
    error = '';
    showNew = true;
  }

  function openJoin() {
    error = '';
    showJoin = true;
  }

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
      showJoin = true;
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

  async function createFromFolder() {
    if (!fromFolder) return;
    error = '';
    creating = true;
    try {
      const id = auth.local
        ? createLocalProject(fromSlug.trim() || fromFolder.label).id
        : (
            await api<{ project: ProjectInfo }>('POST', '/projects', {
              slug: fromSlug.trim(),
              ...(fromUnprotected ? { passwordProtected: false } : { password: fromPassword }),
            })
          ).project.id;
      await rememberFolder(id, fromFolder);
      markFreshFolderProject(id);
      go(`/p/${id}`);
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
  const cacheKey = 'hivetex.projects';

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
  onMount(() =>
    registerCommands([
      { id: 'new-project', title: 'New project', group: 'Project', icon: Plus, aliases: ['create', 'template'], run: openNew },
      { id: 'join-project', title: 'Join a project with its ID', group: 'Project', icon: Link, aliases: ['join', 'invitation'], run: openJoin },
      ...(folders ? [{ id: 'open-folder', title: 'Open a folder as a project', group: 'Project' as const, icon: FolderOpen, aliases: ['folder', 'git clone'], run: () => void openFolder() }] : []),
    ]),
  );

  onMount(() => {
    loaded = load();
    void allLocations()
      .then((l) => (locations = l))
      .catch(() => {});
  });

  async function create() {
    error = '';
    creating = true;
    try {
      // Read the template before creating, so a failure leaves no half-made project.
      const chosen = importFiles.length ? null : TEMPLATES.find((t) => t.id === template && t.id !== 'blank');
      const files = chosen ? await templateFiles(chosen.id) : null;
      // Local mode: the project exists only on this computer (no request is made).
      const id = auth.local
        ? createLocalProject(slug.trim() || (chosen ? `${chosen.name} paper` : 'Untitled paper')).id
        : (
            await api<{ project: ProjectInfo }>('POST', '/projects', {
              ...(slug.trim() ? { slug: slug.trim() } : {}),
              ...(unprotected ? { passwordProtected: false } : { password }),
            })
          ).project.id;
      markCreatedHere(id);
      if (createFolder) {
        await rememberFolder(id, createFolder);
        markFreshFolderProject(id);
      }
      pendingImport = importRequest();
      pendingTemplate = chosen && files ? { files, main: chosen.main } : null;
      go(`/p/${id}`);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not create project';
    } finally {
      creating = false;
    }
  }

  async function join() {
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

  /** Template chosen on the "new project" form; written by the workspace into the new, empty project. */
  export let pendingTemplate: { files: Map<string, string>; main: string } | null = null;
  export function takePendingTemplate() {
    const t = pendingTemplate;
    pendingTemplate = null;
    return t;
  }
</script>

<div class="page projects">
  <div class="title">
    <h1>Your projects</h1>
    <div class="actions">
      {#if folders}
        <button type="button" onclick={openFolder} data-testid="open-folder" data-tip="Open a folder on this device (for example a git clone) as a project"><Icon icon={FolderOpen} />Open folder…</button>
      {/if}
      {#if !auth.local}<button type="button" onclick={openJoin} data-testid="join-btn"><Icon icon={Link} />Join with ID</button>{/if}
      <button type="button" class="primary" onclick={openNew} data-testid="new-project-btn"><Icon icon={Plus} />New project</button>
    </div>
  </div>
  {#if !folders}
    <p class="muted unsupported" data-testid="folders-unsupported">Opening folders from your disk needs the desktop app or a Chromium browser (Chrome, Edge). Here, projects live in the app; you can import a folder or a .zip when you create a project.</p>
  {/if}

  {#if error && !showNew && !showJoin && !fromFolder}<div class="error" role="alert">{error}</div>{/if}
  {#if folderMessage && !showJoin}<div class="notice" role="status" data-testid="folder-message">{folderMessage}</div>{/if}
  {#if auth.offline}
    <div class="notice">You are offline. Projects stored on this device still open and can be edited.</div>
  {/if}

  {#if localProjects.length}
    <section class="local" aria-labelledby="local-title" data-testid="local-projects">
      <h2 id="local-title">On this computer</h2>
      <p class="muted">Only on this computer: nothing is shared or sent anywhere.{auth.local ? ' Sign in to share one with co-authors.' : ''}</p>
      <div class="list">
        {#each localProjects as lp (lp.id)}
          <div class="item local-item" data-testid="local-project">
            <a class="main" href={`#/p/${lp.id}`}><strong class="slug">{lp.name}</strong></a>
            {#if locations[lp.id]?.kind === 'folder'}
              <span class="pill" data-testid="folder-badge"><Icon icon={FolderOpen} size={13} />{(locations[lp.id] as Location & { label: string }).label}</span>
            {/if}
            {#if !auth.local}<LocalProjectActions project={lp} onDone={() => (localProjects = listLocalProjects())} />{/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  {#if loading && !auth.local}
    <p class="muted">Loading…</p>
  {:else if auth.local}
    {#if !localProjects.length}
      <div class="empty">
        <h2>Start your first paper</h2>
        <p>Pick a template that already compiles. Your projects stay on this computer until you sign in and share them.</p>
        <div class="actions"><button type="button" class="primary" onclick={openNew}><Icon icon={Plus} />New project</button></div>
      </div>
    {/if}
  {:else if projects.length === 0}
    <div class="empty">
      <div class="art" aria-hidden="true"><span><i class="t"></i><i></i><i></i><i class="h"></i><i></i><i></i></span></div>
      <h2>Start your first paper</h2>
      <p>Pick a template that already compiles, or join a co-author's project with the ID and password they sent you.</p>
      <div class="actions">
        <button type="button" class="primary" onclick={openNew}><Icon icon={Plus} />New project</button>
        <button type="button" onclick={openJoin}><Icon icon={Link} />Join with ID</button>
      </div>
    </div>
  {:else}
    <div class="controls">
      <div class="tabs" role="group" aria-label="Show">
        {#each [['all', 'All'], ['owned', 'Owned by me'], ['shared', 'Shared with me']] as const as [k, label] (k)}
          <button type="button" class="tab" aria-pressed={tab === k} onclick={() => (tab = k)}>{label} <span class="count">{counts[k]}</span></button>
        {/each}
      </div>
      <div class="filter">
        <Icon icon={Search} />
        <input type="search" aria-label="Filter projects" placeholder="Filter projects" bind:value={filter} />
      </div>
      <label class="sort">Sort
        <select bind:value={sort}>
          <option value="opened">Last opened</option>
          <option value="name">Name</option>
        </select>
      </label>
    </div>

    <div class="list" data-testid="project-list">
      {#each shown as p (p.id)}
        <a class="item" href={`#/p/${p.id}`}>
          <span class="thumb" aria-hidden="true"><i class="t"></i><i></i><i></i><i></i></span>
          <span class="main">
            <strong class="slug">{p.slug}</strong>
            <span class="meta">
              {#if p.passwordProtected}<span class="badge" data-tip="Password protected"><Icon icon={Lock} size={13} /><span class="sr-only">Password protected</span></span>{/if}
              {#if locations[p.id]?.kind === 'folder'}
                {@const label = (locations[p.id] as Location & { label: string }).label}
                <span class="pill" data-tip={`Files are in the folder ${label} on this device`} data-testid="folder-badge"><Icon icon={FolderOpen} size={13} />{label}</span>
              {/if}
              {#if p.githubRepo}<span class="pill ok" data-tip={`Backed up to GitHub: ${p.githubRepo}`}><Icon icon={CloudUpload} size={13} />Backed up</span>{/if}
            </span>
          </span>
          <span class="pill role {p.role}">{ROLE_LABEL[p.role] ?? p.role}</span>
          <span class="when">{#if p.lastOpenedAt}<small data-testid="opened-ago" title={new Date(p.lastOpenedAt).toLocaleString()}>opened {ago(p.lastOpenedAt)}</small>{/if}</span>
          <Icon icon={ChevronRight} class="go" />
        </a>
      {:else}
        <p class="muted none">No projects match “{filter}”.</p>
      {/each}
    </div>
  {/if}
</div>

{#if showNew}
  <Dialog title="New project" size="xl" onClose={() => (showNew = false)} onsubmit={create} testid="new-project-dialog">
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    {#if importFiles.length === 0}
      <TemplateGallery bind:value={template} />
    {/if}
    {#if auth.local}
      <div class="field">
        <label for="np-slug">Name</label>
        <input id="np-slug" type="text" bind:value={slug} placeholder="my-paper-2026" />
        <p class="hint">Kept on this computer. When you share it later, you choose its project ID and password.</p>
      </div>
    {:else}
    <div class="two">
      <div class="field">
        <label for="np-slug">Project ID</label>
        <input id="np-slug" type="text" bind:value={slug} placeholder="my-paper-2026" aria-describedby="np-slug-hint" />
        <p class="hint" id="np-slug-hint">Co-authors type this to join. 6–48 characters (a–z, 0–9, -); leave empty for a random one.</p>
      </div>
      <div class="field">
        <label for="np-pw">Join password</label>
        <input id="np-pw" type="password" bind:value={password} disabled={unprotected} required={!unprotected} minlength="8" autocomplete="new-password" aria-describedby="np-pw-hint" />
        <p class="hint" id="np-pw-hint"><Icon icon={Lock} size={13} />Co-authors need the ID and this password to join.</p>
        <label class="check"><input type="checkbox" bind:checked={unprotected} /> No password (anyone with the ID can join)</label>
      </div>
    </div>
    {/if}
    {#if folders}
      <fieldset class="where">
        <legend>Where to keep the files on this device</legend>
        <label class="check"><input type="radio" name="where" checked={!createFolder} onchange={() => (createFolder = null)} /> In the app</label>
        <label class="check"><input type="radio" name="where" checked={!!createFolder} onclick={chooseCreateFolder} data-testid="create-in-folder" />
          {createFolder ? `In the folder “${createFolder.label}”` : 'In a folder…'}</label>
        {#if createFolder}<p class="hint">Edit the files there with any tool (Claude Code, Codex, an editor); changes sync with everyone.</p>{/if}
      </fieldset>
    {/if}
    <details class="sources" open={importFiles.length > 0}>
      <summary>Start from existing sources instead</summary>
      <p class="hint">An Overleaf or GitHub .zip, an arXiv .tar.gz, or a folder. The template is not used when you import.</p>
      <div class="two">
        <div class="field">
          <label for="np-archive">Archive</label>
          <input id="np-archive" bind:this={archiveInput} type="file" accept={ARCHIVE_ACCEPT} onchange={(e) => pickImport(e, false)} data-testid="create-archive" />
        </div>
        <div class="field">
          <label for="np-folder">…or folder</label>
          <input id="np-folder" bind:this={folderInput} type="file" webkitdirectory onchange={(e) => pickImport(e, true)} data-testid="create-folder" />
        </div>
      </div>
    </details>
    {#snippet footer()}
      <button type="button" onclick={() => (showNew = false)}>Cancel</button>
      <button class="primary" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create project'}</button>
    {/snippet}
  </Dialog>
{/if}

{#if showJoin}
  <Dialog title="Join a project" size="sm" onClose={() => ((showJoin = false), (joinFolder = null), (folderMessage = ''))} onsubmit={join} testid="join-dialog">
    {#if folderMessage}<div class="notice" role="status" data-testid="folder-message">{folderMessage}</div>{/if}
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    <p class="muted intro">Ask the project's owner for its ID and password.</p>
    <div class="field">
      <label for="join-slug">Project ID</label>
      <input id="join-slug" type="text" bind:value={joinSlug} required data-autofocus={joinSlug ? undefined : ''} />
    </div>
    <div class="field">
      <label for="join-pw">Project password</label>
      <input id="join-pw" type="password" bind:value={joinPassword} autocomplete="off" data-autofocus={joinSlug ? '' : undefined} />
    </div>
    {#snippet footer()}
      <button type="button" onclick={() => (showJoin = false)}>Cancel</button>
      <button class="primary" type="submit" disabled={joining}>Join</button>
    {/snippet}
  </Dialog>
{/if}

{#if fromFolder}
  <Dialog title={`New project from “${fromFolder.label}”`} onClose={() => (fromFolder = null)} onsubmit={createFromFolder} testid="from-folder">
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    <p class="muted intro">The project gets this folder's files and tree, and stays in sync with it: edits made here or by any tool in the folder reach every collaborator.</p>
    {#if auth.local}
      <div class="field">
        <label for="ff-slug">Name</label>
        <input id="ff-slug" type="text" bind:value={fromSlug} data-testid="from-folder-slug" />
        <p class="hint">Kept on this computer until you sign in and share it.</p>
      </div>
    {:else}
    <div class="field">
      <label for="ff-slug">Project ID</label>
      <input id="ff-slug" type="text" bind:value={fromSlug} required pattern="[a-z0-9-]{'{'}6,48{'}'}" data-testid="from-folder-slug" aria-describedby="ff-slug-hint" />
      <p class="hint" id="ff-slug-hint">6–48 characters (a–z, 0–9, -)</p>
    </div>
    <div class="field">
      <label for="ff-pw">Project password</label>
      <input id="ff-pw" type="password" bind:value={fromPassword} disabled={fromUnprotected} required={!fromUnprotected} minlength="8" autocomplete="new-password" data-testid="from-folder-password" aria-describedby="ff-pw-hint" />
      <p class="hint" id="ff-pw-hint">Collaborators need it to join.</p>
      <label class="check"><input type="checkbox" bind:checked={fromUnprotected} /> No password (anyone with the ID can join)</label>
    </div>
    {/if}
    {#snippet footer()}
      <button type="button" onclick={() => (fromFolder = null)}>Cancel</button>
      <button class="primary" type="submit" disabled={creating} data-testid="from-folder-create">Create project</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .projects {
    width: min(1040px, 100%);
    padding: 32px clamp(16px, 4vw, 40px) 48px;
    display: grid;
    gap: 18px;
    align-content: start;
  }
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }
  h1 {
    margin: 0 auto 0 0;
    font: 600 28px/1.2 var(--font-ui);
    letter-spacing: -0.01em;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .unsupported {
    margin: -8px 0 0;
    font-size: var(--text-sm);
    max-width: 70ch;
  }
  .error,
  .notice {
    padding: 8px 12px;
    margin: 0;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
    border-bottom: 1px solid var(--line);
    padding-bottom: 10px;
  }
  .tabs {
    display: flex;
    gap: 4px;
    margin-right: auto;
  }
  .tab {
    min-height: 30px;
    border-color: transparent;
    background: transparent;
    color: var(--muted);
  }
  .tab[aria-pressed='true'] {
    background: var(--surface);
    border-color: var(--line);
    color: var(--ink);
    box-shadow: var(--shadow-1);
  }
  .count {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-weight: 400;
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 10px;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-m);
    background: var(--surface);
    color: var(--muted);
  }
  .filter input {
    border: 0;
    min-height: 32px;
    width: 180px;
    padding-left: 0;
    background: transparent;
  }
  .filter input:focus-visible {
    outline: none;
  }
  .filter:focus-within {
    outline: 2px solid var(--honey-ink);
    outline-offset: 1px;
  }
  .sort {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
    font-size: var(--text-sm);
  }
  .sort select {
    width: auto;
    min-height: 32px;
  }
  .list {
    display: grid;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-l);
    overflow: hidden;
  }
  .list .item {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) auto 130px 16px;
    gap: 16px;
    align-items: center;
    padding: 12px 16px;
    border: 0;
    border-radius: 0;
    background: none;
    color: inherit;
    text-decoration: none;
  }
  .list .item + .item {
    border-top: 1px solid var(--line);
  }
  .list .item:hover {
    background: var(--sunken);
  }
  .list .item:focus-visible {
    outline-offset: -2px;
  }
  .thumb {
    width: 40px;
    height: 50px;
    padding: 7px 6px;
    display: grid;
    gap: 3px;
    align-content: start;
    background: var(--pdf-paper);
    border: 1px solid var(--line);
    border-radius: 3px;
  }
  .thumb i {
    display: block;
    height: 2px;
    background: #cdd0d7;
  }
  .thumb i.t {
    height: 3px;
    width: 70%;
    justify-self: center;
    background: #6b7080;
  }
  .main {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .slug {
    font-weight: 600;
    font-size: 15px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    color: var(--muted);
    min-height: 20px;
  }
  .meta .pill {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    display: inline-flex;
    color: var(--muted);
  }
  .when {
    color: var(--muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .projects :global(.go) {
    color: var(--faint);
  }
  .none {
    padding: 16px;
    margin: 0;
  }
  .empty {
    display: grid;
    justify-items: center;
    text-align: center;
    gap: 10px;
    padding: 48px 16px;
    border: 1px dashed var(--line-strong);
    border-radius: var(--r-l);
    background: var(--surface);
  }
  .empty h2 {
    margin: 8px 0 0;
    font-size: var(--text-xl);
  }
  .empty p {
    margin: 0 0 8px;
    color: var(--muted);
    max-width: 52ch;
  }
  .art {
    display: grid;
    place-items: center;
    width: 96px;
    height: 96px;
    border-radius: 50%;
    background: var(--honey-soft);
  }
  .art span {
    width: 46px;
    height: 58px;
    padding: 8px 7px;
    display: grid;
    gap: 3px;
    align-content: start;
    background: var(--pdf-paper);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.18);
  }
  .art i {
    display: block;
    height: 2px;
    background: #cdd0d7;
  }
  .art i.t {
    height: 3px;
    width: 70%;
    justify-self: center;
    background: #6b7080;
  }
  .art i.h {
    width: 45%;
    background: #8a8f9b;
    margin-top: 2px;
  }
  .two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 16px;
  }
  .field {
    display: grid;
    gap: 6px;
    align-content: start;
  }
  .field > label {
    font-weight: 500;
    font-size: var(--text-sm);
  }
  .hint {
    margin: 0;
    font-size: 12.5px;
    color: var(--muted);
    display: flex;
    gap: 5px;
    align-items: center;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-sm);
  }
  .where {
    margin: 0;
    padding: 0;
    border: 0;
    display: grid;
    gap: 6px;
  }
  .where legend {
    padding: 0;
    margin-bottom: 4px;
    font-weight: 500;
    font-size: var(--text-sm);
  }
  .sources {
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .sources summary {
    cursor: pointer;
    font-weight: 500;
    font-size: var(--text-sm);
    color: var(--honey-ink);
  }
  .sources[open] {
    display: grid;
    gap: 10px;
  }
  .intro {
    margin: 0;
  }
  @media (max-width: 720px) {
    .list .item {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px 12px;
    }
    .thumb,
    .projects :global(.go) {
      display: none;
    }
    .when {
      grid-column: 1 / -1;
      text-align: left;
    }
    .filter input {
      width: 120px;
    }
  }
</style>
