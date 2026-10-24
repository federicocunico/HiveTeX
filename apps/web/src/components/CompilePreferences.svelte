<script lang="ts">
  import { prefs, setPref, validCompileInterval, type CompileSchedule } from '../lib/preferences.svelte.js';
  let interval = $state(String(prefs.compileIntervalSeconds));
  let error = $state('');
  $effect(() => { interval = String(prefs.compileIntervalSeconds); error = ''; });
  function saveInterval() {
    const value = Number(interval);
    if (!validCompileInterval(value)) { error = 'Enter a whole number from 5 to 300 seconds.'; return; }
    error = '';
    setPref('compileIntervalSeconds', value);
  }
</script>

<div class="compile-preferences">
  <label class="field">Compilation schedule
    <select aria-label="Compilation schedule" value={prefs.compileSchedule} onchange={(e) => setPref('compileSchedule', e.currentTarget.value as CompileSchedule)}>
      <option value="after-changes">After changes</option>
      <option value="periodic">Periodic</option>
      <option value="manual">Manual</option>
    </select>
  </label>
  {#if prefs.compileSchedule === 'periodic'}
    <label class="field">Compile interval (seconds)
      <input type="number" min="5" max="300" step="1" value={interval} oninput={(e) => { interval = e.currentTarget.value; }} onchange={saveInterval} aria-invalid={!!error} />
    </label>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {/if}
  <p class="muted">For this device only. After changes waits 1.5 seconds (at most 5 seconds while typing). Periodic checks changed inputs every {prefs.compileIntervalSeconds} seconds. Manual waits for Compile now. Unchanged failed builds wait for a change or an explicit retry.</p>
</div>
