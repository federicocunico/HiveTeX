<script lang="ts">
  import { onMount } from 'svelte';
  import NetworkDiagnostics from '../components/NetworkDiagnostics.svelte';
  import { api } from '../lib/api.js';
  import { go, route } from '../lib/router.svelte.js';
  import type { ProjectInfo } from '../lib/session.svelte.js';

  /**
   * Network diagnostics outside a project (from the account area): the checks need a project only to ask the service for
   * connection servers, so the project given as ?p= (or the first one of the account) is used. Co-author details live
   * in the project's own Network diagnostics.
   */
  let projectId = $state<string | null>(null);
  let loaded = $state(false);

  onMount(async () => {
    const wanted = route.query.get('p');
    try {
      const r = await api<{ projects: ProjectInfo[] }>('GET', '/projects');
      projectId = (wanted && r.projects.find((p) => p.id === wanted)?.id) || r.projects[0]?.id || null;
    } catch {
      projectId = null;
    }
    loaded = true;
  });
</script>

<main class="page" data-testid="network-page">
  <h1>Network diagnostics</h1>
  <p><button type="button" class="linkish" onclick={() => go('/account')}>Back to account</button></p>
  {#if loaded}
    {#key projectId}<NetworkDiagnostics session={null} {projectId} />{/key}
  {/if}
</main>

<style>
  .page { max-width: 46rem; margin: 0 auto; padding: 1.5rem 1rem; }
  h1 { margin-top: 0; }
</style>
