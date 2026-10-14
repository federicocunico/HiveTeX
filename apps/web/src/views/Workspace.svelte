<script lang="ts">
  import { type PdfPosition, forwardSearch, parseSyncTeXGz, reverseSearch } from '@hivetex/compile';
  import type { FileEntry } from '@hivetex/sync';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import ChangesPanel from '../components/ChangesPanel.svelte';
  import Editor from '../components/Editor.svelte';
  import FileTree from '../components/FileTree.svelte';
  import ImportDialog, { type ImportRequest } from '../components/ImportDialog.svelte';
  import PdfView from '../components/PdfView.svelte';
  import ProjectSettings from '../components/ProjectSettings.svelte';
  import ShareDialog from '../components/ShareDialog.svelte';
  import ConflictDialog from '../components/workspace/ConflictDialog.svelte';
  import BackupPanel from '../components/workspace/BackupPanel.svelte';
  import HistoryPanel from '../components/workspace/HistoryPanel.svelte';
  import OutlinePanel from '../components/workspace/OutlinePanel.svelte';
  import SyncPanel from '../components/workspace/SyncPanel.svelte';
  import NetworkDiagnostics from '../components/NetworkDiagnostics.svelte';
  import PeoplePanel from '../components/workspace/PeoplePanel.svelte';
  import FormatToolbar, { type FormatAction } from '../components/workspace/FormatToolbar.svelte';
  import PickerDialog from '../components/workspace/PickerDialog.svelte';
  import ProblemsPanel from '../components/workspace/ProblemsPanel.svelte';
  import SymbolPalette from '../components/workspace/SymbolPalette.svelte';
  import TableDialog from '../components/workspace/TableDialog.svelte';
  import Tour from '../components/workspace/Tour.svelte';
  import { tourWanted } from '../lib/tour.js';
  import SearchPanel from '../components/workspace/SearchPanel.svelte';
  import StatusBar from '../components/workspace/StatusBar.svelte';
  import { ApiError, api, apiBase, isDesktop } from '../lib/api.js';
  import { missingPackageHint } from '../lib/compile-mode.js';
  import { PAIR_MESSAGES } from '../lib/helper-engine.js';
  import { auth } from '../lib/auth.svelte.js';
  import { MigrationAssociationRequired, confirmLegacyAssociation, exportLegacyRecovery, type StoreRef } from '../lib/project-store.js';
  import { registerCommands, registerSource, setGotoLine } from '../lib/commands.svelte.js';
  import { openPalette, openShortcuts } from '../lib/palette.svelte.js';
  import { takeFreshFolderProject } from '../lib/folders.js';
  import { forgetLocalProject, getLocalProject, removeLocalProjectData, takePendingLink } from '../lib/local-projects.js';
  import { folderAccessSupported, pickDirectory } from '../lib/fs-access.js';
  import { type LooseItem, isArchiveName, readLoose } from '../lib/import/sources.js';
  import { exportProjectZip } from '../lib/import/zip.js';
  import { describeMissing } from '@hivetex/sync';
  import { type ProjectIndex, buildIndex, emptyIndex } from '../lib/latex.js';
  import { type Panel, SIDE_MAX, SIDE_MIN, SPLIT_MAX, SPLIT_MIN, layout, resetLayout, setLayout, togglePanel } from '../lib/layout.svelte.js';
  import { go } from '../lib/router.svelte.js';
  import { type ProjectInfo, ProjectSession } from '../lib/session.svelte.js';
  import { applyTemplate } from '../lib/templates.js';
  import { type OutlineEntry, buildOutline, currentHeading } from '../lib/outline.js';
  import { helpFor, preambleInsertLine } from '../lib/compile-help.js';
  import * as tex from '../lib/latex-insert.js';
  import { prefs, setPref } from '../lib/preferences.svelte.js';
  import {
    ArrowLeft,
    Bold,
    Eye,
    Image,
    Italic,
    Link,
    List,
    ListOrdered,
    Omega,
    Quote,
    Sigma,
    SquareSigma,
    Table,
    Changes,
    ChevronDown,
    CloudUpload,
    Download,
    Ellipsis,
    FileImage,
    FilePlus,
    Files,
    FileText,
    Copy,
    FolderInput,
    FolderOpen,
    FolderPlus,
    FolderSearch,
    SquareTerminal,
    Help,
    History,
    Keyboard,
    ListTree,
    Maximize,
    Minimize,
    PanelLeft,
    PanelRight,
    Pencil,
    Play,
    Search,
    Settings,
    Share,
    Users,
    RefreshCw,
    Wifi,
  } from '../ui/icons.js';
  import Dialog from '../ui/Dialog.svelte';
  import AvatarStack from '../ui/AvatarStack.svelte';
  import Icon from '../ui/Icon.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import Menu, { type MenuItem } from '../ui/Menu.svelte';
  import type { FolderAction } from '../lib/project-folder.js';
  import Splitter from '../ui/Splitter.svelte';
  import { toast } from '../ui/toast.svelte.js';
  import { takePendingImport, takePendingTemplate } from './Projects.svelte';

  let { projectId }: { projectId: string } = $props();

  let session = $state<ProjectSession | null>(null);
  let error = $state('');
  let migration = $state<MigrationAssociationRequired | null>(null);
  let activeId = $state<string | null>(null);
  let index = $state.raw<ProjectIndex>(emptyIndex());
  let outline = $state.raw<OutlineEntry[]>([]);
  /** Text of every text file, refreshed with the index (for outline and compile help). */
  let texts = $state.raw(new Map<string, string>());
  let showSettings = $state(false);
  let showShare = $state(false);
  let showNetwork = $state(false);
  /** Resolve dialog for offline-merge conflicts (id of the conflict to show first). */
  let showConflicts = $state<{ initial: string | null } | null>(null);
  let showTour = $state(false);
  let jump = $state<{ line: number; n: number } | null>(null);
  let highlight = $state<PdfPosition | null>(null);
  let indexTimer: ReturnType<typeof setTimeout> | null = null;
  let compileError = $state('');
  let importRequest = $state<ImportRequest | null>(null);
  let cursor = $state<{ line: number; col: number } | null>(null);
  let keymapMode = $state('');

  /** Under 1100 px the workspace shows the editor or the PDF, and the side panel floats over the editor. */
  let narrow = $state(false);
  let narrowView = $state<'editor' | 'pdf'>('editor');
  /** Narrow screens: the side panel floats over the editor only until a file or line is picked. */
  let overlayOpen = $state(false);
  const sideVisible = $derived(!!layout.panel && (!narrow || overlayOpen));

  function railClick(p: Panel) {
    if (narrow) {
      if (overlayOpen && layout.panel === p) overlayOpen = false;
      else {
        setLayout({ panel: p });
        overlayOpen = true;
      }
    } else togglePanel(p);
  }
  let mainWidth = $state(800);

  /** Change sets from co-authors and the folder that arrived while the Changes panel was closed. */
  let seenChanges = $state(0);
  const foreignChanges = $derived(session ? session.changes.filter((c) => c.source.kind === 'peer' || c.source.kind === 'folder').length : 0);
  const unseen = $derived(layout.panel === 'changes' ? 0 : Math.max(0, foreignChanges - seenChanges));
  $effect(() => {
    if (layout.panel === 'changes') seenChanges = foreignChanges;
  });

  /** Bumped whenever the project settings change (here, by an import, or by a co-author): they live in Yjs, which Svelte does not track. */
  let settingsTick = $state(0);
  const mainPath = $derived(settingsTick >= 0 && session ? String(session.model.settings.get('main') ?? 'main.tex') : 'main.tex');
  const active = $derived(session?.files.find((f) => f.id === activeId) ?? null);
  const diagnostics = $derived((session?.result?.diagnostics ?? []).filter((d) => !active || d.file === active.path || d.file === ''));
  $effect(() => {
    const settings = session?.model.settings;
    if (!settings) return;
    const bump = () => settingsTick++;
    settings.observe(bump);
    return () => settings.unobserve(bump);
  });

  const showEditor = $derived(!narrow || narrowView === 'editor');
  const showPdf = $derived(narrow ? narrowView === 'pdf' : layout.pdf);

  onMount(() => {
    const mq = window.matchMedia('(max-width: 1099px)');
    const update = () => (narrow = mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });

  let pendingSession: ProjectSession | null = null;
  let workspaceClosed = false;
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
      if (workspaceClosed) return;
      // Account recents (best effort: offline opens are simply not recorded).
      void api('POST', `/projects/${projectId}/opened`).catch(() => {});
      const s = new ProjectSession(info, auth.user);
      pendingSession = s;
      await s.open();
      if (workspaceClosed) { await s.close(); return; }
      pendingSession = null;
      session = s;
      if (localStorage.getItem('hivetex.test') === '1')
        (window as unknown as { __p2p: unknown }).__p2p = {
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
      const link = takePendingLink(s.project.id);
      if (link && s.canWrite) void linkLocal(s, link.localId);
      const tpl = takePendingTemplate();
      if (tpl && s.canWrite && s.files.length === 0) await applyTemplate(s.model, tpl.files, tpl.main);
      // Created from a folder: its files were imported when the folder was bound; pick main and engine from them.
      if (takeFreshFolderProject(s.project.id) && s.canWrite) {
        const main = await s.detectMainAndEngine().catch(() => null);
        if (main) toast(`Main document: ${main}`, 'info');
      }
      seenChanges = foreignChanges;
      if (tourWanted()) setTimeout(() => (showTour = true), 400);
      const first = s.model.find(String(s.model.settings.get('main') ?? 'main.tex')) ?? s.files.find((f) => f.kind === 'text');
      if (first) activeId = first.id;
    } catch (e) {
      if (workspaceClosed) return;
      if (e instanceof MigrationAssociationRequired) migration = e;
      error = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Could not open the project';
    }
  });
  async function confirmMigration(ref: StoreRef) {
    try { await confirmLegacyAssociation(ref); location.reload(); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  async function recoverLegacy(ref: StoreRef) {
    try { await download(`hivetex-${projectId}-legacy-recovery.json`, await exportLegacyRecovery(ref), 'application/json'); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
  }

  onDestroy(() => {
    workspaceClosed = true;
    if (indexTimer) clearTimeout(indexTimer);
    void session?.close();
    void pendingSession?.close();
  });

  function scheduleIndex(delay = 400) {
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
      const t = new Map(files.filter((f) => 'text' in f).map((f) => [f.path, (f as { text: string }).text]));
      texts = t;
      outline = buildOutline(String(session.model.settings.get('main') ?? 'main.tex'), (p) => t.get(p), [...t.keys()].filter((p) => p.endsWith('.tex')));
    }, delay);
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
      toast(`Added ${r.added} file${r.added === 1 ? '' : 's'}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Upload failed', 'error');
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
    if (session.model.find(path)) return void toast(`"${path}" already exists`, 'error');
    try {
      if (kind === 'folder') session.model.createDir(path);
      else {
        const starter = path.endsWith('.tex') && !session.files.some((f) => f.kind === 'text') ? '\\documentclass{article}\n\\begin{document}\nHello!\n\\end{document}\n' : '';
        activeId = await session.model.createTextNow(path, starter);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the file', 'error');
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
    toast('Preparing the download...', 'info');
    const r = await exportProjectZip(session.mesh, session.model, session.blobs);
    if (!r.ok) return toast(`The project was not downloaded because these files have not arrived on this device yet: ${describeMissing(r.missing)}. Try again once your co-authors are online.`, 'error');
    await download(`${session.project.slug}.zip`, r.zip, 'application/zip');
  }

  async function exportRecovery() {
    if (!session) return;
    const r = await session.exportRecovery();
    await download(`${session.project.slug}-recovery.zip`, r.zip, 'application/zip');
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
    stopFollowing();
    overlayOpen = false;
    if (f.kind === 'text' || f.kind === 'binary') activeId = f.id;
    if (narrow) narrowView = 'editor';
  }

  function setMain(f: FileEntry) {
    session?.model.settings.set('main', f.path);
    settingsTick++;
  }

  function forward(line: number) {
    if (!session?.syncIndex || !active) return void toast('SyncTeX data is not available for this PDF', 'info');
    const pos = forwardSearch(session.syncIndex, active.path, line);
    if (pos) {
      highlight = { ...pos };
      if (narrow) narrowView = 'pdf';
      else if (!layout.pdf) setLayout({ pdf: true });
    } else toast('No matching position in the PDF', 'info');
  }

  function reverse(file: string, line: number) {
    overlayOpen = false;
    const f = session?.files.find((x) => x.path === file || x.path.endsWith(`/${file}`) || file.endsWith(`/${x.path}`));
    if (!f) return;
    activeId = f.id;
    jump = { line, n: (jump?.n ?? 0) + 1 };
    if (narrow) narrowView = 'editor';
  }

  function gotoLine(fileId: string, line: number) {
    overlayOpen = false;
    activeId = fileId;
    jump = { line, n: (jump?.n ?? 0) + 1 };
    if (narrow) narrowView = 'editor';
  }

  async function loadFromGithub() {
    if (!session?.project.githubRepo) return;
    try {
      const n = await session.importFromGithub(session.project.githubRepo);
      toast(`Loaded ${n} files from GitHub`);
      openPanel('files');
      const first = session.model.find(String(session.model.settings.get('main') ?? 'main.tex')) ?? session.files.find((f) => f.kind === 'text');
      if (first) activeId = first.id;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  let showLocation = $state(false);
  const canUseFolders = isDesktop || folderAccessSupported();
  /** The folder's own name: the end of a path is what identifies it, and the side panel is too narrow for the rest. */
  const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

  // Web: compile with the HiveTeX desktop app running on this computer (it asks the user to allow it).
  let pairing = $state(false);
  let pairMessage = $state('');
  async function compileWithDesktop() {
    if (!session) return;
    pairing = true;
    pairMessage = 'Confirm in the HiveTeX desktop app…';
    const r = await session.pairDesktopHelper();
    pairing = false;
    pairMessage = r === 'paired' ? '' : PAIR_MESSAGES[r];
    if (r === 'paired') session.requestCompile();
  }

  /** Link: merges a local project into this one once this device has the project's files (local-mode spec). */
  async function linkLocal(s: ProjectSession, localId: string) {
    const name = getLocalProject(localId)?.name ?? 'the local project';
    toast(`Getting the project's files before merging "${name}"…`, 'info', 8000);
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const stage = s.syncStatus?.stage;
      if (stage === 'synced' || (stage === 'alone' && Date.now() > end - 50_000)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      const r = await s.mergeLocalProject(localId);
      forgetLocalProject(localId);
      await removeLocalProjectData(localId);
      toast(`Merged "${name}" into this project: ${r.taken.length} file${r.taken.length === 1 ? '' : 's'} added${r.conflicts ? `, ${r.conflicts} conflict${r.conflicts === 1 ? '' : 's'} to resolve` : ''}.`, r.conflicts ? 'error' : 'ok', 10_000);
      if (r.conflicts) showConflicts = { initial: null };
    } catch (e) {
      toast(`Could not merge "${name}": ${e instanceof Error ? e.message : String(e)}. It is still on this computer.`, 'error');
    }
  }

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
      toast(`Project files are now in the folder "${session.mirrorDir}"`);
    } catch (e) {
      toast(`Could not use that folder: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  /** Files context menu: the project's folder (desktop), or linking one (web). */
  function folderActions(path: string | null): MenuItem[] {
    if (!session) return [];
    if (!isDesktop) return canUseFolders && !session.mirrorDir ? [{ label: 'Use a folder…', icon: FolderInput, onSelect: () => void linkFolder(), testid: 'ctx-use-folder' }] : [];
    const items: MenuItem[] = [
      { label: 'Open folder', icon: FolderOpen, onSelect: () => void folderAction({ kind: 'open' }), testid: 'ctx-open-folder' },
      { label: 'Open in terminal', icon: SquareTerminal, onSelect: () => void folderAction({ kind: 'terminal' }), testid: 'ctx-terminal' },
      { label: 'Copy folder path', icon: Copy, onSelect: () => void folderAction({ kind: 'copy' }), testid: 'ctx-copy-path' },
    ];
    if (path) items.push({ label: 'Show in file manager', icon: FolderSearch, onSelect: () => void folderAction({ kind: 'reveal', path }), testid: 'ctx-reveal' });
    return items;
  }

  async function folderAction(action: FolderAction) {
    if (!session) return;
    try {
      const r = await session.folderAction(action, (path) => toast(`Putting the project in the folder ${path}…`, 'info'));
      if (r.created) toast(`Project files are now in ${r.path}. Edits there sync with everyone.`);
      if (action.kind === 'copy') toast(`Copied ${r.path}`);
    } catch (e) {
      toast(`${action.kind === 'terminal' ? 'Could not open a terminal' : 'Could not use the project folder'}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  async function unlinkFolder() {
    showLocation = false;
    const label = session?.mirrorDir;
    await session?.unbindFolder();
    if (label) toast(`Stopped using "${label}". The files there were left as they are.`);
  }

  async function allowFolder() {
    try {
      if (!(await session?.allowFolderAccess())) toast('Access to the folder was not granted', 'error');
    } catch (e) {
      toast(`Could not re-open the folder: ${e instanceof Error ? e.message : String(e)}`, 'error');
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
      session.blobs
        .fetch(f.hash, 15_000)
        .then((b) => {
          if (active?.id === f.id) imageUrl = URL.createObjectURL(new Blob([b as unknown as BlobPart]));
        })
        .catch(() => {});
    }
  });

  // ---- layout ----

  const RAIL: Array<{ id: Panel; label: string; icon: typeof Files; testid?: string }> = [
    { id: 'files', label: 'Files', icon: Files, testid: 'rail-files' },
    { id: 'outline', label: 'Outline', icon: ListTree, testid: 'rail-outline' },
    { id: 'search', label: 'Search', icon: Search, testid: 'rail-search' },
    { id: 'changes', label: 'Changes', icon: Changes, testid: 'changes-btn' },
    { id: 'history', label: 'History', icon: History, testid: 'rail-history' },
    { id: 'people', label: 'People', icon: Users, testid: 'rail-people' },
    { id: 'sync', label: 'Sync', icon: RefreshCw, testid: 'rail-sync' },
    { id: 'backup', label: 'GitHub backup', icon: CloudUpload, testid: 'backup-btn' },
  ];

  function openPanel(p: Panel) {
    setLayout({ panel: p });
    overlayOpen = true;
  }

  function resizeSide(d: number) {
    setLayout({ sideWidth: Math.max(SIDE_MIN, Math.min(SIDE_MAX, layout.sideWidth + d)) });
  }

  function resizeSplit(d: number) {
    const w = Math.max(200, mainWidth);
    setLayout({ split: Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, layout.split + d / w)) });
  }

  function togglePdf() {
    if (narrow) narrowView = narrowView === 'pdf' ? 'editor' : 'pdf';
    else setLayout({ pdf: !layout.pdf });
  }

  function toggleFocus() {
    setLayout({ focus: !layout.focus });
  }

  // A new compile result: refresh the texts at once, so its problems are explained against the current source.
  $effect(() => {
    if (session?.result) untrack(() => scheduleIndex(0));
  });

  // ---- presence and follow ----

  // Tell co-authors which file this user has open.
  $effect(() => {
    session?.setOpenFile(active?.path ?? null);
  });

  /** path → co-authors with that file open (for file-tree dots). */
  const presenceByFile = $derived.by(() => {
    const out: Record<string, Array<{ name: string; color: string }>> = {};
    for (const p of session?.presence ?? []) if (p.file) (out[p.file] ??= []).push({ name: p.name, color: p.color });
    return out;
  });
  /** Files whose content has not arrived yet (shown muted in the file tree). */
  const pendingPaths = $derived(new Set((session?.syncStatus?.files ?? []).filter((f) => !f.have).map((f) => f.path)));
  const hereWithMe = $derived(active ? (presenceByFile[active.path] ?? []) : []);

  /** The co-author being followed (username), if any. */
  let following = $state<string | null>(null);

  function follow(name: string) {
    following = following === name ? null : name;
    if (following) toast(`Following ${name}. Type, scroll or pick a file to stop.`, 'info');
  }

  function stopFollowing() {
    following = null;
  }

  // While following: open their file and keep their cursor in view; stop when they leave.
  $effect(() => {
    const name = following;
    if (!name || !session) return;
    const person = session.presence.find((p) => p.name === name);
    if (!person) {
      following = null;
      toast(`${name} went offline. Stopped following.`, 'info');
      return;
    }
    if (person.file && person.file !== active?.path) {
      const f = session.model.find(person.file);
      if (f && (f.kind === 'text' || f.kind === 'binary')) activeId = f.id;
      return;
    }
    const id = person.clientId;
    queueMicrotask(() => editorRef?.revealClient(id));
  });

  // ---- authoring aids ----

  let editorRef = $state<ReturnType<typeof Editor>>();
  let picker = $state<null | 'figure' | 'table' | 'cite' | 'ref' | 'symbol'>(null);
  const isTex = $derived(active?.kind === 'text' && /\.(tex|ltx|sty|cls)$/i.test(active.path));
  const canFormat = $derived(!!session?.canWrite && active?.kind === 'text');
  const showToolbar = $derived(prefs.toolbar && canFormat && isTex);

  /** Applies an insertion once the dialog that asked for it has closed and given focus back. */
  function insertSoon(build: (selected: string, ctx: { inMath: boolean }) => tex.Insertion) {
    picker = null;
    setTimeout(() => editorRef?.insertWith(build), 0);
  }

  function format(a: FormatAction) {
    if (!editorRef) return;
    switch (a.kind) {
      case 'section':
        editorRef.insertWith((sel) => tex.section(a.level, sel));
        break;
      case 'bold':
        editorRef.insertWith(tex.bold);
        break;
      case 'italic':
        editorRef.insertWith(tex.italic);
        break;
      case 'itemize':
      case 'enumerate':
        editorRef.insertWith((sel) => tex.list(a.kind as 'itemize' | 'enumerate', sel));
        break;
      case 'math':
        editorRef.insertWith(tex.inlineMath);
        break;
      case 'equation':
        editorRef.insertWith(tex.displayMath);
        break;
      case 'hide':
        setPref('toolbar', false);
        toast('Formatting toolbar hidden. Its actions stay in the command palette (Ctrl+K).', 'info');
        break;
      default:
        picker = a.kind;
    }
  }

  const currentOutline = $derived(active && cursor ? currentHeading(outline, active.path, cursor.line) : null);

  /** Adds \usepackage{pkg} to the main document's preamble, as an ordinary edit by this user (undoable). */
  async function addPackage(pkg: string) {
    if (!session?.canWrite) return;
    const main = session.model.find(mainPath);
    if (!main || main.kind !== 'text') return void toast(`The main document ${mainPath} is missing`, 'error');
    const line = `\\usepackage{${pkg}}`;
    if (active?.id === main.id && editorRef) {
      editorRef.insertLineBefore(preambleInsertLine(editorRef.text()), line);
    } else {
      const ytext = await session.model.openText(main.id);
      const text = ytext.toString();
      const at = text.split('\n').slice(0, preambleInsertLine(text) - 1).join('\n').length;
      ytext.insert(at === 0 ? 0 : at + 1, `${line}\n`);
    }
    toast(`Added ${line} to ${mainPath}`);
  }

  const imageFiles = $derived((session?.files ?? []).filter((f) => f.kind === 'binary' && /\.(png|jpe?g|pdf|eps)$/i.test(f.path)));

  // ---- commands (palette, shortcuts, menus) ----

  let tree = $state<ReturnType<typeof FileTree>>();
  let lastPanel: Panel = layout.panel ?? 'files';
  $effect(() => {
    if (layout.panel) lastPanel = layout.panel;
  });

  async function withFiles(fn: () => void) {
    openPanel('files');
    await tick();
    fn();
  }

  onMount(() => {
    const has = () => !!session;
    const writable = () => !!session?.canWrite;
    const off = registerCommands([
      { id: 'compile', title: 'Compile now', group: 'Compile', keys: ['Mod+Enter', 'Mod+S'], icon: Play, aliases: ['recompile', 'build', 'save'], when: has, run: () => void compileNow() },
      { id: 'compile-local', title: 'Compile on this device only', group: 'Compile', keys: ['Mod+Shift+Enter'], icon: Play, when: () => !!session?.engine, run: () => void compileLocal() },
      { id: 'synctex-forward', title: 'Show this line in the PDF', group: 'Navigate', keys: ['Mod+Alt+J'], editor: true, aliases: ['synctex', 'forward search'], when: () => active?.kind === 'text', run: () => forward(cursor?.line ?? 1) },
      { id: 'goto-line', title: 'Go to line…', group: 'Navigate', aliases: ['line number'], when: () => active?.kind === 'text', run: () => openPalette(':') },
      { id: 'goto-heading', title: 'Go to heading…', group: 'Navigate', aliases: ['outline', 'section'], when: has, run: () => openPalette('@') },
      { id: 'toggle-side', title: 'Show or hide the side panel', group: 'View', keys: ['Mod+Shift+E'], icon: PanelLeft, when: has, run: () => setLayout({ panel: layout.panel ? null : lastPanel }) },
      { id: 'toggle-pdf', title: 'Show or hide the PDF', group: 'View', keys: ['Mod+Alt+P'], icon: PanelRight, when: has, run: togglePdf },
      { id: 'focus', title: 'Focus mode', group: 'View', keys: ['Mod+Shift+F'], icon: Maximize, aliases: ['zen', 'distraction free'], when: has, run: toggleFocus },
      { id: 'tour', title: 'Take the tour', group: 'Help', icon: Help, aliases: ['help', 'guide', 'introduction', 'onboarding'], when: has, run: () => (showTour = true) },
      { id: 'reset-layout', title: 'Reset layout', group: 'View', aliases: ['panels', 'default layout'], when: has, run: resetLayout },
      { id: 'search', title: 'Search in project', group: 'Navigate', keys: ['Mod+Shift+H'], icon: Search, aliases: ['find', 'replace'], when: has, run: () => openPanel('search') },
      { id: 'panel-files', title: 'Show files', group: 'Navigate', icon: Files, when: has, run: () => openPanel('files') },
      { id: 'panel-outline', title: 'Show outline', group: 'Navigate', icon: ListTree, aliases: ['sections', 'headings', 'table of contents'], when: has, run: () => openPanel('outline') },
      { id: 'panel-changes', title: 'Show changes', group: 'Navigate', icon: Changes, aliases: ['undo', 'diff'], when: has, run: () => openPanel('changes') },
      { id: 'panel-history', title: 'Show history', group: 'Navigate', icon: History, aliases: ['snapshots', 'restore'], when: has, run: () => openPanel('history') },
      { id: 'panel-people', title: 'Show people', group: 'Navigate', icon: Users, aliases: ['collaborators', 'co-authors', 'online'], when: has, run: () => openPanel('people') },
      { id: 'panel-backup', title: 'GitHub backup', group: 'Project', icon: CloudUpload, aliases: ['github', 'git', 'backup now'], when: has, run: () => openPanel('backup') },
      { id: 'new-file', title: 'New file', group: 'Files', icon: FilePlus, aliases: ['create file', 'add file'], when: writable, run: () => void withFiles(() => tree?.startAdd('file')) },
      { id: 'new-folder', title: 'New folder', group: 'Files', icon: FolderPlus, when: writable, run: () => void withFiles(() => tree?.startAdd('folder')) },
      { id: 'rename-file', title: 'Rename or move this file', group: 'Files', icon: Pencil, aliases: ['move'], when: () => writable() && !!active, run: () => void withFiles(() => active && tree?.startRename(active.path)) },
      { id: 'import', title: 'Import…', group: 'Files', icon: FolderOpen, aliases: ['upload', 'overleaf', 'zip', 'arxiv'], when: writable, run: () => (importRequest = { kind: 'pick' }) },
      { id: 'download-zip', title: 'Download project (.zip)', group: 'Files', icon: Download, aliases: ['export'], when: has, run: () => void downloadZip() },
      { id: 'download-pdf', title: 'Download PDF', group: 'Files', icon: Download, when: () => !!session?.pdf, run: () => void downloadPdf() },
      { id: 'network-diagnostics', title: 'Network diagnostics', group: 'Project', icon: Wifi, aliases: ['network', 'connection', 'webrtc', 'ports', 'stun', 'turn', 'sync problem'], when: has, run: () => (showNetwork = true) },
      { id: 'share', title: 'Share project', group: 'Project', icon: Share, aliases: ['share id', 'invite', 'copy id', 'project id'], when: has, run: () => (showShare = true) },
      { id: 'insert-bold', title: 'Bold', group: 'Insert', keys: ['Mod+B'], editor: true, icon: Bold, aliases: ['textbf', 'strong'], when: () => canFormat && isTex, run: () => format({ kind: 'bold' }) },
      { id: 'insert-italic', title: 'Italic', group: 'Insert', keys: ['Mod+I'], editor: true, icon: Italic, aliases: ['textit', 'emphasis'], when: () => canFormat && isTex, run: () => format({ kind: 'italic' }) },
      { id: 'insert-section', title: 'Insert section heading', group: 'Insert', aliases: ['section', 'heading', 'chapter'], when: () => canFormat, run: () => format({ kind: 'section', level: 'section' }) },
      { id: 'insert-subsection', title: 'Insert subsection heading', group: 'Insert', aliases: ['subsection', 'heading'], when: () => canFormat, run: () => format({ kind: 'section', level: 'subsection' }) },
      { id: 'insert-itemize', title: 'Insert bulleted list', group: 'Insert', icon: List, aliases: ['itemize', 'bullets'], when: () => canFormat, run: () => format({ kind: 'itemize' }) },
      { id: 'insert-enumerate', title: 'Insert numbered list', group: 'Insert', icon: ListOrdered, aliases: ['enumerate'], when: () => canFormat, run: () => format({ kind: 'enumerate' }) },
      { id: 'insert-math', title: 'Insert inline math', group: 'Insert', icon: Sigma, aliases: ['math', 'formula', '$'], when: () => canFormat, run: () => format({ kind: 'math' }) },
      { id: 'insert-equation', title: 'Insert equation', group: 'Insert', icon: SquareSigma, aliases: ['display math', 'formula'], when: () => canFormat, run: () => format({ kind: 'equation' }) },
      { id: 'insert-symbol', title: 'Insert symbol…', group: 'Insert', icon: Omega, aliases: ['greek', 'alpha', 'arrow', 'symbol'], when: () => canFormat, run: () => (picker = 'symbol') },
      { id: 'insert-figure', title: 'Insert figure…', group: 'Insert', icon: Image, aliases: ['image', 'includegraphics', 'picture'], when: () => canFormat, run: () => (picker = 'figure') },
      { id: 'insert-table', title: 'Insert table…', group: 'Insert', icon: Table, aliases: ['tabular'], when: () => canFormat, run: () => (picker = 'table') },
      { id: 'insert-cite', title: 'Insert citation…', group: 'Insert', icon: Quote, aliases: ['cite', 'bibliography', 'reference'], when: () => canFormat, run: () => (picker = 'cite') },
      { id: 'insert-ref', title: 'Insert cross-reference…', group: 'Insert', icon: Link, aliases: ['ref', 'label'], when: () => canFormat, run: () => (picker = 'ref') },
      { id: 'toggle-toolbar', title: 'Show or hide the formatting toolbar', group: 'View', icon: Eye, aliases: ['toolbar'], when: has, run: () => setPref('toolbar', !prefs.toolbar) },
      { id: 'settings', title: 'Project settings', group: 'Project', icon: Settings, aliases: ['settings', 'members', 'roles', 'password', 'main file', 'engine'], when: has, run: () => (showSettings = true) },
    ]);
    const offFiles = registerSource({
      id: 'files',
      label: 'Files',
      items: () =>
        (session?.files ?? [])
          .filter((f) => f.kind !== 'dir')
          .map((f) => ({ id: `file:${f.id}`, title: f.path.split('/').pop() ?? f.path, detail: f.path, icon: f.kind === 'binary' ? FileImage : FileText, run: () => openFile(f) })),
    });
    const offOutline = registerSource({
      id: 'outline',
      label: 'Headings',
      items: () =>
        outline.map((e, i) => ({
          id: `h:${i}`,
          title: `${e.number} ${e.title}`.trim(),
          detail: `${e.file}:${e.line}`,
          icon: ListTree,
          inOpenFile: e.file === active?.path,
          run: () => reverse(e.file, e.line),
        })),
    });
    setGotoLine((n) => {
      if (active?.kind !== 'text') return void toast('Open a file first', 'info');
      jump = { line: n, n: (jump?.n ?? 0) + 1 };
    });
    return () => {
      off();
      offFiles();
      offOutline();
      setGotoLine(null);
    };
  });

  const moreItems = $derived.by((): MenuItem[] => {
    const s = session;
    if (!s) return [];
    return [
      ...(s.canWrite ? [{ label: 'Import…', icon: FolderOpen, onSelect: () => (importRequest = { kind: 'pick' }), testid: 'more-import' } as MenuItem] : []),
      { label: 'Download project (.zip)', icon: Download, onSelect: () => void downloadZip() },
      { label: 'Download PDF', icon: Download, onSelect: () => void downloadPdf(), disabled: !s.pdf },
      'separator',
      { label: 'History', icon: History, onSelect: () => openPanel('history') },
      { label: layout.focus ? 'Leave focus mode' : 'Focus mode', icon: Maximize, hint: 'Mod+Shift+F', onSelect: toggleFocus },
      { label: 'Reset layout', icon: PanelRight, onSelect: resetLayout },
      'separator',
      { label: 'Take the tour', icon: Help, onSelect: () => (showTour = true), testid: 'take-tour' },
      { label: 'Keyboard shortcuts', icon: Keyboard, hint: 'Mod+Shift+/', onSelect: openShortcuts },
      'separator',
      { label: s.role === 'owner' ? 'Project settings' : 'Settings', icon: Settings, onSelect: () => (showSettings = true) },
    ];
  });

  const compileItems = $derived.by((): MenuItem[] => {
    const s = session;
    if (!s) return [];
    return [
      { label: 'Compile now', icon: Play, hint: 'Mod+Enter', onSelect: () => void compileNow() },
      ...(s.engine ? [{ label: 'Compile on this device only', icon: Play, hint: 'Mod+Shift+Enter', onSelect: () => void compileLocal(), testid: 'compile-local' } as MenuItem] : []),
      { label: 'Download PDF', icon: Download, onSelect: () => void downloadPdf(), disabled: !s.pdf },
    ];
  });
