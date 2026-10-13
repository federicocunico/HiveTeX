<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { api, isDesktop } from '../lib/api.js';
  import { copyText } from '../lib/clipboard.js';
  import { type CheckResult, type NetEnv, type PeerRow, type PeerVerdict, browserGather, buildReport, peerRows, peerVerdict, runChecks, CHECKS } from '../lib/netdiag.js';
  import type { ProjectSession } from '../lib/session.svelte.js';
  import type { MappingState } from '../lib/sync-view.js';
  import { toast } from '../ui/toast.svelte.js';

  /**
   * Whether this device can reach the signaling service, STUN and the relay, whether ports work, and whether it can
   * connect to each co-author. `session` is the open project (for live connection details); without it only the
   * network checks run. Results never include credentials.
   */
  let { session = null, projectId }: { session?: ProjectSession | null; projectId: string | null } = $props();

  const PEER_TEST_MS = 25_000;
  let results = $state<CheckResult[]>(CHECKS.map((c) => ({ ...c, status: 'idle', detail: '' })));
  let running = $state(false);
  let rows = $state<PeerRow[]>([]);
  let ice = $state<ReturnType<typeof readDiagnostics>['ice']>(null);
  let tests = $state<Record<string, { running: boolean; verdict: PeerVerdict | null }>>({});
  let timer: ReturnType<typeof setInterval> | null = null;

  function readDiagnostics() {
    try {
      const d = session?.syncDiagnostics();
      if (d) return { trace: d.trace ?? [], candidates: d.candidates, routes: d.routes ?? {}, ice: d.ice ?? null, socketOpen: d.socketOpen, doorbellMode: d.doorbellMode, peers: session?.peers ?? [] };
    } catch {
      /* no runtime yet */
    }
    return { trace: [], candidates: [], routes: {}, ice: null, socketOpen: false, doorbellMode: false, peers: [] as NonNullable<typeof session>['peers'], none: true };
  }

  function refresh() {
    const d = readDiagnostics();
    rows = peerRows(d.peers, d.candidates, d.routes);
    ice = d.ice;
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

  /** Retries now and watches the co-author until connected or the attempt timeout passes; reports the stage reached. */
  async function peerTest(dev: string) {
    if (!session || tests[dev]?.running) return;
    tests[dev] = { running: true, verdict: null };
    const started = Date.now();
    void session.syncNow();
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      const d = readDiagnostics();
      const v = peerVerdict(dev, d.peers, d.candidates, d.routes, Date.now() - started, PEER_TEST_MS);
      refresh();
      if (v) {
        tests[dev] = { running: false, verdict: v };
        return;
      }
    }
  }

  async function copyReport() {
    const text = buildReport({ results, ice, rows, app: isDesktop ? 'desktop' : 'web', when: new Date(), trace: readDiagnostics().trace });
    try {
      await copyText(text);
      toast('Network report copied. It contains no passwords or keys.');
    } catch {
      toast('Could not copy the report.', 'info');
    }
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
  <div class="actions">
    <button type="button" class="primary" onclick={() => void run()} disabled={running} data-testid="net-run">{running ? 'Checking…' : 'Run checks again'}</button>
    <button type="button" onclick={() => void copyReport()} data-testid="net-copy">Copy report</button>
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
            <span class="state">{p.state === 'connected' ? `connected ${p.route}` : `not connected · attempt ${(p.attempts ?? 0) + 1}`}</span>
            <button type="button" class="small" onclick={() => void peerTest(p.dev)} disabled={t?.running} data-testid="net-test-{p.name}">{t?.running ? 'Testing…' : 'Test connection'}</button>
          </div>
          {#if p.state === 'connected'}
            {#if p.pair}<p class="detail">Selected network path: {p.pair}</p>{/if}
          {:else}
            <p class="detail">{p.explanation}</p>
            <p class="detail">Stage: {p.linkState ?? 'n/a'} · candidates here: {p.local ?? 'n/a'} · from them: {p.remote ?? 'n/a'}</p>
          {/if}
          {#if t?.verdict}
            <p class="verdict" class:bad={!t.verdict.ok} role="status" data-testid="net-verdict-{p.name}">
              {t.verdict.ok ? `Connected ${t.verdict.route}${t.verdict.pair ? ` (${t.verdict.pair})` : ''}.` : t.verdict.detail}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .net { display: grid; gap: 0.75rem; }
  .lead, .meta { margin: 0; color: var(--muted, #667); }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  .checks li { display: flex; gap: 0.6rem; align-items: flex-start; }
  .mark { flex: none; width: 0.7rem; height: 0.7rem; margin-top: 0.35rem; border-radius: 50%; background: var(--muted, #99a); }
  [data-status='pass'] .mark { background: var(--ok, #1a7f37); }
  [data-status='warn'] .mark { background: var(--warn, #b26a00); }
  [data-status='fail'] .mark { background: var(--bad, #c62828); }
  .body { display: grid; gap: 0.1rem; min-width: 0; }
  .state { color: var(--muted, #667); font-size: 0.85em; margin-left: 0.5rem; }
  .detail { display: block; margin: 0; font-size: 0.9em; overflow-wrap: anywhere; }
  h3 { margin: 0.5rem 0 0; font-size: 1rem; }
  .peers li { border: 1px solid var(--border, #ccd); border-radius: 6px; padding: 0.5rem 0.7rem; display: grid; gap: 0.25rem; }
  .head { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .head .small { margin-left: auto; }
  .verdict { margin: 0; font-weight: 600; }
  .verdict.bad { color: var(--bad, #c62828); }
</style>
