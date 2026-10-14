<script lang="ts">
  import { COMPILE_MODES, type CompileMode } from '../../lib/compile-mode.js';
  import type { ProjectSession } from '../../lib/session.svelte.js';
  import { saveWarning, syncLabel } from '../../lib/sync-view.js';
  import { Cpu, RefreshCw, Users, WifiOff } from '../../ui/icons.js';
  import Icon from '../../ui/Icon.svelte';

  /** One line of plain-language status: sync, people, who compiles, compile mode, cursor. */
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

  const others = $derived(s.peers.length);
  const connecting = $derived(s.connecting.length);
  const peopleText = $derived(
    others === 0 && connecting === 0
      ? 'No co-authors online'
      : `${others === 0 ? 'No co-authors connected' : `${others} co-author${others === 1 ? '' : 's'} online`}${connecting ? ` (${connecting} connecting)` : ''}`,
  );
  const status = $derived(s.syncStatus);
  const busy = $derived(status?.stage === 'receiving' || status?.stage === 'reconciling' || status?.stage === 'connecting');
</script>

<footer class="statusbar" data-testid="statusbar">
  {#if saveWarning(s.saveFailing)}
    <span class="pill bad" role="alert" data-testid="save-failed" data-tip="Your latest edits are held in memory only and keep being retried. Keep this tab open, and export a copy.">{saveWarning(s.saveFailing)}</span>
    <button type="button" class="item linkish" onclick={onExportRecovery} data-testid="export-recovery">Export recovery copy</button>
  {/if}
  {#if s.offline || s.paused}
    <span class="item warn" data-testid="offline-pill" data-tip="Your edits are kept on this device and merge automatically when you reconnect">
      <Icon icon={WifiOff} size={13} />Offline: edits are kept and sync when you reconnect
    </span>
  {:else}
    <button type="button" class="item linkish {status?.stage === 'synced' ? 'ok' : ''}" onclick={onSync} data-testid="sync-status" data-stage={status?.stage ?? 'alone'} data-tip="Show which files are synced, who is editing them, and sync now">
      <Icon icon={RefreshCw} size={13} /><span role="status">{syncLabel(status, Date.now(), s.saveFailing)}</span>
    </button>
    {#if busy && status?.stalled}<button type="button" class="item linkish" onclick={() => void s.syncNow()} disabled={s.syncingNow} data-testid="sync-now-inline">Sync now</button>{/if}
  {/if}
  {#if s.conflicts.length}
    <button type="button" class="pill bad" onclick={onConflicts} data-testid="conflicts-pill" data-tip="Your offline changes and co-authors' changes touch the same lines: decide what to keep">
      {s.conflicts.length} conflict{s.conflicts.length === 1 ? '' : 's'} to resolve
    </button>
  {:else if s.unsharedWork}
    <span class="item" data-testid="unshared-work" data-tip="Changes made while nobody else was connected: they are merged when a co-author connects">Unshared changes</span>
  {/if}
  <button type="button" class="item linkish" onclick={() => s.setPaused(!s.paused)} data-testid="pause-sync" data-tip={s.paused ? 'Reconnect to co-authors' : 'Disconnect and keep editing on this device'}>{s.paused ? 'Resume sync' : 'Work offline'}</button>

  <button type="button" class="item linkish" onclick={onPeople} data-tip={[...s.peers.map((p) => p.uname), ...s.connecting.map((c) => `${c.uname} (connecting)`)].join(', ') || 'Nobody else is here right now'}>
    <Icon icon={Users} size={13} /><span data-testid="peer-count">{peopleText}{others ? `: ${s.peers.map((p) => p.uname).join(', ')}` : ''}</span>
  </button>

  <span class="item" data-tip="The device that builds the PDF for everyone: the best one online, chosen automatically">
    <Icon icon={Cpu} size={13} />
    {#if s.effectiveCompileMode === 'local'}
      <span data-testid="leader">Compiles only on this device{s.compileMode !== 'local' && s.localOnlyCompiler ? ` (${s.compilerName || 'quick compiler'})` : ''}</span>
    {:else if s.leaderName}
      <span data-testid="leader">Compiles on {s.leaderName}{s.leaderName.includes('(this device)') ? '' : ' (best available)'}</span>
    {:else if s.compilerPhase === 'setting-up'}
      <span data-testid="leader">Setting up the compiler…</span>
    {:else}
      <span data-testid="leader">Compiler: none available</span>
    {/if}
  </span>
  {#if s.compileMode === 'peers' && !s.leaderName}
    <span class="pill warn" role="status" data-testid="no-peer-compiler" data-tip="Switch to This device (needs LaTeX or the in-browser compiler) or ask a co-author with the desktop app and LaTeX to open the project">No co-author can compile right now</span>
  {/if}
  {#if s.revoked}<span class="pill bad">you no longer have access</span>{/if}
  {#if s.mirrorNotice}<span class="pill warn" role="status">{s.mirrorNotice}</span>{/if}

  <span class="sp"></span>

  {#if keymapMode}<span class="item mono" data-testid="keymap-mode">{keymapMode}</span>{/if}
  {#if cursor}<span class="item num" data-testid="cursor-pos">Ln {cursor.line}, Col {cursor.col}</span>{/if}
  <label class="item compiler" data-tip={COMPILE_MODES.find((m) => m.id === s.compileMode)?.hint}>Compile:
    <select value={s.compileMode} onchange={(e) => void s.setCompileMode((e.currentTarget as HTMLSelectElement).value as CompileMode)} data-testid="compile-mode">
      {#each COMPILE_MODES as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
    </select>
  </label>
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
</footer>

<style>
  .statusbar {
    display: flex;
    align-items: center;
    gap: 2px 14px;
    min-height: var(--statusbar-h);
    padding: 0 10px calc(0px + env(safe-area-inset-bottom, 0px));
    background: var(--surface);
    border-top: 1px solid var(--line);
    font-size: var(--text-xs);
    color: var(--muted);
    white-space: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }
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
  .sp {
    flex: 1;
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .mono {
    font-family: var(--font-code);
  }
  .compiler select {
    min-height: 22px;
    width: auto;
    padding: 0 4px;
    font-size: var(--text-xs);
    border-color: transparent;
    background: transparent;
    color: var(--ink);
  }
  .compiler select:hover {
    border-color: var(--line-strong);
  }
  .pill {
    font-size: 11px;
    padding: 2px 7px;
  }
</style>
