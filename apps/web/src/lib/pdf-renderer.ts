import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';

export interface PreviewState { pages: number; current: number; loading: boolean; error: string }
export type PdfLoader = (bytes: Uint8Array) => Promise<PDFDocumentLoadingTask>;
type Anchor = { page: number; fraction: number };
interface Generation {
  zoom: number;
  task?: PDFDocumentLoadingTask;
  doc?: PDFDocumentProxy;
  wraps: HTMLElement[];
  pages: Map<number, PDFPageProxy>;
  renders: Map<number, RenderTask>;
  running: Set<number>;
  done: Set<number>;
  failed: Set<number>;
  desired: Set<number>;
  queue: number[];
}

/** Owns loading/render tasks by generation. Only visible pages and their immediate neighbors keep canvases. */
export class PdfRenderer {
  private generation: Generation | null = null;
  private state: PreviewState = { pages: 0, current: 1, loading: false, error: '' };
  private closed = false;
  private readingAnchor: Anchor = { page: 1, fraction: 0 };
  private resize: ResizeObserver | undefined;
  static readonly MAX_CANVASES = 6;
  static readonly CONCURRENCY = 2;

  constructor(private scroller: HTMLElement, private load: PdfLoader, private change: (state: PreviewState) => void, private painted: () => void = () => {}, private host: HTMLElement = scroller) {
    if (typeof ResizeObserver === 'undefined') return;
    let width = scroller.clientWidth, height = scroller.clientHeight;
    this.resize = new ResizeObserver(() => {
      const nextWidth = scroller.clientWidth, nextHeight = scroller.clientHeight;
      if (width === nextWidth && height === nextHeight) return;
      width = nextWidth; height = nextHeight;
      this.update();
    });
    this.resize.observe(scroller);
  }
  private active(g: Generation) { return !this.closed && this.generation === g; }
  get ready() { return !!this.generation?.doc && this.generation.wraps.length > 0; }
  private report(patch: Partial<PreviewState>) { this.state = { ...this.state, ...patch }; this.change(this.state); }

  private anchor(): Anchor {
    const wraps = this.generation?.wraps ?? [];
    // Loading generations have no geometry. Keep the last displayed position through overlapping replacements.
    if (!wraps.length) return this.readingAnchor;
    let page = 0;
    for (let n = 0; n < wraps.length; n++) if (wraps[n]!.offsetTop <= this.scroller.scrollTop) page = n;
    const wrap = wraps[page];
    this.readingAnchor = { page: page + 1, fraction: wrap ? Math.max(0, Math.min(1, (this.scroller.scrollTop - wrap.offsetTop) / (wrap.offsetHeight || 1))) : 0 };
    return this.readingAnchor;
  }
  private restore(anchor: Anchor, g: Generation) {
    const wrap = g.wraps[Math.min(g.wraps.length, anchor.page) - 1];
    if (wrap) this.scroller.scrollTop = wrap.offsetTop + anchor.fraction * wrap.offsetHeight;
  }

  async show(bytes: Uint8Array | null, zoom: number) {
    if (this.closed) return;
    const anchor = this.anchor();
    this.release(this.generation);
    const g: Generation = { zoom, wraps: [], pages: new Map(), renders: new Map(), running: new Set(), done: new Set(), failed: new Set(), desired: new Set(), queue: [] };
    this.generation = g;
    this.host.replaceChildren();
    this.report({ pages: 0, current: anchor.page, loading: !!bytes, error: '' });
    if (!bytes) return;
    try {
      const task = await this.load(bytes.slice());
      if (!this.active(g)) { void task.destroy().catch(() => {}); return; }
      g.task = task;
      const doc = await task.promise;
      if (!this.active(g)) return;
      g.doc = doc;
      const first = await doc.getPage(1);
      if (!this.active(g)) { first.cleanup(); return; }
      g.pages.set(1, first);
      const viewport = first.getViewport({ scale: zoom });
      const fragment = document.createDocumentFragment();
      for (let n = 1; n <= doc.numPages; n++) {
        const wrap = document.createElement('div');
        wrap.className = 'page-wrap'; wrap.dataset.page = String(n);
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', `PDF page ${n}`);
        wrap.style.width = `${viewport.width}px`; wrap.style.height = `${viewport.height}px`;
        g.wraps.push(wrap); fragment.append(wrap);
      }
      this.host.replaceChildren(fragment);
      this.restore(anchor, g);
      this.report({ pages: doc.numPages });
      this.update();
    } catch (error) {
      if (this.active(g)) this.report({ loading: false, error: error instanceof Error ? error.message : 'Could not load the PDF' });
    }
  }

