<script lang="ts">
  import type { FileEntry } from '@hivetex/sync';
  import type { Snippet } from 'svelte';
  import { type LooseItem, itemsFromDrop, itemsFromFiles } from '../lib/import/sources.js';
  import { ChevronDown, ChevronRight, Download, FileCode, FileImage, FilePlus, FileText, Folder, FolderOpen, FolderPlus, Pencil, Star, Trash, Upload } from '../ui/icons.js';
  import Icon from '../ui/Icon.svelte';
  import IconButton from '../ui/IconButton.svelte';
  import PanelHead from './workspace/PanelHead.svelte';

  let {
    files,
    activeId,
    canWrite,
    mainPath,
    onOpen,
    onCreate,
    onRename,
    onDelete,
    onUpload,
    onDownload,
    onSetMain,
    headerExtra,
    presence = {},
  }: {
    files: FileEntry[];
    activeId: string | null;
    canWrite: boolean;
    mainPath: string;
    onOpen: (f: FileEntry) => void;
    onCreate: (path: string, kind: 'file' | 'folder') => void;
    onRename: (f: FileEntry, to: string) => void;
    onDelete: (f: FileEntry) => void;
    /** Files (and dropped folders) to add under `dir`; reading is deferred to the caller. */
    onUpload: (load: () => Promise<{ items: LooseItem[]; hasFolder: boolean }>, dir: string) => void;
    onDownload: (f: FileEntry) => void;
    onSetMain: (f: FileEntry) => void;
    /** Extra header actions (e.g. Import…). */
    headerExtra?: Snippet;
    /** Co-authors with each file open: path → [{ name, color }]. */
    presence?: Record<string, Array<{ name: string; color: string }>>;
  } = $props();

  interface Node {
    name: string;
    path: string;
    entry: FileEntry | null;
    children: Node[];
  }

  const tree = $derived.by(() => {
    const root: Node = { name: '', path: '', entry: null, children: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let cur = root;
      parts.forEach((part, i) => {
        const p = parts.slice(0, i + 1).join('/');
        let child = cur.children.find((c) => c.path === p);
        if (!child) {
          child = { name: part, path: p, entry: null, children: [] };
          cur.children.push(child);
        }
        if (i === parts.length - 1) child.entry = f;
        cur = child;
      });
    }
    const sort = (n: Node) => {
      n.children.sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name));
      n.children.forEach(sort);
    };
    sort(root);
    return root;
  });

  const isDir = (n: Node) => n.children.length > 0 || n.entry?.kind === 'dir';

  let collapsed = $state<Set<string>>(new Set());
  let adding = $state<null | { kind: 'file' | 'folder'; dir: string }>(null);
  let addName = $state('');
  let renaming = $state<string | null>(null);
  let renameTo = $state('');
  let confirmDelete = $state<string | null>(null);
  let dragging = $state(false);
  let fileInput: HTMLInputElement;
  let uploadDir = '';

  /** Starts naming a new file or folder at the top level (for the command palette). */
  export function startAdd(kind: 'file' | 'folder') {
    adding = { kind, dir: '' };
    addName = '';
  }

  /** Starts renaming `path` (for the command palette). */
  export function startRename(path: string) {
    renaming = path;
    renameTo = path;
  }

  function toggle(p: string) {
    const s = new Set(collapsed);
    if (s.has(p)) s.delete(p);
    else s.add(p);
    collapsed = s;
  }

  function submitAdd() {
    const name = addName.trim().replace(/^\/+/, '');
    if (adding && name) onCreate(adding.dir ? `${adding.dir}/${name}` : name, adding.kind);
    adding = null;
    addName = '';
  }

  function submitRename(f: FileEntry) {
    const to = renameTo.trim().replace(/^\/+/, '');
    if (to && to !== f.path) onRename(f, to);
    renaming = null;
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    if (!canWrite) return;
    const dt = e.dataTransfer;
    if (!dt || dt.files.length === 0) return;
    const dir = dropDir(e);
    // Directory entries are only valid during the event: start walking them now.
    const walking = itemsFromDrop(dt);
    const files = [...dt.files];
    onUpload(() => walking ?? Promise.resolve({ items: itemsFromFiles(files), hasFolder: false }), dir);
  }

  /** Dropping onto a folder row (or a file inside it) targets that folder. */
  function dropDir(e: DragEvent): string {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-dir]');
    return el?.dataset.dir ?? '';
  }

  function fileIcon(n: Node) {
    if (isDir(n)) return collapsed.has(n.path) ? Folder : FolderOpen;
    if (n.entry?.kind === 'binary') return FileImage;
    return /\.(tex|bib|sty|cls|bst|txt|md)$/i.test(n.name) ? FileText : FileCode;
  }

  /** Arrow-key navigation between visible tree items (WAI-ARIA tree). */
  function onTreeKey(e: KeyboardEvent, n: Node) {
    const items = [...((e.currentTarget as HTMLElement).closest('[role="tree"]')?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const i = items.indexOf(e.currentTarget as HTMLElement);
    if (e.key === 'ArrowDown') items[i + 1]?.focus();
    else if (e.key === 'ArrowUp') items[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && isDir(n) && collapsed.has(n.path)) toggle(n.path);
    else if (e.key === 'ArrowLeft' && isDir(n) && !collapsed.has(n.path)) toggle(n.path);
    else return;
    e.preventDefault();
  }
</script>

{#snippet branch(n: Node, depth: number)}
  {#each n.children as c (c.path)}
    <li
      role="treeitem"
      aria-selected={c.entry?.id === activeId}
      aria-expanded={isDir(c) ? !collapsed.has(c.path) : undefined}
      tabindex="0"
      onkeydown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') isDir(c) ? toggle(c.path) : c.entry && onOpen(c.entry);
        else onTreeKey(e, c);
      }}
    >
      <div
        class="node"
        data-dir={isDir(c) ? c.path : c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : ''}
        class:active={c.entry?.id === activeId}
        style:padding-left="{6 + depth * 14}px"
        role="presentation"
        onclick={() => (isDir(c) ? toggle(c.path) : c.entry && onOpen(c.entry))}
      >
        <span class="chev" aria-hidden="true">{#if isDir(c)}<Icon icon={collapsed.has(c.path) ? ChevronRight : ChevronDown} size={14} />{/if}</span>
        <Icon icon={fileIcon(c)} size={15} class="ficon" />
        {#if renaming === c.path && c.entry}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            type="text"
            aria-label={`New path for ${c.name}`}
            bind:value={renameTo}
            autofocus
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') submitRename(c.entry as FileEntry);
              if (e.key === 'Escape') renaming = null;
            }}
            onblur={() => (renaming = null)}
          />
        {:else}
          <span class="nm" title={c.path}>{c.name}</span>
          {#if c.path === mainPath}<span class="main-badge" data-testid="main-badge" data-tip="Main document: compiling starts here">Main</span>{/if}
        {/if}
        {#each presence[c.path] ?? [] as p (p.name)}<span class="pdot" style:background={p.color} data-tip="{p.name} is here" data-testid="presence-dot"><span class="sr-only">{p.name} is here</span></span>{/each}
        <span class="acts">
          {#if !isDir(c) && c.entry?.kind === 'binary'}
            <IconButton icon={Download} size={24} label={`Download ${c.name}`} tip="Download" onclick={(e) => { e.stopPropagation(); c.entry && onDownload(c.entry); }} />
          {/if}
          {#if canWrite}
            {#if isDir(c)}
              <IconButton icon={FilePlus} size={24} label={`New file in ${c.name}`} tip="New file here" onclick={(e) => { e.stopPropagation(); adding = { kind: 'file', dir: c.path }; }} />
              <IconButton icon={Upload} size={24} label={`Upload into ${c.name}`} tip="Upload here" onclick={(e) => { e.stopPropagation(); uploadDir = c.path; fileInput.click(); }} />
            {:else if c.entry?.path.endsWith('.tex') && c.path !== mainPath}
              <IconButton icon={Star} size={24} label={`Set ${c.name} as main file`} tip="Set as main document" onclick={(e) => { e.stopPropagation(); c.entry && onSetMain(c.entry); }} />
            {/if}
            {#if c.entry}
              <IconButton icon={Pencil} size={24} label={`Rename ${c.name}`} tip="Rename or move" onclick={(e) => { e.stopPropagation(); renaming = c.path; renameTo = c.path; }} />
              {#if confirmDelete === c.path}
                <button type="button" class="confirm" onclick={(e) => { e.stopPropagation(); c.entry && onDelete(c.entry); confirmDelete = null; }}>Delete?</button>
              {:else}
                <IconButton icon={Trash} size={24} label={`Delete ${c.name}`} tip="Delete" onclick={(e) => { e.stopPropagation(); confirmDelete = c.path; }} />
              {/if}
            {/if}
          {/if}
        </span>
      </div>
      {#if adding && adding.dir === c.path && isDir(c)}
        <div class="adding" style:padding-left="{26 + depth * 14}px">
          <!-- svelte-ignore a11y_autofocus -->
          <input type="text" aria-label={adding.kind === 'file' ? 'New file name' : 'New folder name'} bind:value={addName} autofocus placeholder={adding.kind === 'file' ? 'name.tex' : 'folder'} onkeydown={(e) => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') adding = null; }} onblur={submitAdd} />
        </div>
      {/if}
      {#if isDir(c) && !collapsed.has(c.path)}
        <ul role="group">{@render branch(c, depth + 1)}</ul>
      {/if}
    </li>
  {/each}
{/snippet}

<div
  class="filetree"
  class:dragover={dragging}
  role="region"
  aria-label="Project files"
  data-testid="file-tree"
  ondragover={(e) => { if (canWrite) { e.preventDefault(); dragging = true; } }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  <PanelHead title="Files">
    {#if canWrite}
      <IconButton icon={FilePlus} size={28} label="New file" onclick={() => { adding = { kind: 'file', dir: '' }; }} />
      <IconButton icon={FolderPlus} size={28} label="New folder" onclick={() => { adding = { kind: 'folder', dir: '' }; }} />
      <IconButton icon={Upload} size={28} label="Upload files" onclick={() => { uploadDir = ''; fileInput.click(); }} />
    {/if}
    {@render headerExtra?.()}
  </PanelHead>
  <input
    bind:this={fileInput}
    type="file"
    multiple
    hidden
    data-testid="upload-input"
    onchange={(e) => {
      const input = e.currentTarget as HTMLInputElement;
      const files = [...(input.files ?? [])];
      const dir = uploadDir;
      onUpload(async () => ({ items: itemsFromFiles(files), hasFolder: false }), dir);
      input.value = '';
    }}
  />
  {#if adding && adding.dir === ''}
    <div class="adding">
      <!-- svelte-ignore a11y_autofocus -->
      <input type="text" aria-label={adding.kind === 'file' ? 'New file name' : 'New folder name'} bind:value={addName} autofocus placeholder={adding.kind === 'file' ? 'name.tex' : 'folder'} data-testid="new-name" onkeydown={(e) => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') adding = null; }} onblur={submitAdd} />
    </div>
  {/if}
  <ul role="tree" aria-label="Files" class="tree">{@render branch(tree, 0)}</ul>
  {#if files.length === 0}
    <p class="empty">{canWrite ? 'This project is empty. Create a file, or drop files and folders here.' : 'This project is empty.'}</p>
  {/if}
</div>

<style>
  .filetree {
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .filetree.dragover {
    outline: 2px dashed var(--honey-ink);
    outline-offset: -4px;
  }
  .tree,
  .tree :global(ul) {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .tree {
    padding: 0 6px 8px;
    overflow: auto;
  }
  li:focus-visible {
    outline: none;
  }
  li:focus-visible > .node {
    outline: 2px solid var(--honey-ink);
    outline-offset: -2px;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 28px;
    padding-right: 4px;
    border-radius: var(--r-s);
    font-size: 13.5px;
    cursor: pointer;
  }
  .node:hover {
    background: var(--sunken);
  }
  .node.active {
    background: var(--honey-soft);
    font-weight: 500;
  }
  .chev {
    width: 14px;
    display: inline-flex;
    color: var(--faint);
    flex: none;
  }
  .node :global(.ficon) {
    color: var(--muted);
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .main-badge {
    flex: none;
    padding: 1px 5px;
    border-radius: var(--r-s);
    background: var(--honey-soft);
    color: var(--honey-ink);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .pdot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .acts {
    display: none;
    gap: 0;
    flex: none;
  }
  .node:hover .acts,
  .node:focus-within .acts,
  li:focus-visible > .node .acts {
    display: flex;
  }
  .confirm {
    min-height: 24px;
    padding: 0 8px;
    border-color: var(--bad);
    color: var(--bad);
    font-size: var(--text-xs);
  }
  .adding {
    margin: 2px 6px;
  }
  .adding input,
  .node input {
    width: 100%;
    min-height: 26px;
    padding: 2px 6px;
    font-size: 13px;
  }
  .empty {
    margin: 4px 14px;
    color: var(--muted);
    font-size: var(--text-sm);
  }
</style>
