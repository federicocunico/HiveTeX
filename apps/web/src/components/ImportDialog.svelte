<script lang="ts" module>
  import type { ImportBundle, LooseItem, Progress } from '../lib/import/sources.js';

  /** What the dialog was opened for. */
  export type ImportRequest =
    /** "Import…" button: let the user pick an archive, files or a folder. */
    | { kind: 'pick' }
    /** A single archive was uploaded/dropped into the tree: extract it, or add it as a file? */
    | { kind: 'archive-choice'; item: LooseItem; dir: string }
    /** Something to read (archive, folder, files). `fresh` = new project: skip the preview unless ambiguous. */
    | { kind: 'load'; name: string; load: (p: Progress) => Promise<ImportBundle>; fresh?: boolean };
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { isDesktop } from '../lib/api.js';
  import { SKIP_LABEL } from '../lib/import/filter.js';
  import type { ApplyResult, ImportMode, ImportPlan, Resolution } from '../lib/import/plan.js';
  import { ARCHIVE_ACCEPT, SUPPORTED_FORMATS, itemsFromFiles, readArchive, readLoose } from '../lib/import/sources.js';
  import type { ProjectSession } from '../lib/session.svelte.js';

  let {
    session,
    request,
    onClose,
  }: {
    session: ProjectSession;
    request: ImportRequest;
    /** Called when the dialog closes; `mainPath` is set when an import changed the main file. */
    onClose: (r?: { result: ApplyResult; mainPath?: string }) => void;
  } = $props();

  type Stage = 'pick' | 'archive-choice' | 'reading' | 'preview' | 'applying' | 'summary' | 'error';
  let stage = $state<Stage>('pick');
  let progress = $state<{ done: number; total: number; label: string } | null>(null);
  let errorMsg = $state('');
  let bundle = $state<ImportBundle | null>(null);
  let plan = $state<ImportPlan | null>(null);
  let mode = $state<ImportMode>('merge');
  let confirmReplace = $state(false);
  let resolutions = $state<Record<string, Resolution>>({});
  let mainChoice = $state('');
  let result = $state<ApplyResult | null>(null);
  let showSkipped = $state(false);
  let dialogEl: HTMLDivElement;
  let fileInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();

  const currentMain = () => {
    const m = session.model.settings.get('main');
    return typeof m === 'string' ? m : null;
  };
  const engineSet = () => session.model.settings.get('engine') !== undefined;

  /** Paths of `.tex` files the project will contain after import, for the main-file picker. */
  const texChoices = $derived.by(() => {
    if (!bundle) return [];
    const set = new Set(bundle.files.filter((f) => f.path.endsWith('.tex')).map((f) => f.path));
    if (mode === 'merge') for (const f of session.files) if (f.path.endsWith('.tex')) set.add(f.path);
    const cands = new Set(bundle.detection.candidates);
    return [...set].sort((a, b) => Number(cands.has(b)) - Number(cands.has(a)) || a.localeCompare(b));
  });

  const counts = $derived(
    plan && bundle
      ? {
          added: plan.added.length,
          changed: plan.changed.length,
          identical: plan.identical.length,
          skipped: bundle.skipped.length,
          converted: bundle.files.filter((f) => f.kind === 'text' && f.converted).length,
          removed: mode === 'replace' ? plan.removed.length : 0,
        }
      : null,
  );

  onMount(() => {
    if (request.kind === 'load') void start(request.load, request.fresh ?? false);
    else stage = request.kind;
    void tick().then(focusFirst);
  });

  function focusFirst() {
    dialogEl?.querySelector<HTMLElement>('button:not([disabled]), input, select')?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && stage !== 'applying' && stage !== 'reading') {
      e.preventDefault();
      close();
    }
    if (e.key !== 'Tab') return;
    const els = [...dialogEl.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([hidden]):not([disabled]), select, summary, [tabindex="0"]')];
    if (els.length === 0) return;
    const first = els[0] as HTMLElement;
    const last = els[els.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function close() {
    const main = currentMain();
    onClose(result ? { result, ...(main ? { mainPath: main } : {}) } : undefined);
  }

  const onProgress = (label: string) => (done: number, total: number) => {
    progress = { done, total, label };
  };

  async function start(load: (p: Progress) => Promise<ImportBundle>, fresh: boolean) {
    stage = 'reading';
    errorMsg = '';
    progress = null;
    try {
      const b = await load(onProgress('Reading'));
      if (b.files.length === 0) throw new Error(b.skipped.length ? 'Nothing to import: every file was skipped.' : 'Nothing to import.');
      bundle = b;
      plan = await session.planImport(b);
      const cur = currentMain();
      const hasMain = !!cur && !!session.model.find(cur);
      mainChoice = hasMain ? (cur as string) : (b.detection.main ?? '');
      const empty = session.files.length === 0;
      if ((fresh || empty) && !b.detection.ambiguous && plan.changed.length === 0) await apply();
      else {
        stage = 'preview';
        await tick();
        focusFirst();
      }
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      stage = 'error';
    }
  }

  function setAll(r: Resolution) {
    if (!plan) return;
    resolutions = Object.fromEntries(plan.changed.map((c) => [c.file.path, r]));
  }

  async function apply() {
    if (!plan || !bundle) return;
    if (mode === 'replace' && !confirmReplace) {
      confirmReplace = true;
      return;
    }
    stage = 'applying';
    progress = null;
    try {
      const cur = currentMain();
      const willMain = mainChoice && mainChoice !== cur ? mainChoice : undefined;
      // Engine only when the project has none and the import's main file asks for one.
      const mainIsImported = bundle.detection.main && (willMain ?? cur) === bundle.detection.main;
      const engine = !engineSet() && mainIsImported && bundle.engine ? bundle.engine : undefined;
      result = await session.applyImport(
        plan,
        { mode, resolutions: new Map(Object.entries(resolutions)), defaultResolution: 'keep', main: willMain, engine },
        onProgress('Importing'),
      );
      stage = 'summary';
      await tick();
      focusFirst();
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : String(e);
      stage = 'error';
    }
  }

  // ---- pick stage ----

  function pickedFiles(list: File[], folder: boolean) {
    if (list.length === 0) return;
    const single = list.length === 1 ? (list[0] as File) : null;
    if (!folder && single && /\.(zip|tar|tgz|gz|rar|7z)$/i.test(single.name)) {
      void start(async () => readArchive(single.name, new Uint8Array(await single.arrayBuffer())), false);
    } else {
      const name = folder ? ((list[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0] ?? 'folder') : `${list.length} files`;
      void start((p) => readLoose(name, itemsFromFiles(list), { stripRoot: folder }, p), false);
    }
  }

  async function pickDesktopFolder() {
    const { pickFolder, folderItems } = await import('../lib/tauri-fs.js');
    const dir = await pickFolder('Choose a folder to import');
    if (!dir) return;
    void start(async (p) => {
      const f = await folderItems(dir);
      try {
        return await readLoose(dir.split(/[\\/]/).pop() ?? 'folder', f.items, { stripRoot: false }, p);
      } finally {
        await f.done();
      }
    }, false);
  }

  // ---- archive-choice stage ----

  function extract() {
    if (request.kind !== 'archive-choice') return;
    const { item, dir } = request;
    void start(async () => readArchive(item.path, await item.read(), dir || undefined), false);
  }

  function addAsFile() {
    if (request.kind !== 'archive-choice') return;
    const { item, dir } = request;
    const name = item.path.split('/').pop() ?? item.path;
    void start((p) => readLoose(name, [{ ...item, path: name }], { stripRoot: false, ...(dir ? { prefix: dir } : {}) }, p), false);
  }
</script>

<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="import-title" data-testid="import-dialog" tabindex="-1" bind:this={dialogEl} onkeydown={onKey}>
  <div class="card import-card">
    <h2 id="import-title">Import</h2>

    {#if stage === 'pick'}
      <p class="muted">Bring in an Overleaf or GitHub <strong>.zip</strong>, an arXiv <strong>.tar.gz</strong>, a folder, or individual files. Everything is read on this device; nothing is uploaded to the server.</p>
      <div class="row wrap" style="gap: 8px">
        <button class="primary" onclick={() => fileInput?.click()} data-testid="import-pick-files">Archive or files…</button>
        {#if isDesktop}
          <button onclick={pickDesktopFolder}>Folder…</button>
        {:else}
          <button onclick={() => folderInput?.click()} data-testid="import-pick-folder">Folder…</button>
        {/if}
        <span class="spacer"></span>
        <button onclick={close}>Cancel</button>
      </div>
      <input bind:this={fileInput} type="file" multiple hidden accept={`${ARCHIVE_ACCEPT},*/*`} data-testid="import-input" onchange={(e) => pickedFiles([...((e.currentTarget as HTMLInputElement).files ?? [])], false)} />
      <input bind:this={folderInput} type="file" hidden webkitdirectory data-testid="import-folder-input" onchange={(e) => pickedFiles([...((e.currentTarget as HTMLInputElement).files ?? [])], true)} />
      <p class="muted small-print">Supported: {SUPPORTED_FORMATS}.</p>
    {:else if stage === 'archive-choice' && request.kind === 'archive-choice'}
      <p><strong>{request.item.path.split('/').pop()}</strong> is an archive. Extract its contents into the project, or add the archive itself as a file?</p>
      <div class="row wrap" style="gap: 8px">
        <button class="primary" onclick={extract} data-testid="archive-extract">Extract</button>
        <button onclick={addAsFile} data-testid="archive-add-file">Add as file</button>
        <span class="spacer"></span>
        <button onclick={close}>Cancel</button>
      </div>
    {:else if stage === 'reading' || stage === 'applying'}
      <p role="status">{stage === 'reading' ? 'Reading…' : 'Importing…'}</p>
      {#if progress}
        <progress max={progress.total} value={progress.done} aria-label={progress.label} style="width: 100%"></progress>
        <p class="muted">{progress.done} / {progress.total}</p>
      {/if}
    {:else if stage === 'error'}
      <div class="error" role="alert" data-testid="import-error">{errorMsg}</div>
      <p class="muted">The project was not changed.</p>
      <div class="row"><span class="spacer"></span><button onclick={close}>Close</button></div>
    {:else if stage === 'preview' && plan && bundle && counts}
      <p>
        <strong>{bundle.name}</strong>:
        <span data-testid="count-added">{counts.added} new</span>,
        <span data-testid="count-changed">{counts.changed} changed</span>,
        <span>{counts.identical} identical</span>{#if counts.skipped}, <span>{counts.skipped} skipped</span>{/if}{#if counts.converted}, <span>{counts.converted} converted from a legacy encoding</span>{/if}.
      </p>

      {#if session.files.length > 0}
        <fieldset class="modes">
          <legend class="muted">How to combine with the current project</legend>
          <label class="row"><input type="radio" name="mode" value="merge" bind:group={mode} onchange={() => (confirmReplace = false)} /> Add and update files (keep everything else)</label>
          <label class="row"><input type="radio" name="mode" value="replace" bind:group={mode} data-testid="mode-replace" /> Replace project contents ({plan.removed.length} file{plan.removed.length === 1 ? '' : 's'} will be deleted)</label>
        </fieldset>
      {/if}

      {#if mode === 'merge' && plan.changed.length > 0}
        <div class="row" style="gap: 8px; margin-top: 8px">
          <strong class="spacer">Files that already exist with different content</strong>
          <button class="small" onclick={() => setAll('overwrite')} data-testid="overwrite-all">Overwrite all</button>
          <button class="small" onclick={() => setAll('keep')} data-testid="keep-all">Keep all</button>
        </div>
        <ul class="filelist" data-testid="conflicts">
          {#each plan.changed as c (c.file.path)}
            <li class="row">
              <span class="spacer" title={c.file.path}>{c.file.path}</span>
              <select aria-label={`Resolution for ${c.file.path}`} value={resolutions[c.file.path] ?? 'keep'} onchange={(e) => (resolutions = { ...resolutions, [c.file.path]: (e.currentTarget as HTMLSelectElement).value as Resolution })}>
                <option value="keep">Keep existing</option>
                <option value="overwrite">Overwrite</option>
              </select>
            </li>
          {/each}
        </ul>
      {/if}

      {#if texChoices.length > 0}
        <label class="field" style="margin-top: 8px">Main file {#if bundle.detection.ambiguous}<small>several documents found; please confirm</small>{/if}
          <select bind:value={mainChoice} data-testid="main-select">
            {#each texChoices as p}<option value={p}>{p}{bundle.detection.candidates.includes(p) ? '' : ' (no \\documentclass)'}</option>{/each}
          </select>
        </label>
      {/if}
      {#if bundle.engine && !engineSet()}<p class="muted">Compiler: {bundle.engine} (detected from the main file).</p>{/if}

      {#if bundle.skipped.length > 0}
        <details>
          <summary>{bundle.skipped.length} skipped</summary>
          <ul class="filelist">{#each bundle.skipped as s}<li>{s.path} <span class="muted">— {SKIP_LABEL[s.reason]}</span></li>{/each}</ul>
        </details>
      {/if}

      <div class="row" style="margin-top: 12px; gap: 8px">
        <span class="spacer"></span>
        <button onclick={close}>Cancel</button>
        <button class={mode === 'replace' ? 'danger' : 'primary'} onclick={apply} data-testid="import-confirm">
          {mode === 'replace' ? (confirmReplace ? 'Really replace everything?' : 'Replace project') : 'Import'}
        </button>
      </div>
    {:else if stage === 'summary' && result && bundle}
      <p role="status" data-testid="import-summary">
        Imported {result.added} new file{result.added === 1 ? '' : 's'}{#if result.overwritten}, overwrote {result.overwritten}{/if}{#if result.kept}, kept {result.kept} existing{/if}{#if result.identical}, {result.identical} already identical{/if}{#if result.removed}, deleted {result.removed}{/if}.
      </p>
      {#if bundle.files.some((f) => f.kind === 'text' && f.converted)}
        <details open>
          <summary>Converted from a legacy encoding (check accented characters)</summary>
          <ul class="filelist" data-testid="converted-list">{#each bundle.files.filter((f) => f.kind === 'text' && f.converted) as f}<li>{f.path}</li>{/each}</ul>
        </details>
      {/if}
      {#if bundle.skipped.length > 0}
        <details bind:open={showSkipped}>
          <summary data-testid="skipped-summary">{bundle.skipped.length} skipped</summary>
          <ul class="filelist">{#each bundle.skipped as s}<li>{s.path} <span class="muted">— {SKIP_LABEL[s.reason]}</span></li>{/each}</ul>
        </details>
      {/if}
      <div class="row"><span class="spacer"></span><button class="primary" onclick={close} data-testid="import-done">Done</button></div>
    {/if}
  </div>
</div>

<style>
  .import-card {
    width: min(640px, 100%);
    max-height: 85vh;
    overflow: auto;
  }
  .filelist {
    max-height: 220px;
    overflow: auto;
    margin: 6px 0;
    padding-left: 18px;
  }
  .filelist li {
    gap: 8px;
    padding: 2px 0;
  }
  .modes {
    border: 1px solid var(--border, #ddd);
    border-radius: 6px;
    padding: 6px 10px;
  }
  .small-print {
    font-size: 0.85em;
    margin-bottom: 0;
  }
</style>
