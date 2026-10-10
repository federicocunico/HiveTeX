<script lang="ts">
  import { apiBase, setServerUrl } from '../lib/api.js';

  /** Desktop only: which control plane this app talks to, changeable before signing in. */
  const current = apiBase();
  let editing = $state(!current);
  let value = $state(current);
  let error = $state('');

  function save(e: Event) {
    e.preventDefault();
    error = '';
    try {
      if (setServerUrl(value) !== current) location.reload(); // every module reads the server on load
      else editing = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div class="server" data-testid="server-choice">
  {#if editing}
    <form onsubmit={save} class="row" style="gap: 6px; align-items: flex-end">
      <label class="field" style="flex: 1; margin: 0">Server <small>the address of your HiveTeX deployment</small>
        <input type="text" bind:value placeholder="https://your-app.vercel.app" autocomplete="url" data-testid="server-url" required />
      </label>
      <button class="small" type="submit" data-testid="server-save">Use</button>
      {#if current}<button class="small" type="button" onclick={() => ((editing = false), (value = current), (error = ''))}>Cancel</button>{/if}
    </form>
    {#if error}<div class="error" role="alert">{error}</div>{/if}
  {:else}
    <small class="muted">Server: <strong data-testid="server-current">{current}</strong> · <button class="link" type="button" onclick={() => (editing = true)}>Change</button></small>
  {/if}
</div>

<style>
  .server {
    margin-bottom: 12px;
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }
</style>