  update() {
    const g = this.generation;
    if (!g || !this.active(g) || !g.wraps.length) return;
    const top = this.scroller.scrollTop, bottom = top + this.scroller.clientHeight;
    const visible = g.wraps.flatMap((w, i) => w.offsetTop + w.offsetHeight >= top && w.offsetTop <= bottom ? [i + 1] : []);
    const first = visible[0] ?? Math.min(g.wraps.length, this.state.current);
    const last = visible.at(-1) ?? first;
    const order = [...visible, first - 1, last + 1].filter((n) => n >= 1 && n <= g.wraps.length).slice(0, PdfRenderer.MAX_CANVASES);
    g.desired = new Set(order);
    for (const [n, task] of g.renders) if (!g.desired.has(n)) { task.cancel(); this.evict(g, n); }
    for (const [n, page] of g.pages) if (!g.desired.has(n) && !g.running.has(n)) {
      this.evict(g, n); page.cleanup(); g.pages.delete(n);
    }
    const current = g.wraps.findIndex((w) => w.offsetTop + w.offsetHeight > top + this.scroller.clientHeight / 3) + 1;
    this.report({ current: current || g.wraps.length });
    g.queue = order.filter((n) => !g.done.has(n) && !g.running.has(n) && !g.failed.has(n));
    this.pump(g);
  }

  private pump(g: Generation) {
    if (!this.active(g)) return;
    while (g.running.size < PdfRenderer.CONCURRENCY && g.queue.length) {
      const n = g.queue.shift()!; g.running.add(n);
      void this.renderPage(g, n);
    }
    this.report({ loading: g.running.size > 0 || g.queue.length > 0 });
  }

  private async renderPage(g: Generation, n: number) {
    try {
      const page = g.pages.get(n) ?? await g.doc!.getPage(n);
      if (!this.active(g) || !g.desired.has(n)) { page.cleanup(); return; }
      g.pages.set(n, page);
      const wrap = g.wraps[n - 1]!;
      const viewport = page.getViewport({ scale: g.zoom });
      const anchor = this.anchor();
      wrap.style.width = `${viewport.width}px`; wrap.style.height = `${viewport.height}px`;
      this.restore(anchor, g);
      const canvas = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr); canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      wrap.append(canvas);
      const task = page.render({ canvas, viewport, ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}) });
      g.renders.set(n, task);
      await task.promise;
      if (!this.active(g) || !g.desired.has(n)) return;
      g.done.add(n);
      wrap.dataset.rendered = 'true';
      this.painted();
    } catch (error) {
      if (this.active(g) && g.desired.has(n) && !(error instanceof Error && error.name === 'RenderingCancelledException')) {
        g.failed.add(n);
        this.report({ error: error instanceof Error ? error.message : `Could not render page ${n}` });
      }
    } finally {
      g.running.delete(n); g.renders.delete(n);
      if (!this.active(g) || !g.desired.has(n) || !g.done.has(n)) {
        this.evict(g, n); g.pages.get(n)?.cleanup(); g.pages.delete(n);
      }
      if (this.active(g)) this.update();
    }
  }

  private evict(g: Generation, n: number) {
    const wrap = g.wraps[n - 1];
    if (wrap) delete wrap.dataset.rendered;
    for (const canvas of g.wraps[n - 1]?.querySelectorAll('canvas') ?? []) { canvas.width = canvas.height = 0; canvas.remove(); }
    g.done.delete(n);
  }
  private release(g: Generation | null) {
    if (!g) return;
    for (const task of g.renders.values()) task.cancel();
    for (let n = 1; n <= g.wraps.length; n++) this.evict(g, n);
    void g.task?.destroy().catch(() => {});
  }
  goto(n: number) {
    const wrap = this.generation?.wraps[n - 1];
    if (wrap) { this.scroller.scrollTop = Math.max(0, wrap.offsetTop - 12); this.update(); }
  }
  close() { this.closed = true; this.resize?.disconnect(); this.release(this.generation); this.generation = null; this.host.replaceChildren(); }
}
