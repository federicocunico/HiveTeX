<script lang="ts">
  import type { PeerProbeResult } from '@hivetex/sync';
  import { onDestroy, onMount } from 'svelte';
  import { api, isDesktop } from '../lib/api.js';
  import { copyText } from '../lib/clipboard.js';
  import { type CheckResult, type NetEnv, type PeerRow, browserGather, buildReport, formatProbe, peerRows, platformOf, runChecks, traceLine, CHECKS } from '../lib/netdiag.js';
  import type { ProjectSession } from '../lib/session.svelte.js';
  import type { MappingState } from '../lib/sync-view.js';
  import { toast } from '../ui/toast.svelte.js';

  /**
   * Whether this device can reach the signaling service, STUN and the relay, whether ports work, and whether it can
   * connect to each co-author. `session` is the open project (for live connection details); without it only the
   * network checks run. Results never include credentials.
   */
  let { session = null, projectId }: { session?: ProjectSession | null; projectId: string | null } = $props();

  const environment = {
    app: isDesktop ? 'desktop' : 'web',
    version: import.meta.env.VITE_APP_VERSION ?? 'dev',
    platform: typeof navigator === 'undefined' ? 'unknown' : platformOf(navigator.userAgent),
  };
  let results = $state<CheckResult[]>(CHECKS.map((c) => ({ ...c, status: 'idle', detail: '' })));
  let running = $state(false);
  let rows = $state<PeerRow[]>([]);
  let ice = $state<ReturnType<typeof readDiagnostics>['ice']>(null);
  let traceText = $state('');
  let showTrace = $state(false);
  let tests = $state<Record<string, { running: boolean; name: string; result: PeerProbeResult | null; error: string }>>({});
  let timer: ReturnType<typeof setInterval> | null = null;

  function readDiagnostics() {
    try {
      const d = session?.syncDiagnostics();
      if (d) return { trace: d.trace ?? [], self: d.self ?? null, candidates: d.candidates, routes: d.routes ?? {}, ice: d.ice ?? null, socketOpen: d.socketOpen, doorbellMode: d.doorbellMode, peers: session?.peers ?? [] };
    } catch {
      /* no runtime yet */
    }
    return { trace: [], self: null, candidates: [], routes: {}, ice: null, socketOpen: false, doorbellMode: false, peers: [] as NonNullable<typeof session>['peers'], none: true };
  }

  function refresh() {
    const d = readDiagnostics();
    rows = peerRows(d.peers, d.candidates, d.routes);
    ice = d.ice;
    if (showTrace) {
      const last = d.trace.slice(-200);
      const start = last[0]?.t ?? 0;
      traceText = last.map((e) => traceLine(e, start)).join('\n');
    }
  }

  const env: NetEnv = {
    fetchIce: async () => {
      if (!projectId) throw new Error('no project');
      return api('POST', '/turn', { projectId });
    },
    gather: browserGather(),
    signalingOpen: () => {
      if (!session) return null;
      const d = readDiagnostics();
      return d.socketOpen ? true : d.doorbellMode ? 'idle' : false;
    },
    mapping: async () => {
      if (!isDesktop) return null;
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<MappingState>('upnp_status');
    },
  };

  async function run() {
    if (running) return;
    running = true;
    try {
      results = await runChecks(env, (r) => (results = r));
    } finally {
      running = false;
      refresh();
    }
  }

  /**
   * Connection test: a signaling round trip (the other device answers with its own state and retries at once), then a
   * fresh connection attempt watched step by step. Takes up to about half a minute.
   */
  async function peerTest(dev: string, name: string, relayOnly = false) {
    if (!session || tests[dev]?.running) return;
    tests[dev] = { running: true, name, result: tests[dev]?.result ?? null, error: '' };
    try {
      // Relay only: the attempt uses relay (TURN) candidates only, to check that path on its own.
      const result = await session.probePeer(dev, { relayOnly });
      tests[dev] = { running: false, name, result, error: result ? '' : 'Networking is paused or off for this project.' };
    } catch (e) {
      tests[dev] = { running: false, name, result: null, error: e instanceof Error ? e.message : String(e) };
    } finally {
      refresh();
    }
  }

  function report() {
    const d = readDiagnostics();
    const probes = Object.values(tests).flatMap((t) => (t.result ? [{ name: t.name, result: t.result }] : []));
    return buildReport({ results, ice, rows, app: environment.app, when: new Date(), environment, self: d.self, probes, trace: d.trace });
  }

  async function copy(text: string, what: string) {
    try {
      await copyText(text);
      toast(`${what} copied. It contains no passwords, keys or addresses.`);
    } catch {
      toast(`Could not copy the ${what.toLowerCase()}.`, 'info');
    }
  }

  function toggleTrace() {
    showTrace = !showTrace;
    refresh();
  }

  onMount(() => {
    refresh();
    timer = setInterval(refresh, 1000);
    void run();
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

<div class="net" data-testid="network-diagnostics">
  <p class="lead">Checks whether this device can reach the signaling service, the connection servers and your co-authors, and whether ports work.</p>
  <p class="meta">App {environment.app} {environment.version} · {environment.platform}</p>
  <div class="actions">
    <button type="button" class="primary" onclick={() => void run()} disabled={running} data-testid="net-run">{running ? 'Checking…' : 'Run checks again'}</button>
    <button type="button" onclick={() => void copy(report(), 'Network report')} data-testid="net-copy">Copy report</button>
    {#if session}<button type="button" onclick={toggleTrace} data-testid="net-trace-toggle">{showTrace ? 'Hide connection trace' : 'Show connection trace'}</button>{/if}
  </div>

  <ul class="checks" data-testid="net-checks">
    {#each results as r (r.id)}
      <li data-testid="net-check-{r.id}" data-status={r.status}>
        <span class="mark" aria-hidden="true"></span>
        <span class="body"><strong>{r.label}</strong>
          <span class="state">{r.status === 'idle' ? 'waiting' : r.status === 'na' ? 'not applicable' : r.status}{r.ms !== undefined ? ` · ${r.ms} ms` : ''}</span>
          {#if r.detail}<span class="detail">{r.detail}</span>{/if}
        </span>
      </li>
    {/each}
  </ul>

  <h3>Co-authors</h3>
  {#if !session}
    <p class="meta">Open a project to see how this device connects to its co-authors.</p>
  {:else if rows.length === 0}
    <p class="meta" data-testid="net-no-peers">No co-author is online right now, so there is nobody to test against.</p>
  {:else}
    <ul class="peers" data-testid="net-peers">
      {#each rows as p (p.dev)}
        {@const t = tests[p.dev]}
        <li data-testid="net-peer-{p.name}" data-state={p.state}>
          <div class="head">
            <strong>{p.name}</strong>
            <span class="state">{p.state === 'connected' ? `connected ${p.route}` : `not connected · attempt ${(p.attempts ?? 0) + 1}${p.onServer ? '' : ' · not seen on the service'}`}</span>
            <button type="button" class="small" onclick={() => void peerTest(p.dev, p.name)} disabled={t?.running} data-testid="net-test-{p.name}">{t?.running ? 'Testing… (up to 45 s)' : 'Test connection'}</button>
            <button type="button" class="small" onclick={() => void peerTest(p.dev, p.name, true)} disabled={t?.running} data-testid="net-test-relay-{p.name}" title="Restricts the test's connection attempt to relay (TURN) candidates">Test relay only</button>
          </div>
          {#if p.state === 'connected'}
            {#if p.pair}<p class="detail">Selected network path: {p.pair}</p>{/if}
          {:else}
            <p class="detail">{p.explanation}</p>
            <p class="detail">Stage: {p.linkState ?? 'n/a'} · candidates here: {p.local ?? 'n/a'} · from them: {p.remote ?? 'n/a'}{p.lastError ? ` · last error: ${p.lastError}` : ''}</p>
          {/if}
          {#if t?.error}<p class="verdict bad" role="status">{t.error}</p>{/if}
          {#if t?.result}
            {@const res = t.result}
            <div class="probe" data-testid="net-probe-{p.name}" data-outcome={res.attempt.outcome}>
              <p class="verdict" class:bad={res.attempt.outcome !== 'connected'} role="status" data-testid="net-verdict-{p.name}">{res.verdict}</p>
              <ol class="steps">
                {#each res.steps as st, i (i)}
                  <li data-ok={st.ok === null ? 'info' : st.ok ? 'ok' : 'fail'}>
                    <span class="mark" aria-hidden="true"></span>
                    <span class="body"><strong>{st.label}</strong> <span class="state">+{st.at} ms</span><span class="detail">{st.detail}</span></span>
                  </li>
                {/each}
              </ol>
              <details>
                <summary>Test details ({res.trace.length} steps)</summary>
                <pre class="trace">{formatProbe(p.name, res).join('\n')}</pre>
              </details>
              <button type="button" class="small" onclick={() => void copy(formatProbe(p.name, res).join('\n'), 'Connection test')} data-testid="net-copy-test-{p.name}">Copy this test</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if showTrace}
    <h3>Connection trace (latest steps)</h3>
    <pre class="trace" data-testid="net-trace">{traceText || 'No steps recorded yet.'}</pre>
  {/if}
</div>

<style>
  .net { display: grid; gap: 0.75rem; }
  .lead, .meta { margin: 0; color: var(--muted, #667); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  ul, ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  .checks li, .steps li { display: flex; gap: 0.6rem; align-items: flex-start; }
  .mark { flex: none; width: 0.7rem; height: 0.7rem; margin-top: 0.35rem; border-radius: 50%; background: var(--muted, #99a); }
  [data-status='pass'] .mark, [data-ok='ok'] .mark { background: var(--ok, #1a7f37); }
  [data-status='warn'] .mark { background: var(--warn, #b26a00); }
  [data-status='fail'] .mark, [data-ok='fail'] .mark { background: var(--bad, #c62828); }
  .body { display: grid; gap: 0.1rem; min-width: 0; }
  .state { color: var(--muted, #667); font-size: 0.85em; margin-left: 0.5rem; }
  .detail { display: block; margin: 0; font-size: 0.9em; overflow-wrap: anywhere; }
  h3 { margin: 0.5rem 0 0; font-size: 1rem; }
  .peers li { border: 1px solid var(--border, #ccd); border-radius: 6px; padding: 0.5rem 0.7rem; display: grid; gap: 0.25rem; }
  .peers .steps li { border: none; padding: 0; display: flex; }
  .head { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .head .small { margin-left: auto; }
  .probe { display: grid; gap: 0.4rem; margin-top: 0.3rem; }
  .verdict { margin: 0; font-weight: 600; }
  .verdict.bad { color: var(--bad, #c62828); }
  .trace { margin: 0; max-height: 22rem; overflow: auto; font-size: 0.78em; line-height: 1.35; white-space: pre; background: var(--surface-2, #f4f4f7); padding: 0.5rem; border-radius: 4px; }
</style>
