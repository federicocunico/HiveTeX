<script lang="ts">
  import { DEFAULT_POLICY } from '@hivetex/github';
  import { onMount } from 'svelte';
  import { auth } from '../lib/auth.svelte.js';
  import { connectGithub, disconnectGithub, getGithubToken, githubLink } from '../lib/github.js';
  import type { ProjectSession } from '../lib/session.svelte.js';

  let { session }: { session: ProjectSession } = $props();

  let login = $state<string | null>(null);
  let hasToken = $state(false);
  let busy = $state(false);
  let error = $state('');
  let info = $state('');
  let mode = $state<'new' | 'existing'>('new');
  let repoName = $state(session.project.slug);
  let existing = $state('');
  let branch = $state('main');

  const isOwner = $derived(session.role === 'owner');
  const binding = $derived(session.githubBinding);
  const policy = $derived((void session.backupTick, session.backup?.policy ?? DEFAULT_POLICY));
  const meta = $derived((void session.backupTick, session.backup?.meta));
  const mismatch = $derived((void session.backupTick, session.backup?.bindingMismatch ?? false));
  const writerName = $derived.by(() => {
    void session.backupTick;
    const w = session.backup?.writer();
    if (!w) return null;
    if (w === session.myDeviceId) return 'this device';
    return session.peers.find((p) => p.dev === w)?.uname ?? 'another device';
  });

  async function refresh() {
    hasToken = !!(await getGithubToken());
    login = (await githubLink())?.login ?? null;
  }
  onMount(refresh);

  async function run(fn: () => Promise<unknown>, ok = '') {
    error = '';
    info = '';
    busy = true;
    try {
      await fn();
      if (ok) info = ok;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed';
    } finally {
      busy = false;
    }
  }

  const connect = () =>
    run(async () => {
      if (!auth.user) return;
      await connectGithub(auth.user.id);
      await session.backup?.tokenChanged();
      await refresh();
    }, 'GitHub connected');

  const disconnect = () =>
    run(async () => {
      await disconnectGithub();
      await session.backup?.tokenChanged();
      await refresh();
    }, 'GitHub disconnected on this device');

  const bind = () =>
    run(
      () => (mode === 'new' ? session.linkGithub(repoName.trim(), branch.trim() || 'main', true) : session.linkGithub(existing.trim(), branch.trim() || 'main')),
      'Repository linked. The first backup runs when edits settle (or press "Back up now").',
    );

  const unlink = () => run(() => session.unlinkGithub(), 'Backup disabled');
  const now = () => run(() => session.backup!.backupNow().then((r) => (r?.noop ? void (info = 'Nothing new to back up') : undefined)), 'Backup pushed');

  function savePolicy(patch: Record<string, unknown>) {
    try {
      session.backup?.setPolicy(patch);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed';
    }
  }

  const ago = (t: number) => (t ? new Date(t).toLocaleString() : 'never');
</script>

