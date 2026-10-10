<script lang="ts">
  import { type PdfPosition, forwardSearch, parseSyncTeXGz, reverseSearch } from '@hivetex/compile';
  import type { FileEntry, HistorySnapshot } from '@hivetex/sync';
  import { onDestroy, onMount } from 'svelte';
  import ChangesPanel from '../components/ChangesPanel.svelte';
  import FileTree from '../components/FileTree.svelte';
  import ImportDialog, { type ImportRequest } from '../components/ImportDialog.svelte';
  import ProjectSettings from '../components/ProjectSettings.svelte';
  import Editor from '../components/Editor.svelte';
  import PdfView from '../components/PdfView.svelte';
  import { ApiError, api, isDesktop } from '../lib/api.js';
  import { folderAccessSupported, pickDirectory } from '../lib/fs-access.js';
  import { auth } from '../lib/auth.svelte.js';
  import { type ProjectIndex, buildIndex, emptyIndex } from '../lib/latex.js';
  import { go } from '../lib/router.svelte.js';
  import { type Match, replaceProject, searchProject } from '../lib/search.js';
  import { ProjectSession, type ProjectInfo } from '../lib/session.svelte.js';
  import { type LooseItem, isArchiveName, readLoose } from '../lib/import/sources.js';
  import { exportZip } from '../lib/import/zip.js';
  import { takePendingImport } from './Projects.svelte';
  import { takeFreshFolderProject } from '../lib/folders.js';

  let { projectId }: { projectId: string } = $props();

  let session = $state<ProjectSession | null>(null);
  let error = $state('');
  let activeId = $state<string | null>(null);
  let index: ProjectIndex = emptyIndex();
  let showSettings = $state(false);
  let showHistory = $state(false);
  let showChanges = $state(false);
  let showSearch = $state(false);
  let showPdf = $state(false);
  let snapshots = $state<HistorySnapshot[]>([]);
  let jump = $state<{ line: number; n: number } | null>(null);
  let highlight = $state<PdfPosition | null>(null);
  let toast = $state('');
  let indexTimer: ReturnType<typeof setTimeout> | null = null;
  let query = $state('');
  let replacement = $state('');
  let matches = $state<Match[]>([]);
  let searchOpts = $state({ caseSensitive: false, regex: false, wholeWord: false });
  let compileError = $state('');
  let importRequest = $state<ImportRequest | null>(null);

  const mainPath = $derived(session ? String(session.model.settings.get('main') ?? 'main.tex') : 'main.tex');
  const active = $derived(session?.files.find((f) => f.id === activeId) ?? null);
  const diagnostics = $derived(
    (session?.result?.diagnostics ?? []).filter((d) => !active || d.file === active.path || d.file === '' ),
  );
  let settingsTick = $state(0);

  function say(msg: string) {
    toast = msg;
    setTimeout(() => {
      if (toast === msg) toast = '';
    }, 3500);
  }

  onMount(async () => {
    try {
      if (!auth.user) return;
      let info: ProjectInfo | undefined;
      try {
        const r = await api<{ project: ProjectInfo }>('GET', `/projects/${projectId}`);
        info = r.project;
        localStorage.setItem(`hivetex.proj.${projectId}`, JSON.stringify(info));
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) {
          const raw = localStorage.getItem(`hivetex.proj.${projectId}`);
          if (raw) info = JSON.parse(raw) as ProjectInfo;
        } else throw e;
      }
      if (!info) throw new Error('Project not found on this device');
      // Account recents (best effort: offline opens are simply not recorded).
      void api('POST', `/projects/${projectId}/opened`).catch(() => {});
      const s = new ProjectSession(info, auth.user);
      await s.open();
      session = s;
      if (localStorage.getItem('hivetex.test') === '1') (window as unknown as { __p2p: unknown }).__p2p = {
          session: s,
          compile: { parseSyncTeXGz, forwardSearch, reverseSearch },
          // e2e: simulate an external tool editing the bound folder (same origin the folder mirror uses)
          folderEdit: async (path: string, text: string) => {
            const { applyTextDiff, MIRROR_ORIGIN } = await import('@hivetex/sync');
            const f = s.model.find(path);
            if (f) applyTextDiff(await s.model.openText(f.id), text, MIRROR_ORIGIN);
          },
        };
      s.model.onFilesChanged(() => scheduleIndex());
      s.model.onDocUpdate(() => scheduleIndex());
      scheduleIndex();
      const pending = takePendingImport();
      if (pending && s.canWrite) importRequest = pending;
      // Created from a folder: its files were imported when the folder was bound; pick main and engine from them.
      if (takeFreshFolderProject(s.project.id) && s.canWrite) {
        const main = await s.detectMainAndEngine().catch(() => null);
        if (main) say(`Main document: ${main}`);
      }
      const first = s.model.find(String(s.model.settings.get('main') ?? 'main.tex')) ?? s.files.find((f) => f.kind === 'text');
      if (first) activeId = first.id;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not open the project';
    }
  });

  onDestroy(() => {
    if (indexTimer) clearTimeout(indexTimer);
    void session?.close();
  });

  function scheduleIndex() {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(async () => {
      if (!session) return;
      const files = [];
      for (const f of session.model.list()) {
        files.push({
          path: f.path,
          kind: f.kind,
          ...(f.kind === 'text' ? { text: (await session.model.openText(f.id)).toString() } : {}),
        });
      }
      index = buildIndex(files);
    }, 400);
  }

  /**
   * Uploads and drops go through the import pipeline: a single archive asks whether to extract it; files that would
   * overwrite something (or were skipped) open the preview; anything else is added straight away.
   */
  async function onUpload(load: () => Promise<{ items: LooseItem[]; hasFolder: boolean }>, dir: string) {
    if (!session?.canWrite) return;
    try {
      const { items, hasFolder } = await load();
      if (items.length === 0) return;
      const only = items.length === 1 ? (items[0] as LooseItem) : null;
      if (only && !hasFolder && isArchiveName(only.path)) {
        importRequest = { kind: 'archive-choice', item: only, dir };
        return;
      }
      const name = only ? only.path : `${items.length} files`;
      const bundle = await readLoose(name, items, { stripRoot: false, ...(dir ? { prefix: dir } : {}) });
      const plan = await session.planImport(bundle);
      if (plan.changed.length > 0 || bundle.skipped.length > 0 || bundle.files.length === 0) {
        importRequest = { kind: 'load', name, load: async () => bundle };
        return;
      }
      const r = await session.applyImport(plan, { mode: 'merge', resolutions: new Map(), defaultResolution: 'keep' });
      say(`Added ${r.added} file${r.added === 1 ? '' : 's'}`);
    } catch (e) {
      say(e instanceof Error ? e.message : 'Upload failed');
    }
  }

  function importClosed(r?: { mainPath?: string }) {
    importRequest = null;
    settingsTick++;
    if (!session || !r) return;
    if (!activeId || !session.files.some((f) => f.id === activeId)) {
      const first = (r.mainPath && session.model.find(r.mainPath)) || session.files.find((f) => f.kind === 'text');
      if (first) activeId = first.id;
    }
  }

  async function onCreate(path: string, kind: 'file' | 'folder') {
    if (!session) return;
    if (session.model.find(path)) return say(`"${path}" already exists`);
    try {
      if (kind === 'folder') session.model.createDir(path);
      else {
        const starter = path.endsWith('.tex') && !session.files.some((f) => f.kind === 'text') ? '\\documentclass{article}\n\\begin{document}\nHello!\n\\end{document}\n' : '';
        activeId = await session.model.createTextNow(path, starter);
      }
    } catch (e) {
      say(e instanceof Error ? e.message : 'Could not create the file');
    }
  }

  function onRename(f: FileEntry, to: string) {
    if (!session) return;
    if (f.kind === 'dir') session.model.renameTree(f.path, to);
    else session.model.rename(f.id, to);
    if (session.model.settings.get('main') === f.path) session.model.settings.set('main', to);
  }

  function onDelete(f: FileEntry) {
    if (!session) return;
    if (f.kind === 'dir') for (const c of session.files.filter((x) => x.path.startsWith(`${f.path}/`))) session.model.delete(c.id);
    session.model.delete(f.id);
    if (activeId === f.id) activeId = session.files.find((x) => x.kind === 'text')?.id ?? null;
  }

  async function download(name: string, bytes: Uint8Array, type = 'application/octet-stream') {
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function downloadFile(f: FileEntry) {
    if (!session || !f.hash) return;
    await download(f.path.split('/').pop() ?? 'file', await session.blobs.fetch(f.hash, 20_000));
  }

  async function downloadZip() {
    if (!session) return;
    await session.mesh.prefetchAll();
    const zip = await exportZip(session.model, (h) => session!.blobs.fetch(h, 20_000));
    await download(`${session.project.slug}.zip`, zip, 'application/zip');
  }

  async function compileNow() {
    compileError = '';
    if (!session) return;
    try {
      session.requestCompile();
    } catch (e) {
      compileError = e instanceof Error ? e.message : String(e);
    }
  }

  async function compileLocal() {
    compileError = '';
    try {
      await session?.compileLocal();
    } catch (e) {
      compileError = e instanceof Error ? e.message : String(e);
    }
  }

  function openFile(f: FileEntry) {
    if (f.kind === 'text') activeId = f.id;
    else if (f.kind === 'binary') {
      activeId = f.id;
    }
  }

  function setMain(f: FileEntry) {
    session?.model.settings.set('main', f.path);
    settingsTick++;
  }

  function forward(line: number) {
    if (!session?.syncIndex || !active) return say('SyncTeX data is not available for this PDF');
    const pos = forwardSearch(session.syncIndex, active.path, line);
    if (pos) highlight = { ...pos };
    else say('No matching position in the PDF');
  }

  function reverse(file: string, line: number) {
    const f = session?.files.find((x) => x.path === file || x.path.endsWith(`/${file}`) || file.endsWith(`/${x.path}`));
    if (!f) return;
    activeId = f.id;
    jump = { line, n: (jump?.n ?? 0) + 1 };
  }

  function showDiag(file: string, line: number) {
    reverse(file, line);
  }

  async function runSearch() {
    if (!session || !query) {
      matches = [];
      return;
    }
    await session.mesh.prefetchAll();
    matches = await searchProject(session.model, query, searchOpts);
  }

  async function runReplace() {
    if (!session || !query) return;
    const n = await replaceProject(session.model, query, replacement, searchOpts);
    say(`Replaced ${n} occurrence${n === 1 ? '' : 's'}`);
    await runSearch();
  }

  async function openHistory() {
    if (!session) return;
    await session.model.captureSnapshot();
    snapshots = (await session.store.listSnapshots()).slice().reverse();
    showHistory = true;
  }

  async function restore(id: string) {
    if (!session) return;
    await session.model.restore(id);
    showHistory = false;
    say('Restored. The state before the restore was saved too, so you can undo it from History.');
  }

  async function copyId() {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.project.slug);
      say('Project ID copied');
    } catch {
      say(`Project ID: ${session.project.slug}`);
    }
  }

  async function loadFromGithub() {
    if (!session?.project.githubRepo) return;
    try {
      const n = await session.importFromGithub(session.project.githubRepo);
      say(`Loaded ${n} files from GitHub`);
      const first = session.model.find(String(session.model.settings.get('main') ?? 'main.tex')) ?? session.files.find((f) => f.kind === 'text');
      if (first) activeId = first.id;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  let showLocation = $state(false);
  const canUseFolders = isDesktop || folderAccessSupported();

  /** Makes a folder of the user's choice this project's location on this device. */
  async function linkFolder() {
    showLocation = false;
    if (!session) return;
    try {
      if (isDesktop) {
        const { pickFolder } = await import('../lib/tauri-fs.js');
        const dir = await pickFolder('Choose the folder for this project');
        if (!dir) return;
        await session.bindFolder({ desktopPath: dir });
      } else {
        const handle = await pickDirectory();
        if (!handle) return;
        await session.bindFolder({ handle });
      }
      say(`Project files are now in the folder "${session.mirrorDir}"`);
    } catch (e) {
      say(`Could not use that folder: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function unlinkFolder() {
    showLocation = false;
    const label = session?.mirrorDir;
    await session?.unbindFolder();
    if (label) say(`Stopped using "${label}". The files there were left as they are.`);
  }

  async function allowFolder() {
    try {
      if (!(await session?.allowFolderAccess())) say('Access to the folder was not granted');
    } catch (e) {
      say(`Could not re-open the folder: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function downloadPdf() {
    if (session?.pdf) await download(`${session.project.slug}.pdf`, session.pdf, 'application/pdf');
  }

  const isImage = (p: string) => /\.(png|jpe?g|gif|svg|webp)$/i.test(p);
  let imageUrl = $state('');
  $effect(() => {
    const f = active;
    imageUrl = '';
    if (f?.kind === 'binary' && f.hash && isImage(f.path) && session) {
      session.blobs.fetch(f.hash, 15_000).then((b) => {
        if (active?.id === f.id) imageUrl = URL.createObjectURL(new Blob([b as unknown as BlobPart]));
      }).catch(() => {});
    }
  });
</script>

{#if error}
  <div class="page"><div class="error" role="alert">{error}</div><a href="#/">← Back to projects</a></div>
{:else if !session}
  <div class="page"><p class="muted">Opening project…</p></div>
{:else}
  {@const s = session}
  <div class="workspace" class:show-pdf={showPdf} data-testid="workspace">
    <div class="toolbar">
      <a href="#/" aria-label="All projects">←</a>
      <strong data-testid="project-slug">{s.project.slug}</strong>
      <span class={`pill ${s.role}`} data-testid="role-pill">{s.role}</span>
      <button class="small" onclick={copyId} title="Copy the project ID to share it">Share ID</button>
      <span class="spacer"></span>
      <button class="primary small" onclick={compileNow} data-testid="compile-btn" disabled={s.compileStatus === 'compiling'}>
        {s.compileStatus === 'compiling' ? 'Compiling…' : 'Recompile'}
      </button>
      {#if s.engine}<button class="small" onclick={compileLocal} title="Compile on this device only; does not share the result">Compile here</button>{/if}
      {#if canUseFolders}
        <span class="location">
          {#if s.folderPending}
            <button class="small primary" onclick={allowFolder} data-testid="allow-folder" title={`Let the app read and write "${s.location.kind === 'folder' ? s.location.label : ''}" again`}>Allow access to “{s.location.kind === 'folder' ? s.location.label : ''}”</button>
          {/if}
          <button class="small" onclick={() => (showLocation = !showLocation)} aria-expanded={showLocation} aria-haspopup="menu" data-testid="location-btn" title="Where this project's files live on this device">
            {s.mirrorDir ? `📁 ${s.mirrorDir}` : 'In the app'} ▾
          </button>
          {#if showLocation}
            <div class="location-menu" role="menu" data-testid="location-menu">
              {#if s.mirrorDir}
                <p class="muted">Files are in the folder <strong>{s.mirrorDir}</strong>. Edit them with any tool (Claude Code, Codex, an editor): changes sync with everyone.</p>
                {#if isDesktop}<button role="menuitem" class="small" onclick={() => { showLocation = false; void s.revealFolder(); }}>Show in file manager</button>{/if}
                <button role="menuitem" class="small" onclick={linkFolder} data-testid="link-folder">Use another folder…</button>
                <button role="menuitem" class="small" onclick={unlinkFolder} data-testid="unlink-folder">Stop using the folder</button>
              {:else}
                <p class="muted">Files are stored in the app on this device. Put them in a folder to edit them with Claude Code, Codex or any editor.</p>
                <button role="menuitem" class="small" onclick={linkFolder} data-testid="link-folder">Use a folder…</button>
              {/if}
            </div>
          {/if}
        </span>
      {/if}
      <button class="small" onclick={() => (showSearch = !showSearch)} aria-pressed={showSearch}>Search</button>
      <button class="small" onclick={() => (showChanges = true)} data-testid="changes-btn" title="What changed, who changed it, and undo">Changes{s.changes.length ? ` (${Math.min(s.changes.length, 99)})` : ''}</button>
      <button class="small" onclick={openHistory}>History</button>
      {#if s.canWrite}<button class="small" onclick={() => (importRequest = { kind: 'pick' })} data-testid="import-btn" title="Import an Overleaf/GitHub zip, an arXiv tarball, a folder or files">Import…</button>{/if}
      <button class="small" onclick={downloadZip}>Download .zip</button>
      <button class="small" onclick={downloadPdf} disabled={!s.pdf}>PDF</button>
      <button class="small" onclick={() => (showSettings = true)} data-testid="settings-btn">{s.role === 'owner' ? 'Project settings' : 'Settings'}</button>
      <button class="small show-narrow" onclick={() => (showPdf = !showPdf)}>{showPdf ? 'Editor' : 'PDF'}</button>
    </div>

    <div class="pane" style="display: grid; grid-template-rows: auto minmax(0, 1fr)">
      <div>
        {#if showSearch}
          <div class="searchpanel" data-testid="search-panel">
            <input type="search" placeholder="Search project" bind:value={query} oninput={runSearch} aria-label="Search project" />
            {#if s.canWrite}<input type="text" placeholder="Replace with" bind:value={replacement} aria-label="Replacement" />{/if}
            <div class="row wrap">
              <label class="row"><input type="checkbox" bind:checked={searchOpts.caseSensitive} onchange={runSearch} /> Aa</label>
              <label class="row"><input type="checkbox" bind:checked={searchOpts.wholeWord} onchange={runSearch} /> word</label>
              <label class="row"><input type="checkbox" bind:checked={searchOpts.regex} onchange={runSearch} /> .*</label>
              {#if s.canWrite}<button class="small" onclick={runReplace} disabled={!matches.length}>Replace all ({matches.length})</button>{/if}
            </div>
            <div style="max-height: 180px; overflow: auto">
              {#each matches.slice(0, 100) as m}
                <button class="hit" onclick={() => { activeId = m.fileId; jump = { line: m.line, n: (jump?.n ?? 0) + 1 }; }}><strong>{m.path}:{m.line}</strong> <span class="muted">{m.preview}</span></button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
      <FileTree
        files={s.files}
        activeId={activeId}
        canWrite={s.canWrite}
        mainPath={settingsTick >= 0 ? mainPath : ''}
        onOpen={openFile}
        {onCreate}
        {onRename}
        {onDelete}
        {onUpload}
        onDownload={downloadFile}
        onSetMain={setMain}
      />
    </div>

    <div class="pane editor-pane" style="min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr)">
      {#if active?.kind === 'text'}
        {#key active.id}
          <Editor session={s} fileId={active.id} readOnly={!s.canWrite} diagnostics={diagnostics} getIndex={() => index} jumpLine={jump} onForwardSearch={forward} />
        {/key}
      {:else if active?.kind === 'binary'}
        <div style="padding: 16px">
          <p class="muted">{active.path} ({active.size ?? 0} bytes)</p>
          {#if imageUrl}<img src={imageUrl} alt={active.path} style="max-width: 100%" />{:else}<p class="muted">No preview.</p>{/if}
        </div>
      {:else}
        <div style="padding: 16px">
          {#if s.files.length === 0 && s.noPeerOnline && s.project.githubRepo}
            <div class="notice" data-testid="bootstrap-banner">
              <strong>No collaborator is online.</strong> This project is backed up on GitHub ({s.project.githubRepo}).
              <div style="margin-top: 8px"><button class="primary" onclick={loadFromGithub} data-testid="load-github">Load the latest backup from GitHub</button></div>
              <p class="muted" style="margin-bottom: 0">You need access to the repository (connect GitHub in Project settings). Your copy merges with your collaborators' automatically when they come online.</p>
            </div>
          {:else}
            <p class="muted">Select or create a file to start writing.</p>
          {/if}
        </div>
      {/if}
    </div>

    <div class="pdf-pane pane" style="display: grid; grid-template-rows: minmax(0, 1fr) auto">
      <PdfView
        pdf={s.pdf}
        rev={s.pdfRev}
        stale={s.stale}
        compiledBy={s.compiledBy}
        syncIndex={s.syncIndex}
        {highlight}
        onReverse={reverse}
      />
      <div class="diag" data-testid="diagnostics">
        {#if compileError}<div class="error" style="margin: 6px">{compileError}</div>{/if}
        {#if s.result && !s.result.ok && s.result.diagnostics.length === 0}
          <div class="error" style="margin: 6px">Compilation failed. <details><summary>Log</summary><pre style="white-space: pre-wrap">{s.result.log.slice(-3000)}</pre></details></div>
        {/if}
        {#each s.result?.diagnostics ?? [] as d}
          <button onclick={() => showDiag(d.file, d.line)}>
            <span class={`sev-${d.severity}`}>{d.severity === 'error' ? '✖' : d.severity === 'warning' ? '▲' : 'ℹ'}</span>
            <span class="muted">{d.file}{d.line ? `:${d.line}` : ''}</span>
            <span>{d.message}</span>
          </button>
        {/each}
        {#if s.engineNote && !s.engine}<div class="notice" style="margin: 6px">{s.engineNote}</div>{/if}
      </div>
    </div>

    <div class="statusbar" data-testid="statusbar">
      <span data-testid="peer-count">{s.peers.length} peer{s.peers.length === 1 ? '' : 's'} online{s.peers.length ? `: ${s.peers.map((p) => p.uname).join(', ')}` : ''}</span>
      <span>·</span>
      <span data-testid="leader">compiler: {s.leaderName ?? 'none available'}</span>
      <span>·</span>
      <span>{s.engineKind === 'native' ? 'native TeX on this device' : s.engineKind === 'wasm' ? 'in-browser TeX' : 'no compiler here'}</span>
      {#if s.offline || s.paused}<span class="pill warn" data-testid="offline-pill">offline: editing locally, will merge when reconnected</span>{/if}
      <button class="small ghost" onclick={() => s.setPaused(!s.paused)} data-testid="pause-sync">{s.paused ? 'Resume sync' : 'Work offline'}</button>
      {#if s.noPeerOnline && !s.offline}<span class="pill">no collaborator online</span>{/if}
      {#if s.revoked}<span class="pill bad">you no longer have access</span>{/if}
      {#if s.mirrorDir}<span class="pill" title={`Files are in the folder ${s.mirrorDir}`}>folder</span>{/if}
      {#if s.mirrorNotice}<span class="pill warn" role="status">{s.mirrorNotice}</span>{/if}
      <span class="spacer"></span>
      <span class="muted">{s.compileStatus}</span>
    </div>
  </div>

  {#if toast}<div class="notice" role="status" style="position: fixed; right: 16px; bottom: 48px; box-shadow: var(--shadow)">{toast}</div>{/if}

  {#if importRequest}
    {#key importRequest}
      <ImportDialog session={s} request={importRequest} onClose={importClosed} />
    {/key}
  {/if}

  {#if showChanges}
    <ChangesPanel session={s} onClose={() => (showChanges = false)} />
  {/if}

  {#if showSettings}
    <ProjectSettings session={s} onClose={() => { showSettings = false; settingsTick++; }} onDeleted={() => go('/')} />
  {/if}

  {#if showHistory}
    <div class="dialog" role="dialog" aria-modal="true" aria-label="History">
      <div class="card">
        <div class="row"><h2 class="spacer">Local history</h2><button onclick={() => (showHistory = false)}>Close</button></div>
        <p class="muted">Snapshots are kept on this device only. Restoring is an ordinary edit that syncs to everyone and can be undone.</p>
        {#if snapshots.length === 0}<p class="muted">No snapshots yet.</p>{/if}
        <table>
          <tbody>
            {#each snapshots as sn}
              <tr>
                <td>{new Date(sn.at).toLocaleString()}</td>
                <td>{sn.files.length} files</td>
                <td style="text-align: right"><button class="small" disabled={!s.canWrite} onclick={() => restore(sn.id)}>Restore</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
{/if}

<style>
  .location {
    position: relative;
    display: inline-flex;
    gap: 4px;
  }
  .location-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    width: min(320px, 90vw);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.15);
  }
  .location-menu p {
    margin: 0 0 4px;
    font-size: 0.85em;
  }
</style>
