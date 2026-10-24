<script lang="ts">
  import { type PdfPosition, type SyncIndex, reverseSearch } from '@hivetex/compile';
  import { onDestroy, untrack } from 'svelte';
  import { PdfRenderer } from '../lib/pdf-renderer.js';
  import { ChevronDown, ChevronUp, PanelRight, ZoomIn, ZoomOut } from '../ui/icons.js';
  import IconButton from '../ui/IconButton.svelte';

  let {
    pdf,
    rev,
    stale,
    compiledBy,
    syncIndex,
    highlight = null,
    onReverse,
    zoom = $bindable(1.2),
    editsSincePdf = 0,
    onHide,
  }: {
    pdf: Uint8Array | null;
    rev: number;
    stale: boolean;
    compiledBy: string | null;
    syncIndex: SyncIndex | null;
    highlight?: PdfPosition | null;
    onReverse?: (file: string, line: number) => void;
    zoom?: number;
    editsSincePdf?: number;
    onHide?: (() => void) | undefined;
  } = $props();

  let scroller: HTMLDivElement;
  let pageCount = $state(0);
  let current = $state(1);
  let error = $state('');
  let rendering = $state(false);
  let pages: HTMLDivElement;
  let renderer: PdfRenderer | null = null;
  let jumpToHighlight = false;
  let highlightRevision = -1;

  function render() {
    if (!scroller || !pages) return;
    renderer ??= new PdfRenderer(scroller, async (data) => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      return pdfjs.getDocument({ data, useSystemFonts: false });
    }, (state) => {
      pageCount = state.pages; current = state.current; rendering = state.loading; error = state.error;
    }, () => drawHighlight(jumpToHighlight), pages);
    void renderer.show(pdf, zoom);
  }

  function drawHighlight(scroll = true) {
    scroller?.querySelectorAll('.hl').forEach((el) => el.remove());
    if (!highlight || !syncIndex || highlightRevision !== rev || !scroller || !renderer?.ready) return;
    const wrap = scroller.querySelector<HTMLElement>(`.page-wrap[data-page="${highlight.page}"]`);
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'hl';
    el.style.left = `${highlight.x * zoom - 2}px`;
    el.style.top = `${highlight.y * zoom - 2}px`;
    el.style.width = `${Math.max(highlight.w * zoom, 30) + 4}px`;
    el.style.height = `${Math.max(highlight.h * zoom, 10) + 4}px`;
    wrap.append(el);
    if (scroll) {
      jumpToHighlight = false;
      renderer.goto(highlight.page);
      // Scroll only the preview; source focus and outer workspace position stay put.
      scroller.scrollTop = wrap.offsetTop + highlight.y * zoom - scroller.clientHeight / 2;
      scroller.scrollLeft = Math.max(0, wrap.offsetLeft + highlight.x * zoom - scroller.clientWidth / 2);
      renderer.update();
    }
  }

  function onDblClick(ev: MouseEvent) {
    const wrap = (ev.target as HTMLElement).closest<HTMLElement>('.page-wrap');
    if (!wrap || !syncIndex || !renderer?.ready) return;
    const rect = wrap.getBoundingClientRect();
    const r = reverseSearch(syncIndex, Number(wrap.dataset.page), (ev.clientX - rect.left) / zoom, (ev.clientY - rect.top) / zoom);
    if (r) onReverse?.(r.file, r.line);
  }

  function onScroll() { renderer?.update(); }
  function goto(n: number) { renderer?.goto(n); }

  $effect(() => {
    void rev;
    void zoom;
    untrack(() => void render());
  });

  $effect(() => {
    void highlight;
    untrack(() => { highlightRevision = rev; jumpToHighlight = !!highlight; drawHighlight(); });
  });

  $effect(() => { void syncIndex; untrack(() => drawHighlight(false)); });

  const staleText = $derived(
    editsSincePdf > 0 ? `Outdated: ${editsSincePdf} edit${editsSincePdf === 1 ? '' : 's'} since the last compile` : 'Outdated',
  );

  onDestroy(() => renderer?.close());
</script>