<section class="gh" data-testid="github-panel">
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  {#if info}<div class="notice" role="status">{info}</div>{/if}

  {#if !hasToken}
    <p class="muted">Connect your GitHub account to back this project up to a repository you choose. Your token stays on this device; the server never stores it.</p>
    <button class="primary" onclick={connect} disabled={busy} data-testid="github-connect">{busy ? 'Waiting for GitHub…' : 'Connect GitHub'}</button>
  {:else}
    <p>Connected as <strong>{login ?? 'GitHub user'}</strong> on this device. <button class="small" onclick={disconnect}>Disconnect</button></p>
  {/if}

  {#if isOwner && !binding && hasToken}
    <fieldset class="box">
      <legend>Link a repository</legend>
      <label class="row"><input type="radio" bind:group={mode} value="new" /> Create a new private repository</label>
      {#if mode === 'new'}<input type="text" bind:value={repoName} aria-label="New repository name" />{/if}
      <label class="row"><input type="radio" bind:group={mode} value="existing" /> Use an existing repository</label>
      {#if mode === 'existing'}<input type="text" bind:value={existing} placeholder="owner/repository" aria-label="Existing repository" />{/if}
      <label class="field">Branch <input type="text" bind:value={branch} /></label>
      <button class="primary" onclick={bind} disabled={busy || (mode === 'existing' && !existing.includes('/'))} data-testid="github-bind">Link repository</button>
    </fieldset>
  {/if}

  {#if binding}
    <div class="status" data-testid="github-status">
      <p>
        Backing up to <a href={`https://github.com/${binding.repo.owner}/${binding.repo.repo}/tree/${binding.branch}`} target="_blank" rel="noreferrer noopener">{binding.repo.owner}/{binding.repo.repo}@{binding.branch}</a>
        {#if isOwner}<button class="small" onclick={unlink}>Unlink</button>{/if}
      </p>
      <p class="muted">
        Last backup: {ago(meta?.lastBackupAt ?? 0)}
        {#if meta?.lastSha}· <a href={`https://github.com/${binding.repo.owner}/${binding.repo.repo}/commit/${meta.lastSha}`} target="_blank" rel="noreferrer noopener">{meta.lastSha.slice(0, 7)}</a>{/if}
        · {meta?.changesSince ?? 0} change{meta?.changesSince === 1 ? '' : 's'} since
        {#if writerName}· pushed by {writerName}{:else}· no device with GitHub access is online{/if}
      </p>
      {#if mismatch}<div class="error" data-testid="github-mismatch">This target was not set by an owner of the project (owner setting: {session.project.githubRepo ?? 'none'}). Nothing is pushed until an owner links the repository again.</div>{/if}
      {#if meta?.lastError}<div class="error" data-testid="github-error">{meta.lastError}</div>{/if}
      <button onclick={now} disabled={busy || !hasToken} data-testid="github-now">Back up now</button>
    </div>

    {#if isOwner}
      <fieldset class="box">
        <legend>When to back up</legend>
        <label class="row"><input type="checkbox" checked={policy.enabled} onchange={(e) => savePolicy({ enabled: e.currentTarget.checked })} /> Automatic backups</label>
        <div class="row wrap">
          <label>After idle (minutes) <input type="number" min="1" value={policy.idleMinutes ?? ''} onchange={(e) => savePolicy({ idleMinutes: e.currentTarget.value ? Number(e.currentTarget.value) : null })} /></label>
          <label>Every N changes <input type="number" min="1" value={policy.everyChanges ?? ''} onchange={(e) => savePolicy({ everyChanges: e.currentTarget.value ? Number(e.currentTarget.value) : null })} /></label>
          <label>At most every (minutes) <input type="number" min="1" value={policy.minIntervalMinutes} onchange={(e) => savePolicy({ minIntervalMinutes: Math.max(1, Number(e.currentTarget.value) || 5) })} /></label>
        </div>
        <label class="row"><input type="checkbox" checked={policy.includePdf} onchange={(e) => savePolicy({ includePdf: e.currentTarget.checked })} /> Also commit the compiled PDF</label>
      </fieldset>
    {/if}
  {:else if !isOwner}
    <p class="muted">The owner has not linked a GitHub repository.</p>
  {/if}
</section>

<style>
  .gh {
    display: grid;
    gap: 10px;
  }
  .gh p {
    margin: 0;
  }
  .gh :global(.error),
  .gh :global(.notice) {
    padding: 6px 10px;
  }
  .box {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--r-m);
  }
  .box legend {
    padding: 0 4px;
    font-weight: 500;
    font-size: var(--text-sm);
  }
  .box input[type='number'] {
    width: 5em;
  }
  .box input[type='text'] {
    width: 100%;
  }
  .status {
    display: grid;
    gap: 6px;
  }
  .status .muted {
    font-size: var(--text-xs);
  }
</style>
