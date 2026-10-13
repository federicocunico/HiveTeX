<script lang="ts">
  // Signed in: share a project that exists only on this computer (publish), or merge it into a project you join (link).
  import { api } from '../lib/api.js';
  import { type LocalProject, publishLocalProject, setPendingLink } from '../lib/local-projects.js';
  import { go } from '../lib/router.svelte.js';
  import type { ProjectInfo } from '../lib/session.svelte.js';
  import Button from '../ui/Button.svelte';
  import Dialog from '../ui/Dialog.svelte';

  let { project, onDone }: { project: LocalProject; onDone?: () => void } = $props();

  let mode = $state<'publish' | 'link' | null>(null);
  let slug = $state('');
  let password = $state('');
  let unprotected = $state(false);
  let busy = $state(false);
  let error = $state('');

  function open(m: 'publish' | 'link') {
    mode = m;
    error = '';
    slug = m === 'publish' ? project.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31) : '';
    password = '';
    unprotected = false;
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      if (mode === 'publish') {
        const info = await publishLocalProject(project, async () =>
          (await api<{ project: ProjectInfo }>('POST', '/projects', { ...(slug.trim() ? { slug: slug.trim() } : {}), ...(unprotected ? { passwordProtected: false } : { password }) })).project,
        );
        onDone?.();
        go(`/p/${info.id}`);
      } else {
        const r = await api<{ project: ProjectInfo }>('POST', '/projects/join', { slug: slug.trim(), password });
        setPendingLink(project.id, r.project.id);
        onDone?.();
        go(`/p/${r.project.id}`);
      }
      mode = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<span class="acts">
  <Button size="sm" onclick={() => open('publish')} data-testid="publish-local" title="Make it a shared project with an ID and password">Share…</Button>
  <Button size="sm" onclick={() => open('link')} data-testid="link-local" title="Join an existing project and merge these files into it">Merge into a project…</Button>
</span>

{#if mode}
  <Dialog title={mode === 'publish' ? `Share “${project.name}”` : `Merge “${project.name}” into a project`} onClose={() => (mode = null)} onsubmit={submit} size="md" testid="local-action-dialog">
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    {#if mode === 'publish'}
      <p class="muted">It becomes a shared project with exactly these files. Co-authors join with its ID and password.</p>
      <div class="field">
        <label for="lp-slug">Project name</label>
        <input id="lp-slug" type="text" bind:value={slug} placeholder="my-paper-2026" maxlength="31" data-testid="local-slug" />
        <p class="hint">1–31 characters (a–z, 0–9, -). A unique suffix is added automatically; copy the full ID from Share.</p>
      </div>
      <div class="field">
        <label for="lp-pw">Join password</label>
        <input id="lp-pw" type="password" bind:value={password} disabled={unprotected} required={!unprotected} minlength="8" autocomplete="new-password" data-testid="local-password" />
        <label class="check"><input type="checkbox" bind:checked={unprotected} /> No password (anyone with the ID can join)</label>
      </div>
    {:else}
      <p class="muted">You join the project, then these files are merged into it: new files are added, and files that differ are shown as conflicts for you to resolve.</p>
      <div class="field">
        <label for="lp-join-slug">Project ID</label>
        <input id="lp-join-slug" type="text" bind:value={slug} required data-testid="local-slug" />
      </div>
      <div class="field">
        <label for="lp-join-pw">Password</label>
        <input id="lp-join-pw" type="password" bind:value={password} autocomplete="current-password" data-testid="local-password" />
      </div>
    {/if}
    {#snippet footer()}
      <Button onclick={() => (mode = null)}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={busy} data-testid="local-action-submit">{mode === 'publish' ? (busy ? 'Sharing…' : 'Share') : busy ? 'Joining…' : 'Join and merge'}</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .acts {
    display: inline-flex;
    gap: 6px;
    flex-wrap: wrap;
  }
</style>
