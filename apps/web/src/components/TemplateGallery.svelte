<script lang="ts">
  import { TEMPLATES, type TemplateLayout } from '../lib/templates.js';

  /** Pick a template for a new project. Native radio buttons, so arrow keys and screen readers work as usual. */
  let { value = $bindable('blank') }: { value?: string } = $props();

  // Schematic first pages: [kind, width%] lines. Paper colors in both themes, like the PDF.
  const LINES: Record<TemplateLayout, Array<[string, number]>> = {
    blank: [],
    article: [['t', 62], ['s', 40], ['p', 100], ['p', 100], ['h', 38], ['p', 100], ['p', 92], ['p', 100], ['p', 70]],
    report: [['t', 70], ['s', 44], ['g', 0], ['h', 46], ['p', 100], ['p', 100], ['h', 40], ['p', 96]],
    slides: [['t', 54], ['p', 72], ['p', 64], ['p', 70]],
    letter: [['p', 34], ['p', 30], ['g', 0], ['p', 40], ['p', 100], ['p', 100], ['p', 86], ['g', 0], ['p', 30]],
    cv: [['t', 46], ['s', 64], ['h', 34], ['p', 100], ['p', 84], ['h', 36], ['p', 100], ['p', 90]],
  };
</script>

<fieldset class="gallery">
  <legend>Start from</legend>
  <div class="grid">
    {#each TEMPLATES as t (t.id)}
      <label class="tpl" class:sel={value === t.id} data-testid="template-{t.id}">
        <input type="radio" name="template" value={t.id} bind:group={value} />
        <span class="pg" aria-hidden="true">
          <span class="paper" class:wide={t.layout === 'slides'}>
            {#each LINES[t.layout] as [kind, w], i (i)}<i class={kind} style:width="{w}%"></i>{/each}
          </span>
        </span>
        <span class="name">{t.name}</span>
        <span class="desc">{t.description}</span>
      </label>
    {/each}
  </div>
</fieldset>

<style>
  .gallery {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 8px;
    font-weight: 500;
    font-size: var(--text-sm);
  }
  .grid {
    display: grid;
    /* six templates: two full rows of three (or three rows of two on phones) */
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }
  @media (max-width: 560px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .tpl {
    position: relative;
    display: grid;
    gap: 4px;
    align-content: start;
    padding: 8px 8px 10px;
    border: 1px solid var(--line);
    border-radius: var(--r-l);
    background: var(--surface);
    cursor: pointer;
  }
  .tpl:hover {
    border-color: var(--line-strong);
  }
  .tpl.sel {
    border-color: var(--honey-ink);
    box-shadow: 0 0 0 3px var(--honey-soft);
  }
  .tpl:focus-within {
    outline: 2px solid var(--honey-ink);
    outline-offset: 2px;
  }
  .tpl input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .pg {
    display: grid;
    place-items: center;
    height: 104px;
    border-radius: var(--r-m);
    background: var(--pdf-desk);
    margin-bottom: 4px;
  }
  .paper {
    width: 64px;
    height: 84px;
    padding: 8px 7px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    background: var(--pdf-paper);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
  }
  .paper.wide {
    width: 96px;
    height: 60px;
  }
  .paper i {
    display: block;
    height: 2px;
    background: #cdd0d7;
  }
  .paper i.t {
    height: 4px;
    background: #4b505c;
    align-self: center;
    margin-bottom: 2px;
  }
  .paper i.s {
    height: 2px;
    background: #8a8f9b;
    align-self: center;
    margin-bottom: 3px;
  }
  .paper i.h {
    height: 3px;
    background: #6b7080;
    margin-top: 3px;
  }
  .paper i.g {
    height: 6px;
    background: none;
  }
  .name {
    font-weight: 600;
    font-size: var(--text-md);
  }
  .desc {
    color: var(--muted);
    font-size: var(--text-xs);
    line-height: 1.35;
  }
</style>
