<script lang="ts">
  import { listRecovery, onRecoveryChange, readRecovery, type FileEntry, type RecoveryRecord, type DeletedFile } from '@hivetex/sync';
  import { ROOT_DOC_ID } from '@hivetex/protocol';
  import { onMount } from 'svelte';
  import type { ProjectSession } from '../../lib/session.svelte.js';
  let { session }: { session: ProjectSession } = $props();
  type Recoverable = FileEntry & { orphan?: boolean; conflict?: boolean; conflictUnknown?: boolean; deletionId?: string; deletion?: DeletedFile['deletion'] };
  let files = $state<Recoverable[]>([]);
  let privateCopies = $state<RecoveryRecord[]>([]);
  let binary = $state<Array<{ id: string; path: string; hashes: string[] }>>([]);
  let revision = $state(0);
  let message = $state('');
  let busy = $state(false);
  async function refresh(capture = false) {
    const state = await session.model.recoveryState();
    files = state.files;
    privateCopies = capture ? await session.folderRecoveries() ?? await listRecovery(session.store) : await listRecovery(session.store);
    binary = state.binary;
    revision = state.revision;
  }
  // Refresh on what can change Recovery (the file table, a deleted file's document, a new private copy), coalesced:
  // never one full Recovery read per co-author keystroke (D6).
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null, again = false;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (running) { again = true; return; }
      running = refresh().catch((e) => { message = String(e); }).finally(() => { running = null; if (again) { again = false; schedule(); } });
    }, 200);
  }
  onMount(() => {
    void refresh(true).catch((e) => message = String(e));
    const offs = [
      onRecoveryChange(session.store, schedule),
      session.model.onDocUpdate((docId) => {
        if (docId === ROOT_DOC_ID || (docId.startsWith('f:') && !session.model.byId(docId.slice(2)))) schedule();
      }),
      // A deleted file's content confirmed complete settles "conflict status unknown" into a definite status.
      session.model.onAvailability((docId) => {
        if (docId.startsWith('f:') && !session.model.byId(docId.slice(2))) schedule();
      }),
    ];
    return () => { clearTimeout(timer); for (const off of offs) off(); };
  });
  async function action(run: () => Promise<unknown> | unknown) {
    busy = true;
    try { await run(); await session.model.flush(); await refresh(); message = 'Recovery action saved.'; }
    catch (e) { message = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  function download(name: string, bytes: Uint8Array) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const a = Object.assign(document.createElement('a'), { href: url, download: name.split('/').pop() ?? 'recovery' });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function content(f: Recoverable) {
    if (f.kind === 'binary' && f.hash) return session.blobs.fetch(f.hash);
    const docId = `f:${f.id}`;
    await session.mesh.openDoc(docId);
    if (!f.orphan && session.model.availability(docId) !== 'complete') {
      await session.mesh.reconcile(docId);
      if (session.model.availability(docId) !== 'complete') throw new Error('This version has not been fully received. Connect a holder and retry; no empty stand-in was downloaded or restored.');
    }
    return new TextEncoder().encode((await session.model.openText(f.id)).toString());
  }
  async function restore(f: Recoverable, copy = false) {
    await content(f);
    const path = copy || session.model.find(f.path) ? `Recovered/${f.id}-${crypto.randomUUID().slice(0, 8)}-${f.path.split('/').pop()}` : f.path;
    if (copy || f.orphan) {
      if (!session.canWrite) throw new Error('Read-only');
      if (f.kind === 'text') await session.model.createTextNow(path, (await session.model.openText(f.id)).toString(), undefined, () => session.canWrite);
      else if (f.hash) session.model.createBinary(path, f.hash, f.size ?? 0);
    } else await session.model.restoreDeleted(f.id, f.deletionId!, path, () => session.canWrite);
  }
</script>

<section aria-label="Recovery" data-testid="recovery-section">
  <h3>Recovery</h3>
  <p>Deleted files and concurrent versions remain here. Unknown legacy authors and paths are shown explicitly. Folder recovery copies stay on this device.</p>
  {#if message}<p role="status">{message}</p>{/if}
  <button type="button" disabled={busy} onclick={() => action(() => refresh(true))}>Refresh recovery</button>
  {#if !files.length && !privateCopies.length && !binary.length}<p>No deleted files or recovery conflicts.</p>{/if}
  {#each files as f (f.id)}
    <article>
      <strong>{f.path}</strong>
      <p>{f.orphan ? 'Legacy orphan · original path and author unknown' : f.conflictUnknown ? 'Deleted file · conflict status unknown until content is received' : f.conflict ? 'Deleted file with a later or concurrent contribution' : 'Deleted file · contents retained'}</p>
      {#if f.deletion}<p>Deleted by {f.deletion.author?.actorName ?? f.deletion.author?.name ?? 'unknown original author'}{f.deletion.author?.device ? ` · device ${f.deletion.author.device}` : ''}</p>{/if}
      {#if f.kind !== 'dir'}<button type="button" disabled={busy} onclick={() => action(async () => download(f.path, await content(f)))}>Download version</button>{/if}
      {#if session.canWrite}
        <button type="button" disabled={busy} onclick={() => action(() => restore(f))}>Restore file</button>
        {#if f.conflict}
          <button type="button" disabled={busy} onclick={() => action(() => restore(f, true))}>Keep both as recovered copy</button>
          <button type="button" disabled={busy} onclick={() => action(() => session.model.confirmDeletion(f.id, f.deletionId!, revision, () => session.canWrite))}>Keep deleted, retain recovery</button>
        {/if}
      {/if}
    </article>
  {/each}
  {#each binary as conflict (conflict.id)}
    <article><strong>{conflict.path}: concurrent binary versions</strong>
      {#each conflict.hashes as hash (hash)}
        <p><code>{hash.slice(0, 12)}</code>
          <button type="button" disabled={busy} onclick={() => action(async () => download(conflict.path, await session.blobs.fetch(hash)))}>Download</button>
          {#if session.canWrite}<button type="button" disabled={busy} onclick={() => action(async () => { const previewRevision = revision; await session.blobs.fetch(hash); await session.model.resolveBinary(conflict.id, hash, () => session.canWrite, previewRevision); })}>Use this version</button>{/if}
        </p>
      {/each}
    </article>
  {/each}
  {#each privateCopies as record (record.id)}
    <article><strong>{record.path}</strong><p>Private folder copy · {record.reason} · {new Date(record.at).toLocaleString()}</p>
      <button type="button" disabled={busy} onclick={() => action(async () => download(record.path, await readRecovery(session.store, record.id)))}>Download private copy</button>
    </article>
  {/each}
</section>

<style>
  section { padding: 12px 14px; border-top: 1px solid var(--line); font-size: var(--text-sm); }
  p { color: var(--muted); overflow-wrap: anywhere; }
  article { padding: 10px 0; border-bottom: 1px solid var(--line); }
  button { margin: 3px; font-size: var(--text-xs); }
</style>
