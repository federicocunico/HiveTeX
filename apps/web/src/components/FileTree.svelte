<script lang="ts">
  import type { FileEntry } from '@p2platex/sync';
  import { type LooseItem, itemsFromDrop, itemsFromFiles } from '../lib/import/sources.js';

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

  const icon = (n: Node) => (isDir(n) ? (collapsed.has(n.path) ? '▸' : '▾') : n.entry?.kind === 'binary' ? '🖼' : '📄');
</script>

{#snippet branch(n: Node, depth: number)}
  {#each n.children as c (c.path)}
    <li
      role="treeitem"
      aria-selected={c.entry?.id === activeId}
      aria-expanded={isDir(c) ? !collapsed.has(c.path) : undefined}
      tabindex="0"
      onkeydown={(e) => {
        if (e.target === e.currentTarget && e.key === 'Enter') isDir(c) ? toggle(c.path) : c.entry && onOpen(c.entry);
      }}
    >
      <div
        class="node"
        data-dir={isDir(c) ? c.path : c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : ''}
        class:active={c.entry?.id === activeId}
        style={`padding-left: ${8 + depth * 14}px`}
        role="presentation"
        onclick={() => (isDir(c) ? toggle(c.path) : c.entry && onOpen(c.entry))}
      >
        <span aria-hidden="true">{icon(c)}</span>
        {#if renaming === c.path && c.entry}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            type="text"
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
          <span class="nm" title={c.path}>{c.name}{c.path === mainPath ? ' ★' : ''}</span>
        {/if}
        <span class="acts">
          {#if !isDir(c) && c.entry?.kind === 'binary'}
            <button class="ghost small" title="Download" aria-label={`Download ${c.name}`} onclick={(e) => { e.stopPropagation(); c.entry && onDownload(c.entry); }}>⬇</button>
          {/if}
          {#if canWrite}
            {#if isDir(c)}
              <button class="ghost small" title="New file here" aria-label={`New file in ${c.name}`} onclick={(e) => { e.stopPropagation(); adding = { kind: 'file', dir: c.path }; }}>＋</button>
              <button class="ghost small" title="Upload here" aria-label={`Upload into ${c.name}`} onclick={(e) => { e.stopPropagation(); uploadDir = c.path; fileInput.click(); }}>⬆</button>
            {:else if c.entry?.path.endsWith('.tex')}
              <button class="ghost small" title="Set as main file" aria-label={`Set ${c.name} as main file`} onclick={(e) => { e.stopPropagation(); c.entry && onSetMain(c.entry); }}>★</button>
            {/if}
            {#if c.entry}
              <button class="ghost small" title="Rename or move" aria-label={`Rename ${c.name}`} onclick={(e) => { e.stopPropagation(); renaming = c.path; renameTo = c.path; }}>✎</button>
              {#if confirmDelete === c.path}
                <button class="ghost small danger" onclick={(e) => { e.stopPropagation(); c.entry && onDelete(c.entry); confirmDelete = null; }}>Delete?</button>
              {:else}
                <button class="ghost small" title="Delete" aria-label={`Delete ${c.name}`} onclick={(e) => { e.stopPropagation(); confirmDelete = c.path; }}>🗑</button>
              {/if}
            {/if}
          {/if}
        </span>
      </div>
      {#if adding && adding.dir === c.path && isDir(c)}
        <div style={`padding-left: ${22 + depth * 14}px; margin: 2px 6px`}>
          <!-- svelte-ignore a11y_autofocus -->
          <input type="text" bind:value={addName} autofocus placeholder={adding.kind === 'file' ? 'name.tex' : 'folder'} onkeydown={(e) => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') adding = null; }} onblur={submitAdd} />
        </div>
      {/if}
      {#if isDir(c) && !collapsed.has(c.path)}
        <ul role="group">{@render branch(c, depth + 1)}</ul>
      {/if}
    </li>
  {/each}
{/snippet}

<div
  class="pane tree"
  class:dragover={dragging}
  role="region"
  aria-label="Project files"
  data-testid="file-tree"
  ondragover={(e) => { if (canWrite) { e.preventDefault(); dragging = true; } }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  <div class="row" style="padding: 8px; gap: 4px">
    <strong class="spacer">Files</strong>
    {#if canWrite}
      <button class="small" title="New file" aria-label="New file" onclick={() => { adding = { kind: 'file', dir: '' }; }}>＋ File</button>
      <button class="small" title="New folder" aria-label="New folder" onclick={() => { adding = { kind: 'folder', dir: '' }; }}>＋ Folder</button>
      <button class="small" title="Upload files" aria-label="Upload files" onclick={() => { uploadDir = ''; fileInput.click(); }}>⬆</button>
    {/if}
  </div>
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
    <div style="margin: 2px 8px">
      <!-- svelte-ignore a11y_autofocus -->
      <input type="text" bind:value={addName} autofocus placeholder={adding.kind === 'file' ? 'name.tex' : 'folder'} data-testid="new-name" onkeydown={(e) => { if (e.key === 'Enter') submitAdd(); if (e.key === 'Escape') adding = null; }} onblur={submitAdd} />
    </div>
  {/if}
  <ul role="tree" aria-label="Files">{@render branch(tree, 0)}</ul>
  {#if files.length === 0}<p class="muted" style="padding: 8px">Empty project. Create a file or drop files here.</p>{/if}
</div>
