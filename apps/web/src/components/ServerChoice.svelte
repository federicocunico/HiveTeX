<script lang="ts">
  import { apiBase, defaultServer, safeStorage, serverLabel, setServerUrl, useDefaultServer } from '../lib/api.js';
  import { Wifi } from '../ui/icons.js';
  import Icon from '../ui/Icon.svelte';

  /** Desktop only: which control plane this app talks to, changeable before signing in. */
  const current = apiBase();
  const custom = !!safeStorage('serverUrl');
  let editing = $state(false);
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

  function backToDefault() {
    useDefaultServer();
    location.reload();
  }
</script>

<div class="server" data-testid="server-choice">
  {#if editing}
    <form onsubmit={save} class="edit">
      <label class="lbl" for="server-url">Server <small>the address of your HiveTeX deployment</small></label>
      <div class="row">
        <input id="server-url" type="text" bind:value placeholder="https://latex.example.org" autocomplete="url" data-testid="server-url" required />
        <button type="submit" data-testid="server-save">Use</button>
        <button type="button" onclick={() => ((editing = false), (value = current), (error = ''))}>Cancel</button>
      </div>
    </form>
    {#if error}<div class="error" role="alert">{error}</div>{/if}
  {:else}
    <div class="chip">
      <Icon icon={Wifi} />
      <span>Server <strong data-testid="server-current">{serverLabel(current)}</strong></span>
      <span class="acts">
        <button class="link" type="button" onclick={() => (editing = true)} data-testid="server-change">Change</button>
        {#if custom}
          <button class="link" type="button" onclick={backToDefault} data-testid="server-default" data-tip={serverLabel(defaultServer())}>Use the default server</button>
        {/if}
      </span>
    </div>
  {/if}
</div>

<style>
  .chip {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    padding: 8px 12px;
    border: 1px dashed var(--line-strong);
    border-radius: var(--r-m);
    color: var(--muted);
    font-size: var(--text-sm);
  }
  .chip strong {
    color: var(--ink);
    font: 500 12.5px var(--font-code);
    word-break: break-all;
  }
  .acts {
    display: inline-flex;
    gap: 12px;
    margin-left: auto;
  }
  .link {
    min-height: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--honey-ink);
    font-weight: 500;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .link:hover {
    background: none;
  }
  .edit {
    display: grid;
    gap: 6px;
  }
  .lbl {
    font-weight: 500;
    font-size: var(--text-sm);
  }
  .lbl small {
    font-weight: 400;
    color: var(--muted);
  }
  .row {
    display: flex;
    gap: 6px;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
  .error {
    margin-top: 8px;
    padding: 8px 10px;
  }
</style>
