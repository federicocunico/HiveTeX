<script lang="ts">
  import { type PdfPosition, type SyncIndex, reverseSearch } from '@hivetex/compile';
  import { onDestroy, untrack } from 'svelte';

  let {
    pdf,
    rev,
    stale,
    compiledBy,
    syncIndex,
    highlight = null,
    onReverse,
  }: {
    pdf: Uint8Array | null;
    rev: number;
    stale: boolean;
    compiledBy: string | null;
    syncIndex: SyncIndex | null;
    highlight?: PdfPosition | null;
    onReverse?: (file: string, line: number) => void;
  } = $props();

  let scroller: HTMLDivElement;
  let zoom = $state(1.2);
  let pageCount = $state(0);
  let current = $state(1);
  let error = $state('');
  let rendering = $state(false);
  // biome-ignore lint/suspicious/noExplicitAny: pdf.js document type is loaded lazily
  let doc: any = null;
  let token = 0;

  async function render() {
    if (!pdf) return;
    const my = ++token;
    rendering = true;
    error = '';
    try {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      doc?.destroy();
      doc = await pdfjs.getDocument({ data: pdf.slice(), useSystemFonts: false }).promise;
      if (my !== token) return;
      pageCount = doc.numPages;
      const top = scroller?.scrollTop ?? 0;
      const frag = document.createDocumentFragment();
      const dpr = window.devicePixelRatio || 1;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (my !== token) return;
        const vp = page.getViewport({ scale: zoom });
        const wrap = document.createElement('div');
        wrap.className = 'page-wrap';
        wrap.dataset.page = String(n);
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${Math.floor(vp.width)}px`;
        canvas.style.height = `${Math.floor(vp.height)}px`;
        wrap.append(canvas);
        frag.append(wrap);
        const ctx = canvas.getContext('2d');
        if (ctx) await page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      }
      if (my !== token) return;
      scroller.replaceChildren(frag);
      scroller.scrollTop = top;
      drawHighlight();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not render the PDF';
    } finally {
      if (my === token) rendering = false;
    }
  }

  function drawHighlight() {
    scroller?.querySelectorAll('.hl').forEach((el) => el.remove());
    if (!highlight || !scroller) return;
    const wrap = scroller.querySelector<HTMLElement>(`.page-wrap[data-page="${highlight.page}"]`);
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'hl';
    el.style.left = `${highlight.x * zoom - 2}px`;
    el.style.top = `${highlight.y * zoom - 2}px`;
    el.style.width = `${Math.max(highlight.w * zoom, 30) + 4}px`;
    el.style.height = `${Math.max(highlight.h * zoom, 10) + 4}px`;
    wrap.append(el);
    wrap.scrollIntoView({ block: 'center' });
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function onDblClick(ev: MouseEvent) {
    const wrap = (ev.target as HTMLElement).closest<HTMLElement>('.page-wrap');
    if (!wrap || !syncIndex) return;
    const rect = wrap.getBoundingClientRect();
    const r = reverseSearch(syncIndex, Number(wrap.dataset.page), (ev.clientX - rect.left) / zoom, (ev.clientY - rect.top) / zoom);
    if (r) onReverse?.(r.file, r.line);
  }

  function onScroll() {
    const wraps = scroller.querySelectorAll<HTMLElement>('.page-wrap');
    const mid = scroller.scrollTop + scroller.clientHeight / 3;
    for (const w of wraps) {
      if (w.offsetTop + w.offsetHeight > mid) {
        current = Number(w.dataset.page);
        break;
      }
    }
  }

  function goto(n: number) {
    const w = scroller.querySelector<HTMLElement>(`.page-wrap[data-page="${n}"]`);
    if (w) scroller.scrollTo({ top: w.offsetTop - 12, behavior: 'smooth' });
  }

  $effect(() => {
    void rev;
    void zoom;
    untrack(() => void render());
  });

  $effect(() => {
    void highlight;
    untrack(drawHighlight);
  });

  onDestroy(() => {
    token++;
    doc?.destroy();
  });
</script>

<div class="pdf-pane pane" data-testid="pdf-pane">
  <div class="toolbar">
    <button class="small" onclick={() => (zoom = Math.max(0.5, +(zoom - 0.1).toFixed(2)))} aria-label="Zoom out">−</button>
    <span style="min-width: 3.5em; text-align: center">{Math.round(zoom * 100)}%</span>
    <button class="small" onclick={() => (zoom = Math.min(3, +(zoom + 0.1).toFixed(2)))} aria-label="Zoom in">+</button>
    <span class="spacer"></span>
    {#if pageCount}
      <button class="small" onclick={() => goto(Math.max(1, current - 1))} aria-label="Previous page">‹</button>
      <span>{current} / {pageCount}</span>
      <button class="small" onclick={() => goto(Math.min(pageCount, current + 1))} aria-label="Next page">›</button>
    {/if}
    {#if stale && pdf}<span class="pill warn" data-testid="stale-badge" title="Edits are newer than this PDF">outdated</span>{/if}
    {#if compiledBy}<span class="muted" data-testid="compiled-by">compiled by {compiledBy}</span>{/if}
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (scrollable regions must be keyboard-focusable, WCAG 2.1.1) -->
  <div class="pdf-scroll" bind:this={scroller} onscroll={onScroll} ondblclick={onDblClick} role="document" aria-label="PDF preview" tabindex="0" data-testid="pdf-scroll">
    {#if !pdf}
      <p class="muted" style="text-align: center; margin-top: 40px">No PDF yet. A connected device with a LaTeX compiler will build it for everyone.</p>
    {/if}
  </div>
  {#if error}<div class="error" style="margin: 0">{error}</div>{:else if rendering}<div class="muted" style="padding: 2px 10px; font-size: 12px">Rendering…</div>{:else}<div></div>{/if}
</div>
