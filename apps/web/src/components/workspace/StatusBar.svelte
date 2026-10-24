<script lang="ts">
  import type { ProjectSession } from '../../lib/session.svelte.js';
  import { go } from '../../lib/router.svelte.js';
  import { prefs } from '../../lib/preferences.svelte.js';
  import Dialog from '../../ui/Dialog.svelte';
  import { saveWarning, syncLabel } from '../../lib/sync-view.js';
  import { Cpu, RefreshCw, Users, WifiOff } from '../../ui/icons.js';
  import Icon from '../../ui/Icon.svelte';

  /** Independent save/sync/build summaries; full details remain keyboard-accessible. */
  let {
    session: s,
    cursor = null,
    keymapMode = '',
    onPeople,
    onSync,
    onConflicts,
    onExportRecovery,
    onUseDesktop,
    pairing = false,
    pairMessage = '',
  }: {
    session: ProjectSession;
    cursor?: { line: number; col: number } | null;
    /** e.g. "-- NORMAL --" with the Vim keymap. */
    keymapMode?: string;
    onPeople?: () => void;
    /** Opens the Sync panel. */
    onSync?: () => void;
    /** Opens the conflict resolution dialog. */
    onConflicts?: () => void;
    /** Downloads a recovery copy of the project as held in memory (shown while saving fails). */
    onExportRecovery?: () => void;
    /** Web: compile with the HiveTeX desktop app on this computer (absent when that does not apply). */
    onUseDesktop?: (() => void) | undefined;
    pairing?: boolean;
    pairMessage?: string;
  } = $props();

  let details = $state(false);
  const others = $derived(s.peers.length);
  const connecting = $derived(s.connecting.length);
  const peopleText = $derived(
    others === 0 && connecting === 0
      ? 'No co-authors online'
      : `${others === 0 ? 'No co-authors connected' : `${others} co-author${others === 1 ? '' : 's'} online`}${connecting ? ` (${connecting} connecting)` : ''}`,
  );
  const status = $derived(s.syncStatus);
  const busy = $derived(status?.stage === 'receiving' || status?.stage === 'reconciling' || status?.stage === 'connecting');
  const schedule = $derived(prefs.compileSchedule === 'manual' ? 'Manual' : prefs.compileSchedule === 'periodic' ? `Every ${prefs.compileIntervalSeconds} s` : 'After changes');
  const build = $derived(s.compilerPhase === 'setting-up' ? 'Setting up compiler' : s.compileStatus === 'compiling' ? 'Building' : !s.engine ? 'Compiler unavailable' : s.compileStatus === 'error' ? 'Build failed' : s.pdf && s.stale ? 'PDF outdated' : s.pdf ? 'PDF up to date' : 'No PDF yet');
  const scheduleState = $derived(s.compileStatus === 'compiling' ? 'Building' : !s.engine ? 'Compiler unavailable' : s.compileWaiting ? 'Waiting for changes to settle' : s.compileStatus === 'error' ? 'Build failed — retry or edit' : schedule);
</script>