<div class="pdf-pane" data-testid="pdf-pane">
  <div class="pdf-bar">
    {#if stale && pdf}
      <span class="pill warn" data-testid="stale-badge" data-tip="Recompile to see the latest edits">
        <span class="dot" aria-hidden="true"></span>{staleText}
      </span>
    {:else if pdf}
      <span class="pill ok"><span class="dot" aria-hidden="true"></span>Up to date</span>
    {/if}
    {#if compiledBy}<span class="by" data-testid="compiled-by">compiled by {compiledBy}</span>{/if}
    <span class="sp"></span>
    <IconButton icon={ZoomOut} size={28} label="Zoom out" onclick={() => (zoom = Math.max(0.5, +(zoom - 0.1).toFixed(2)))} />
    <span class="num" aria-live="polite">{Math.round(zoom * 100)}%</span>
    <IconButton icon={ZoomIn} size={28} label="Zoom in" onclick={() => (zoom = Math.min(3, +(zoom + 0.1).toFixed(2)))} />
    {#if pageCount}
      <span class="sep" aria-hidden="true"></span>
      <IconButton icon={ChevronUp} size={28} label="Previous page" onclick={() => goto(Math.max(1, current - 1))} />
      <span class="num">Page {current} of {pageCount}</span>
      <IconButton icon={ChevronDown} size={28} label="Next page" onclick={() => goto(Math.min(pageCount, current + 1))} />
    {/if}
    {#if onHide}<IconButton icon={PanelRight} size={28} label="Hide PDF" tip="Hide the PDF (Ctrl+Alt+P)" onclick={onHide} />{/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable regions must be keyboard-focusable, WCAG 2.1.1) -->
  <div class="pdf-scroll" bind:this={scroller} onscroll={onScroll} ondblclick={onDblClick} role="document" aria-label="PDF preview" tabindex="0" data-testid="pdf-scroll">
    <div class="pages" bind:this={pages}></div>
    {#if !pdf}
      <div class="nopdf">
        <p><strong>No PDF yet.</strong></p>
        <p>Press Recompile to build the PDF on this device.</p>
      </div>
    {/if}
  </div>
  {#if error}<div class="error pdf-msg" role="alert">{error}</div>{:else if rendering}<div class="pdf-msg">Rendering…</div>{/if}
</div>

<style>
  .pdf-pane {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--pdf-desk);
    container-type: inline-size;
  }
  .pdf-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: var(--pane-header-h);
    padding: 0 6px 0 10px;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
    font-size: var(--text-sm);
    color: var(--muted);
    overflow: hidden;
  }
  .pdf-bar :global(.pill) {
    flex: none;
    white-space: nowrap;
    padding: 0;
    border: 0;
    background: transparent;
  }
  .by {
    margin-left: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-xs);
  }
  /* In a narrow pane, who compiled the PDF moves to its own line instead of being squeezed to nothing. */
  @container (max-width: 560px) {
    .pdf-bar {
      flex-wrap: wrap;
      row-gap: 0;
    }
    .by {
      order: 1;
      flex-basis: 100%;
      margin: 0 0 6px;
    }
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }
  .sp {
    flex: 1;
  }
  .num {
    min-width: 3.2em;
    text-align: center;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    font-size: var(--text-xs);
  }
  .sep {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--line);
  }
  .pdf-scroll {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px;
    background: var(--pdf-desk);
  }
  .pdf-scroll :global(canvas) {
    display: block;
    margin: 0 auto 16px;
    background: var(--pdf-paper);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.2), 0 6px 20px rgb(0 0 0 / 0.08);
    max-width: none;
  }
  .pdf-scroll :global(.page-wrap) {
    position: relative;
    width: max-content;
    background: var(--pdf-paper);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
    margin: 0 auto 16px;
  }
  .pdf-scroll :global(.page-wrap canvas) {
    margin: 0;
  }
  .pdf-scroll :global(.hl) {
    position: absolute;
    background: rgb(242 181 60 / 0.35);
    border: 1px solid rgb(200 140 0 / 0.8);
    border-radius: 2px;
    pointer-events: none;
  }
  .nopdf {
    max-width: 34ch;
    margin: 48px auto;
    text-align: center;
    color: var(--muted);
  }
  .nopdf p {
    margin: 0 0 6px;
  }
  .pdf-msg {
    flex: none;
    padding: 4px 10px;
    font-size: var(--text-xs);
    color: var(--muted);
    background: var(--surface);
    border-top: 1px solid var(--line);
  }
</style>
