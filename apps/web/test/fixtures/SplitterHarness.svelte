<script lang="ts">
  import Splitter from '../../src/ui/Splitter.svelte';

  let width = $state(300);
  const clamp = (v: number) => Math.max(200, Math.min(600, v));
</script>

<Splitter label="Resize editor and PDF" value={width} min={200} max={600} step={24} onresize={(d) => (width = clamp(width + d))} />
<output>{width}</output>