<footer class="statusbar" data-testid="statusbar">
  {#if s.saveFailing}
    <span class="pill bad" role="alert" data-testid="save-failed">Not saved on this device</span>
    <button type="button" class="item linkish critical" onclick={onExportRecovery} data-testid="export-recovery">Export recovery copy</button>
  {:else}
    <span class="item" data-testid="save-state">Saved on this device</span>
  {/if}
  {#if s.offline || s.paused}
    <button type="button" class="item linkish warn" onclick={onSync} data-testid="offline-pill" aria-label="Offline: edits are kept and sync when you reconnect" data-tip="Edits are kept and sync when you reconnect"><Icon icon={WifiOff} size={13} />Offline</button>
  {:else}
    <button type="button" class="item linkish sync {status?.stage === 'synced' ? 'ok' : ''}" onclick={onSync} data-testid="sync-status" data-stage={status?.stage ?? 'alone'} data-tip={syncLabel(status, Date.now(), s.saveFailing)}>
      <Icon icon={RefreshCw} size={13} /><span role="status">{!status || status.stage === 'alone' ? 'Waiting for co-authors' : syncLabel(status, Date.now(), s.saveFailing)}</span>
    </button>
    {#if busy && status?.stalled}<button type="button" class="item linkish" onclick={() => void s.syncNow()} disabled={s.syncingNow} data-testid="sync-now-inline">Sync now</button>{/if}
  {/if}
  {#if s.conflicts.length}
    <button type="button" class="pill bad" onclick={onConflicts} data-testid="conflicts-pill">{s.conflicts.length} conflict{s.conflicts.length === 1 ? '' : 's'} to resolve</button>
  {:else if s.unsharedWork}
    <span class="item" data-testid="unshared-work" data-tip="These changes merge when a co-author connects">Unshared changes</span>
  {/if}
  <button type="button" class="item linkish" onclick={() => s.setPaused(!s.paused)} data-testid="pause-sync">{s.paused ? 'Resume sync' : 'Work offline'}</button>
  <button type="button" class="item linkish people" onclick={onPeople} data-tip={peopleText}>
    <Icon icon={Users} size={13} /><span data-testid="peer-count">{peopleText}{others ? `: ${s.peers.map((p) => p.uname).join(', ')}` : ''}</span>
  </button>
  <span class="sp"></span>
  <button type="button" class="item linkish build" class:warn={s.stale || s.compileStatus === 'error' || !s.engine} onclick={() => (details = true)} data-testid="build-status" aria-label={`Build details: ${build}. ${scheduleState}`}>
    <Icon icon={Cpu} size={13} />{#if build !== scheduleState}<span>{build}</span><span aria-hidden="true">·</span>{/if}<span data-testid="compile-schedule-state" role="status">{scheduleState}</span>
  </button>
  <button type="button" class="item linkish" onclick={() => (details = true)} data-testid="status-details">Status details</button>
  {#if keymapMode}<span class="item mono" data-testid="keymap-mode">{keymapMode}</span>{/if}
  {#if cursor}<span class="item num" data-testid="cursor-pos">Ln {cursor.line}, Col {cursor.col}</span>{/if}
  {#if s.revoked}<span class="pill bad">You no longer have access</span>{/if}
  {#if s.mirrorNotice}<span class="pill warn" role="status">{s.mirrorNotice}</span>{/if}
  {#if s.compileMigrationNotice}<button type="button" class="item linkish" onclick={() => (details = true)}>Compilation changed</button>{/if}
  {#if pairMessage}<span class="pill warn" role="status">{pairMessage}</span>{/if}
</footer>

{#if details}
  <Dialog title="Workspace status" onClose={() => (details = false)} testid="status-dialog">
    <div class="status-details">
      <h3>Saving</h3>
      <p>{saveWarning(s.saveFailing) ?? 'Changes are saved on this device.'}</p>
      {#if s.saveFailing}<button type="button" onclick={onExportRecovery}>Export recovery copy</button>{/if}
      <h3>Synchronization</h3>
      <p>{s.offline || s.paused ? 'Offline: edits are kept and sync when you reconnect' : syncLabel(status, Date.now(), s.saveFailing)}</p>
      <p>{peopleText}</p>
      <button type="button" onclick={() => { details = false; onSync?.(); }}>Open Sync panel</button>
      <h3>Build</h3>
      <p>{build}. Schedule: {schedule}.</p>
      {#if s.pdfEngine}<p>Displayed PDF: {s.pdfEngine} on this device.</p>{/if}
      {#if s.compileFailure}<p class="warn">{s.compileFailure.summary} {s.compileFailure.recovery}</p>{/if}
      <button type="button" onclick={() => { details = false; void s.compileLocal(); }}>Compile now</button>
  <span class="item" data-tip="Compiler available for the next local build">
    <Icon icon={Cpu} size={13} />
    {#if s.compilerPhase === 'setting-up'}
      <span data-testid="compile-location">Setting up the local compiler…</span>
    {:else if s.engine}
      <span data-testid="compile-location">Compiles on this device</span>
    {:else}
      <span data-testid="compile-location">Set up a local compiler</span>
    {/if}
  </span>
  {#if s.compileMigrationNotice}
    <span class="item" role="status" data-testid="compile-migration">Shared compilation was removed. Builds now run on this device.
      {#if !s.engine && s.compilerPhase !== 'setting-up'}<button type="button" class="linkish" onclick={() => go('/account')} data-testid="compile-migration-setup">Set up a local compiler</button>{/if}
      <button type="button" class="linkish" onclick={() => s.dismissCompileMigration()} data-testid="compile-migration-dismiss">Dismiss</button>
    </span>
  {/if}




  <span class="item compiler" data-testid="compile-mode">Build: this device</span>
  <span class="item" data-testid="compiler-state">
    {#if s.compilerPhase === 'setting-up'}Setting up the {s.compilerName}{s.compilerDetail ? ` (${s.compilerDetail})` : ''}…
    {:else if s.compilerPhase === 'packages'}{s.compilerName}: {s.compilerDetail}…
    {:else if s.compilerName}{s.compilerName}{s.localOnlyCompiler ? ' (builds stay on this device)' : ''}
    {:else}{s.engineKind === 'native' ? 'native TeX on this device' : s.engineKind === 'wasm' ? 'in-browser TeX' : 'no compiler here'}{/if}
  </span>
  {#if onUseDesktop}
    <button type="button" class="item linkish" disabled={pairing} onclick={onUseDesktop} data-testid="use-desktop" data-tip="Compile on this computer with the HiveTeX desktop app (TeX Live, MiKTeX or its own compiler) instead of in the browser">Compile with my desktop app</button>
  {/if}
  {#if pairMessage}<span class="pill warn" role="status" data-testid="pair-message">{pairMessage}</span>{/if}

    </div>
  </Dialog>
{/if}


<style>
  .statusbar {
    display: flex;
    align-items: center;
    gap: 2px 10px;
    min-height: var(--statusbar-h);
    padding: 0 10px calc(0px + env(safe-area-inset-bottom, 0px));
    background: var(--surface);
    border-top: 1px solid var(--line);
    font-size: var(--text-xs);
    color: var(--muted);
    white-space: nowrap;
    flex-wrap: wrap;
  }
  .statusbar { flex: none; }
  .sync, .people { min-width: 0; max-width: 210px; }
  .sync span, .people span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .build { flex-wrap: wrap; white-space: normal; }
  .critical { color: var(--bad); }
  .status-details { display: grid; gap: 10px; }
  .status-details h3, .status-details p { margin: 0; }
  .status-details .item { flex-wrap: wrap; }
  .item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .ok {
    color: var(--ok);
  }
  .warn {
    color: var(--warn);
  }
  .linkish {
    min-height: 22px;
    padding: 0 4px;
    border: 0;
    background: none;
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 400;
  }
  .linkish:hover {
    color: var(--ink);
  }
  .linkish.warn { color: var(--warn); }
  .linkish.ok { color: var(--ok); }
  .linkish.critical { color: var(--bad); }
  .sp {
    flex: 1;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .mono {
    font-family: var(--font-code);
  }
  .pill {
    font-size: 11px;
    padding: 2px 7px;
  }
</style>