</script>

{#if error}
  <div class="ws-message"><div class="error" role="alert">{error}</div>
    {#if migration}
      <p>No content from this older cache is being shared or seeded.</p>
      {#if migration.mayConfirm}
        <p>Confirm only if this cache belongs to {auth.user?.username} on {apiBase() || location.origin}.</p>
        <button type="button" onclick={() => migration && confirmMigration(migration.ref)}>Confirm this account and server, then migrate</button>
      {/if}
      <button type="button" onclick={() => migration && recoverLegacy(migration.ref)}>Export older cache for recovery</button>
    {/if}
    <a href="#/">← Back to projects</a></div>
{:else if !session}
  <div class="ws-message"><p class="muted">Opening project…</p></div>
{:else}
  {@const s = session}
  <div
    class="ws"
    class:focus={layout.focus}
    class:narrow
    data-testid="workspace"
    style:--side-w="{layout.sideWidth}px"
  >
    {#if !layout.focus}
      <header class="ws-head">
        <a class="back" href="#/" aria-label="All projects" data-tip="All projects"><Icon icon={ArrowLeft} /></a>
        <div class="crumb">
          <strong class="slug" data-testid="project-slug">{s.project.slug}</strong>
          <span class="pill role {s.role}" data-testid="role-pill">{s.role}</span>
        </div>
        <span class="sp"></span>
        {#if s.peers.length}
          <AvatarStack
            label="{s.peers.length} co-author{s.peers.length === 1 ? '' : 's'} online"
            people={s.peers.map((p) => {
              const file = s.fileOf(p.uname);
              const where = file ? `${p.uname} · ${file}` : p.uname;
              return {
                name: p.uname,
                tip: following === p.uname ? `Following ${where}` : `${where} (click to follow)`,
                label: following === p.uname ? `Stop following ${p.uname}` : `Follow ${p.uname}${file ? `, in ${file}` : ''}`,
                ring: following === p.uname,
                onclick: () => follow(p.uname),
              };
            })}
          />
        {/if}
        {#if narrow}
          <div class="seg" role="group" aria-label="Show">
            <button type="button" aria-pressed={narrowView === 'editor'} onclick={() => (narrowView = 'editor')}>Editor</button>
            <button type="button" aria-pressed={narrowView === 'pdf'} onclick={() => (narrowView = 'pdf')}>PDF</button>
          </div>
        {/if}
        {#if s.isLocal}
          <span class="pill" data-testid="local-project-pill" data-tip="This project exists only on this computer. Sign in to share it.">On this computer</span>
        {:else}
          <button type="button" class="hbtn" onclick={() => (showShare = true)} data-testid="share-btn" data-tip="Invite co-authors"><Icon icon={Share} /><span class="lbl">Share</span></button>
        {/if}
        <div class="split-btn">
          <button type="button" class="primary" onclick={compileNow} data-testid="compile-btn" disabled={s.compileStatus === 'compiling'}>
            <Icon icon={Play} />{s.compileStatus === 'compiling' ? 'Compiling…' : 'Recompile'}
          </button>
          <Menu label="Compile options" items={compileItems} triggerClass="primary caret" tip="Compile options">
            {#snippet trigger()}<Icon icon={ChevronDown} />{/snippet}
          </Menu>
        </div>
        <IconButton icon={Download} label="Download PDF" disabled={!s.pdf} onclick={downloadPdf} />
        <Menu label="More actions" items={moreItems} triggerClass="more" tip="More actions" testid="more-menu" triggerTestid="more-btn">
          {#snippet trigger()}<Icon icon={Ellipsis} />{/snippet}
        </Menu>
      </header>
    {/if}

    <div class="ws-body">
      {#if !layout.focus}
        <nav class="rail" aria-label="Panels">
          {#each RAIL as r (r.id)}
            <IconButton
              icon={r.icon}
              label={r.id === 'changes' && unseen ? `Changes, ${unseen} new` : r.label}
              tip={r.label}
              tipSide="right"
              size={36}
              active={sideVisible && layout.panel === r.id}
              aria-pressed={sideVisible && layout.panel === r.id}
              badge={r.id === 'changes' && unseen ? Math.min(unseen, 99) : undefined}
              data-testid={r.testid}
              onclick={() => railClick(r.id)}
            />
          {/each}
          <span class="sp"></span>
          <IconButton icon={Settings} label={s.role === 'owner' ? 'Project settings' : 'Settings'} tipSide="right" size={36} data-testid="settings-btn" onclick={() => (showSettings = true)} />
        </nav>

        {#if sideVisible}
          <aside class="side" class:overlay={narrow} aria-label="Side panel">
            {#if layout.panel === 'files'}
              <div class="files-panel">
                <FileTree
                  bind:this={tree}
                  files={s.files}
                  {activeId}
                  canWrite={s.canWrite}
                  mainPath={settingsTick >= 0 ? mainPath : ''}
                  onOpen={openFile}
                  {onCreate}
                  {onRename}
                  {onDelete}
                  {onUpload}
                  onDownload={downloadFile}
                  onSetMain={setMain}
                  presence={presenceByFile}
                  pending={pendingPaths}
                  {folderActions}
                >
                  {#snippet headerExtra()}
                    {#if s.canWrite}<IconButton icon={FolderOpen} size={28} label="Import…" tip="Import a .zip, a folder or files" data-testid="import-btn" onclick={() => (importRequest = { kind: 'pick' })} />{/if}
                  {/snippet}
                </FileTree>
                {#if canUseFolders}
                  <div class="location">
                    {#if s.folderPending}
                      <button type="button" class="small primary" onclick={allowFolder} data-testid="allow-folder" data-tip={`Let the app read and write "${s.location.kind === 'folder' ? s.location.label : ''}" again`}>Allow access to “{s.location.kind === 'folder' ? s.location.label : ''}”</button>
                    {/if}
                    <button type="button" class="loc-btn" onclick={() => (showLocation = !showLocation)} aria-expanded={showLocation} aria-haspopup="menu" data-testid="location-btn" data-tip={s.mirrorDir ? `Files are in ${s.mirrorDir}` : "Where this project's files live on this device"}>
                      <Icon icon={FolderOpen} size={14} /><span class="loc-label">{s.mirrorDir ? `In the folder ${folderName(s.mirrorDir)}` : 'In the app'}</span><Icon icon={ChevronDown} size={14} />
                    </button>
                    {#if showLocation}
                      <div class="location-menu" role="menu" data-testid="location-menu">
                        {#if s.mirrorDir}
                          <p>Files are in the folder <strong>{s.mirrorDir}</strong>. Edit them with any tool (Claude Code, Codex, an editor): changes sync with everyone.</p>
                          {#if isDesktop}<button type="button" role="menuitem" class="small" onclick={() => { showLocation = false; void s.revealFolder(); }}>Show in file manager</button>{/if}
                          <button type="button" role="menuitem" class="small" onclick={linkFolder} data-testid="link-folder">Use another folder…</button>
                          <button type="button" role="menuitem" class="small" onclick={unlinkFolder} data-testid="unlink-folder">Stop using the folder</button>
                        {:else}
                          <p>Files are stored in the app on this device. Put them in a folder to edit them with Claude Code, Codex or any editor.</p>
                          <button type="button" role="menuitem" class="small" onclick={linkFolder} data-testid="link-folder">Use a folder…</button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {:else if layout.panel === 'outline'}
              <OutlinePanel entries={outline} current={currentOutline} onGo={reverse} />
            {:else if layout.panel === 'search'}
              <SearchPanel session={s} onOpen={gotoLine} />
            {:else if layout.panel === 'changes'}
              <ChangesPanel session={s} />
            {:else if layout.panel === 'history'}
              <HistoryPanel session={s} />
            {:else if layout.panel === 'people'}
              <PeoplePanel session={s} onShare={() => (showShare = true)} fileOf={(name) => s.fileOf(name)}>
                {#snippet actions(p)}
                  <button type="button" class="small" aria-pressed={following === p.name} onclick={() => follow(p.name)} data-testid="follow-{p.name}">{following === p.name ? 'Following' : 'Follow'}</button>
                {/snippet}
              </PeoplePanel>
            {:else if layout.panel === 'sync'}
              <SyncPanel session={s} onNetwork={() => (showNetwork = true)} onConflicts={() => (showConflicts = { initial: null })} onOpenFile={(path) => { const f = s.files.find((x) => x.path === path); if (f) openFile(f); }} />
            {:else if layout.panel === 'backup'}
              <BackupPanel session={s} />
            {/if}
          </aside>
          {#if !narrow}
            <Splitter label="Resize side panel" value={layout.sideWidth} min={SIDE_MIN} max={SIDE_MAX} onresize={resizeSide} testid="side-splitter" />
          {/if}
        {/if}
      {/if}

      <div class="main" bind:clientWidth={mainWidth} style:--split={showEditor && showPdf ? layout.split : showEditor ? 1 : 0}>
        {#if showEditor}
          <section class="editor-area" aria-label="Editor" onpointerdown={() => narrow && (overlayOpen = false)}>
            <div class="ed-head">
              {#if active}
                <span class="path" title={active.path}>{active.path}</span>
                {#if active.path === mainPath}<span class="pill honey">Main document</span>{/if}
                {#if !s.canWrite}<span class="pill">Read-only</span>{/if}
                {#each hereWithMe as p (p.name)}<span class="here" style:background={p.color} data-tip="{p.name} is in this file" data-testid="here-dot"><span class="sr-only">{p.name} is in this file</span></span>{/each}
              {:else}
                <span class="path muted">No file open</span>
              {/if}
              <span class="sp"></span>
              {#if following}<span class="pill honey" data-testid="following">Following {following}<button type="button" class="unfollow" onclick={stopFollowing}>Stop</button></span>{/if}
              {#if !showPdf && !narrow}<button type="button" class="small" onclick={togglePdf} data-testid="show-pdf"><Icon icon={PanelRight} size={14} />Show PDF</button>{/if}
              <IconButton icon={layout.focus ? Minimize : Maximize} size={28} label={layout.focus ? 'Leave focus mode' : 'Focus mode'} tip={layout.focus ? 'Leave focus mode (Ctrl+Shift+F)' : 'Focus mode (Ctrl+Shift+F)'} data-testid="focus-btn" onclick={toggleFocus} />
            </div>
            {#if active && s.conflicts.some((c) => c.kind === 'text' && c.fileId === active.id)}
              {@const c = s.conflicts.find((x) => x.kind === 'text' && x.fileId === active.id)}
              <div class="conflict-bar" role="status" data-testid="conflict-bar">
                <span>This file conflicts with your offline version. Co-authors see their version until you decide.</span>
                <button type="button" class="small" onclick={() => (showConflicts = { initial: c?.id ?? null })} data-testid="resolve-btn">Resolve</button>
              </div>
            {/if}
            {#if showToolbar && !layout.focus}<FormatToolbar onAction={format} />{/if}
            <div class="ed-body">
              {#if active?.kind === 'text'}
                {#key active.id}
                  <Editor bind:this={editorRef} session={s} fileId={active.id} readOnly={!s.canWrite} {diagnostics} getIndex={() => index} jumpLine={jump} onForwardSearch={forward} onCursor={(c) => (cursor = c)} onKeymapMode={(m) => (keymapMode = m)} onUserActivity={stopFollowing} />
                {/key}
              {:else if active?.kind === 'binary'}
                <div class="binary">
                  <p class="muted">{active.path} ({active.size ?? 0} bytes)</p>
                  {#if imageUrl}<img src={imageUrl} alt={active.path} />{:else}<p class="muted">No preview for this file type.</p>{/if}
                </div>
              {:else}
                <div class="blank">
                  {#if s.files.length === 0 && s.noPeerOnline && s.project.githubRepo}
                    <div class="notice" data-testid="bootstrap-banner">
                      <strong>No collaborator is online.</strong> This project is backed up on GitHub ({s.project.githubRepo}).
                      <div class="bb-act"><button type="button" class="primary" onclick={loadFromGithub} data-testid="load-github">Load the latest backup from GitHub</button></div>
                      <p class="muted">You need access to the repository (connect GitHub in the Backup panel). Your copy merges with your collaborators' automatically when they come online.</p>
                    </div>
                  {:else if s.files.length === 0}
                    <h2>An empty project</h2>
                    <p class="muted">{s.canWrite ? 'Create a file in the Files panel (main.tex is a good start), or import an Overleaf .zip or a folder.' : 'Nothing here yet. Files appear as soon as a co-author adds them.'}</p>
                  {:else}
                    <p class="muted">Select a file in the Files panel to start writing.</p>
                  {/if}
                </div>
              {/if}
            </div>
            <ProblemsPanel
              diagnostics={s.result?.diagnostics ?? []}
              failed={!!s.result && !s.result.ok}
              log={s.result?.log ?? ''}
              {compileError}
              note={s.engineNote && !s.engine ? s.engineNote : ''}
              hint={s.result && !s.result.ok ? (missingPackageHint(s.result.log, s.result.by.dev === s.myDeviceId ? s.compilerName : '') ?? '') : ''}
              expanded={layout.problems}
              onToggle={() => setLayout({ problems: !layout.problems })}
              onGo={reverse}
            >
              {#snippet help(d)}
                {@const h = helpFor(d, texts.get(d.file)?.split('\n')[d.line - 1] ?? '', texts.get(mainPath) ?? '')}
                {#if h}
                  <p class="help" data-testid="problem-help">{h.explanation}</p>
                  {#if h.fix && s.canWrite}<button type="button" class="small primary fix" onclick={() => h.fix && addPackage(h.fix.usepackage)} data-testid="problem-fix">{h.fix.label}</button>{/if}
                {/if}
              {/snippet}
            </ProblemsPanel>
          </section>
        {/if}
        {#if showEditor && showPdf}
          <Splitter label="Resize editor and PDF" value={layout.split * mainWidth} min={SPLIT_MIN * mainWidth} max={SPLIT_MAX * mainWidth} step={24} onresize={resizeSplit} ondblclick={() => setLayout({ split: 0.5 })} testid="split-splitter" />
        {/if}
        {#if showPdf}
          <section class="pdf-area" aria-label="PDF">
            <PdfView
              pdf={s.pdf}
              rev={s.pdfRev}
              stale={s.stale}
              compiledBy={s.compiledBy}
              syncIndex={s.syncIndex}
              editsSincePdf={s.editsSincePdf}
              bind:zoom={() => layout.zoom, (z) => setLayout({ zoom: z })}
              {highlight}
              onReverse={reverse}
              onHide={narrow ? undefined : togglePdf}
            />
          </section>
        {/if}
      </div>
    </div>

    {#if !layout.focus}
      <StatusBar
        session={s}
        {cursor}
        {keymapMode}
        onPeople={() => openPanel('people')}
        onSync={() => openPanel('sync')}
        onConflicts={() => (showConflicts = { initial: null })}
        onExportRecovery={() => void exportRecovery()}
        onUseDesktop={!isDesktop && s.engineKind !== 'native' && s.compileMode !== 'peers' ? compileWithDesktop : undefined}
        {pairing}
        {pairMessage}
      />
    {:else}
      {#if s.saveFailing}<button type="button" class="leave-focus save-failed" data-testid="save-failed-focus" onclick={() => void exportRecovery()}>Not saved on this device. Export a recovery copy</button>{/if}
      <button type="button" class="leave-focus" onclick={toggleFocus}><Icon icon={Minimize} size={14} />Leave focus mode</button>
    {/if}
  </div>

  {#if importRequest}
    {#key importRequest}
      <ImportDialog session={s} request={importRequest} onClose={importClosed} />
    {/key}
  {/if}

  {#if picker === 'cite'}
    <PickerDialog title="Insert a citation" placeholder="Search by key, author, title or year" testid="cite-picker" items={index.cites.map((c) => ({ id: c.key, primary: c.key, secondary: [c.author, c.detail].filter(Boolean).join(' · ') || undefined, meta: c.year }))} onPick={(it) => insertSoon(() => tex.cite(it.id))} onClose={() => (picker = null)}>
      {#snippet empty()}<p class="muted">This project has no bibliography yet. Add a <code>.bib</code> file with entries such as <code>@article{'{'}key, …{'}'}</code>, then try again.</p>{/snippet}
    </PickerDialog>
  {:else if picker === 'ref'}
    <PickerDialog title="Insert a cross-reference" placeholder="Search labels" testid="ref-picker" items={index.labels.map((l) => ({ id: l, primary: l }))} onPick={(it) => insertSoon(() => tex.ref(it.id))} onClose={() => (picker = null)}>
      {#snippet empty()}<p class="muted">No labels yet. Put <code>\label{'{'}sec:intro{'}'}</code> after a section, figure or equation to refer to it.</p>{/snippet}
    </PickerDialog>
  {:else if picker === 'figure'}
    <PickerDialog title="Insert a figure" placeholder="Search project images" testid="figure-picker" items={imageFiles.map((f) => ({ id: f.path, primary: f.path }))} onPick={(it) => insertSoon(() => tex.figure(it.id))} onClose={() => (picker = null)}>
      {#snippet empty()}<p class="muted">No images in this project yet. Upload a PNG, JPEG or PDF in the Files panel (or drop it there), then insert it here.</p>{/snippet}
    </PickerDialog>
  {:else if picker === 'table'}
    <TableDialog onInsert={(r, c) => insertSoon(() => tex.table(r, c))} onClose={() => (picker = null)} />
  {:else if picker === 'symbol'}
    <SymbolPalette onInsert={(cmd) => insertSoon((_sel, ctx) => tex.symbol(cmd, ctx.inMath))} onClose={() => (picker = null)} />
  {/if}

  {#if showTour && !layout.focus}
    <Tour onEnd={() => (showTour = false)} />
  {/if}

  {#if showConflicts && session}
    <ConflictDialog session={session} initial={showConflicts.initial} onClose={() => (showConflicts = null)} />
  {/if}
  {#if showShare}
    <ShareDialog session={s} onClose={() => (showShare = false)} />
  {/if}
  {#if showNetwork}
    <Dialog title="Network diagnostics" size="lg" onClose={() => (showNetwork = false)} testid="network-dialog">
      <NetworkDiagnostics session={s} projectId={s.project.id} />
    </Dialog>
  {/if}

  {#if showSettings}
    <ProjectSettings
      session={s}
      onClose={() => {
        showSettings = false;
        settingsTick++;
      }}
      onDeleted={() => go('/')}
    />
  {/if}
{/if}

<style>
  .ws-message {
    padding: 32px 24px;
    display: grid;
    gap: 12px;
    justify-items: start;
  }
  .ws {
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    background: var(--paper);
  }
  .ws.focus {
    grid-template-rows: minmax(0, 1fr);
    position: relative;
  }

  /* header */
  .ws-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: var(--header-h);
    padding: 0 10px 0 6px;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
    min-width: 0;
  }
  .back {
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: var(--r-m);
    color: var(--muted);
  }
  .back:hover {
    background: var(--sunken);
    color: var(--ink);
  }
  .crumb {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .slug {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .role {
    text-transform: capitalize;
  }
  .sp {
    flex: 1;
  }
  .hbtn {
    gap: 6px;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--line-strong);
    border-radius: var(--r-m);
    overflow: hidden;
  }
  .seg button {
    min-height: 30px;
    border: 0;
    border-radius: 0;
    background: var(--surface);
    color: var(--muted);
    font-weight: 500;
  }
  .seg button[aria-pressed='true'] {
    background: var(--sunken);
    color: var(--ink);
  }
  .split-btn {
    display: inline-flex;
  }
  .split-btn > button {
    border-radius: var(--r-m) 0 0 var(--r-m);
    gap: 6px;
  }
  .split-btn :global(.caret) {
    min-height: var(--control-h);
    padding: 0 8px;
    border-radius: 0 var(--r-m) var(--r-m) 0;
    border-left: 1px solid rgb(0 0 0 / 0.15);
  }
  .ws-head :global(.more) {
    width: 32px;
    min-height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
  }
  .ws-head :global(.more:hover) {
    background: var(--sunken);
    color: var(--ink);
  }

  /* body */
  .ws-body {
    position: relative;
    display: flex;
    min-height: 0;
    min-width: 0;
  }
  .rail {
    flex: none;
    width: var(--rail-w);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 0;
    background: var(--sunken);
    border-right: 1px solid var(--line);
  }
  .rail :global(.hx-iconbtn.active) {
    position: relative;
  }
  .rail :global(.hx-iconbtn.active::before) {
    content: '';
    position: absolute;
    left: -6px;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 2px;
    background: var(--honey);
  }
  .rail .sp {
    flex: 1;
  }
  .side {
    flex: none;
    width: var(--side-w);
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    overflow: hidden;
  }
  .side.overlay {
    position: absolute;
    left: var(--rail-w);
    top: 0;
    bottom: 0;
    z-index: 15;
    width: min(var(--side-w), calc(100% - var(--rail-w) - 24px));
    border-right: 1px solid var(--line);
    box-shadow: var(--shadow-2);
  }
  .files-panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .files-panel > :global(.filetree) {
    flex: 1;
  }
  .location {
    position: relative;
    flex: none;
    display: grid;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--line);
  }
  .loc-btn {
    justify-content: flex-start;
    gap: 6px;
    min-height: 28px;
    padding: 0 8px;
    border-color: transparent;
    background: transparent;
    color: var(--muted);
    font-weight: 400;
    font-size: var(--text-xs);
  }
  .loc-btn:hover {
    border-color: var(--line);
  }
  .loc-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
  }
  .location-menu {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: calc(100% - 4px);
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    background: var(--raised);
    border: 1px solid var(--line);
    border-radius: var(--r-l);
    box-shadow: var(--shadow-2);
  }
  .location-menu p {
    margin: 0 0 4px;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  /* editor + pdf */
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
  }
  .editor-area {
    flex: var(--split) 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--surface);
  }
  .pdf-area {
    flex: calc(1 - var(--split)) 1 0;
    min-width: 0;
    min-height: 0;
  }
  .conflict-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--bad-soft, #fdecec);
    color: var(--ink);
    border-bottom: 1px solid var(--bad);
    font-size: var(--text-sm);
  }
  .ed-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 6px 0 14px;
    border-bottom: 1px solid var(--line);
    min-width: 0;
  }
  .path {
    font: 500 var(--text-sm) var(--font-code);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ed-body {
    flex: 1;
    min-height: 0;
    display: grid;
  }
  .ed-body > :global(.editor-host) {
    min-height: 0;
  }
  .binary,
  .blank {
    padding: 24px;
    overflow: auto;
  }
  .binary img {
    max-width: 100%;
  }
  .blank h2 {
    margin: 0 0 6px;
    font-size: var(--text-lg);
  }
  .blank .notice {
    padding: 12px 14px;
  }
  .bb-act {
    margin: 8px 0;
  }
  .editor-area :global(.help) {
    margin: 4px 0 0;
    font-size: var(--text-sm);
    color: var(--ink);
    max-width: 70ch;
  }
  .editor-area :global(.fix) {
    margin-top: 6px;
  }
  .here {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
  }
  .unfollow {
    min-height: 0;
    margin-left: 6px;
    padding: 0 4px;
    border: 0;
    background: none;
    color: var(--honey-ink);
    font-size: var(--text-xs);
    text-decoration: underline;
  }
  .leave-focus {
    position: absolute;
    top: 8px;
    right: 16px;
    z-index: 30;
    gap: 6px;
    box-shadow: var(--shadow-2);
  }
  .leave-focus.save-failed {
    top: 48px;
    color: var(--bad);
  }
  .ws.narrow .lbl {
    display: none;
  }
</style>
