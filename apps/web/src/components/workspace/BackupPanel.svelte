<script lang="ts">
  import type { ProjectSession } from '../../lib/session.svelte.js';
  import GithubPanel from '../GithubPanel.svelte';
  import PanelHead from './PanelHead.svelte';

  /** GitHub backup: connect, link a repository, back up now, and see when the last backup happened. */
  let { session }: { session: ProjectSession } = $props();
</script>

<section class="panel" aria-labelledby="backup-title" data-testid="backup-panel">
  <PanelHead title="GitHub backup" id="backup-title" />
  <div class="body"><GithubPanel {session} /></div>
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
  }
  .body {
    padding: 0 14px 14px;
    font-size: var(--text-sm);
  }
</style>
