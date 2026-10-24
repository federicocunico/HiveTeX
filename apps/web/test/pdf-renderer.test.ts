// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PDFDocumentLoadingTask, PDFPageProxy } from 'pdfjs-dist';
import { PdfRenderer, type PreviewState } from '../src/lib/pdf-renderer.js';

const deferred = <T>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const renderers: PdfRenderer[] = [];
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function(this: HTMLElement) { return Number.parseFloat(this.style.height) || 0; });
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function(this: HTMLElement) {
    let top = 16, previous = this.previousElementSibling as HTMLElement | null;
    while (previous) { top += previous.offsetHeight + 16; previous = previous.previousElementSibling as HTMLElement | null; }
    return top;
  });
});
afterEach(() => { for (const r of renderers.splice(0)) r.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function doc(pages = 100, pauseRender = false) {
  const rendered: number[] = [];
  const proxies = new Map<number, PDFPageProxy>();
  const renders = new Map<number, ReturnType<typeof deferred<void>>>();
  const cancel = vi.fn();
  const getPage = vi.fn(async (n: number) => {
    if (!proxies.has(n)) proxies.set(n, {
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      cleanup: vi.fn(),
      render: () => {
        rendered.push(n);
        const gate = deferred<void>(); renders.set(n, gate);
        if (!pauseRender) gate.resolve();
        return { promise: gate.promise, cancel: () => { cancel(n); const e = new Error('cancelled'); e.name = 'RenderingCancelledException'; gate.reject(e); } };
      },
    } as unknown as PDFPageProxy);
    return proxies.get(n)!;
  });
  const gate = deferred<{ numPages: number; getPage: typeof getPage }>();
  const destroy = vi.fn(async () => {});
  const task = { promise: gate.promise, destroy } as unknown as PDFDocumentLoadingTask;
  return { task, gate, destroy, rendered, renders, cancel, getPage, resolve: () => gate.resolve({ numPages: pages, getPage }) };
}
function fixture(tasks: ReturnType<typeof doc>[], height = 600) {
  const scroller = document.createElement('div'); document.body.append(scroller);
  Object.defineProperty(scroller, 'clientHeight', { value: height, configurable: true });
  const states: PreviewState[] = [];
  let i = 0;
  const renderer = new PdfRenderer(scroller, async () => tasks[i++]!.task, (s) => states.push(s));
  renderers.push(renderer);
  return { renderer, scroller, states };
}

it('owns loading generations: old success and failure cannot overwrite the active preview', async () => {
  const a = doc(), b = doc(3), c = doc(5);
  const f = fixture([a, b, c]);
  const first = f.renderer.show(new Uint8Array([1]), 1); await flush();
  const second = f.renderer.show(new Uint8Array([2]), 1); b.resolve(); await second; await flush();
  expect(a.destroy).toHaveBeenCalledOnce();
  a.resolve(); await first;
  expect(f.states.at(-1)?.pages).toBe(3);
  expect(a.getPage).not.toHaveBeenCalled();
  const third = f.renderer.show(new Uint8Array([3]), 1); await flush();
  f.renderer.close(); c.gate.reject(new Error('obsolete load error')); await third;
  expect(c.destroy).toHaveBeenCalledOnce();
  expect(f.states.at(-1)?.error).toBe('');
  expect(f.scroller.children).toHaveLength(0);
});

it('cancels obsolete render tasks on zoom and old failures cannot set current errors', async () => {
  const a = doc(10, true), b = doc(10);
  const f = fixture([a, b]);
  const first = f.renderer.show(new Uint8Array([1]), 1); a.resolve(); await first; await flush();
  expect(a.rendered.length).toBeLessThanOrEqual(2);
  const second = f.renderer.show(new Uint8Array([1]), 1.5); b.resolve(); await second; await flush();
  expect(a.cancel).toHaveBeenCalled();
  expect(a.destroy).toHaveBeenCalledOnce();
  expect(f.states.at(-1)?.error).toBe('');
  expect(f.scroller.querySelector('canvas')?.style.height).toBe('1200px');
});

it('ignores an obsolete load rejection while the replacement is visible', async () => {
  const a = doc(), b = doc(3); const f = fixture([a, b]);
  const first = f.renderer.show(new Uint8Array([1]), 1); await flush();
  const second = f.renderer.show(new Uint8Array([2]), 1); b.resolve(); await second; await flush();
  a.gate.reject(new Error('old PDF failed')); await first;
  expect(f.states.at(-1)).toMatchObject({ pages: 3, error: '', loading: false });
  expect(f.scroller.querySelectorAll('canvas').length).toBeGreaterThan(0);
  expect(a.destroy).toHaveBeenCalledOnce();
});

it('shows page 50 without rendering preceding pages and bounds canvases through distant scrolls', async () => {
  const a = doc(); const f = fixture([a]);
  const first = f.renderer.show(new Uint8Array([1]), 1); a.resolve(); await first; await flush();
  expect(f.scroller.querySelectorAll('.page-wrap')).toHaveLength(100);
  expect(a.rendered.length).toBeLessThan(6);
  for (const n of [50, 98, 10, 75, 1]) {
    f.renderer.goto(n); await flush();
    expect(a.rendered).toContain(n);
    expect(f.scroller.querySelectorAll('canvas').length).toBeLessThanOrEqual(PdfRenderer.MAX_CANVASES);
  }
  expect(a.rendered.length).toBeLessThan(25);
  expect(a.rendered.indexOf(50)).toBeLessThan(5);
});

it('preserves page and fractional reading position across zoom and new output', async () => {
  const a = doc(), b = doc(), c = doc(); const f = fixture([a, b, c]);
  const first = f.renderer.show(new Uint8Array([1]), 1); a.resolve(); await first; await flush();
  const wrap = () => f.scroller.querySelector<HTMLElement>('[data-page="50"]')!;
  f.scroller.scrollTop = wrap().offsetTop + wrap().offsetHeight * 0.4; f.renderer.update(); await flush();
  for (const [data, zoom, next] of [[1, 1.5, b], [2, 1.5, c]] as const) {
    const show = f.renderer.show(new Uint8Array([data]), zoom); next.resolve(); await show; await flush();
    expect((f.scroller.scrollTop - wrap().offsetTop) / wrap().offsetHeight).toBeCloseTo(0.4, 3);
  }
});

it('renders newly exposed pages on resize, ignores unchanged size and disconnects on close', async () => {
  let resized!: () => void;
  const observe = vi.fn(), disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resized = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  const a = doc(10, true); const f = fixture([a], 300);
  let height = 300;
  Object.defineProperty(f.scroller, 'clientHeight', { get: () => height });
  const source = document.createElement('button'); document.body.append(source); source.focus();
  const show = f.renderer.show(new Uint8Array([1]), 0.5); a.resolve(); await show; await flush();
  a.renders.get(1)!.resolve(); a.renders.get(2)!.resolve(); await flush();
  expect(a.rendered).toEqual([1, 2]);
  expect(observe).toHaveBeenCalledWith(f.scroller);

  height = 1000; resized(); await flush();
  expect(f.scroller.querySelector<HTMLElement>('[data-page="3"]')!.offsetTop).toBeLessThan(height);
  expect(a.rendered).toEqual([1, 2, 3, 4]);
  expect(f.scroller.querySelectorAll('canvas').length).toBeLessThanOrEqual(PdfRenderer.MAX_CANVASES);
  a.renders.get(3)!.resolve(); a.renders.get(4)!.resolve(); await flush();
  expect(f.scroller.querySelector('[data-page="3"]')?.getAttribute('data-rendered')).toBe('true');
  const states = f.states.length;
  resized(); await flush();
  expect(f.states).toHaveLength(states);
  expect(a.rendered).toEqual([1, 2, 3, 4]);
  expect(document.activeElement).toBe(source);

  height = 100; resized(); await flush();
  expect(f.scroller.querySelectorAll('canvas')).toHaveLength(2);
  f.renderer.close(); expect(disconnect).toHaveBeenCalledOnce();
  const closedStates = f.states.length;
  height = 2000; resized(); await flush();
  expect(f.states).toHaveLength(closedStates);
  expect(f.scroller.children).toHaveLength(0);
});

it('retains its reading anchor through overlapping zoom/output loads and ignores late restoration', async () => {
  const a = doc(), b = doc(), c = doc(); const f = fixture([a, b, c]);
  const initial = f.renderer.show(new Uint8Array([1]), 1); a.resolve(); await initial; await flush();
  const wrap = () => f.scroller.querySelector<HTMLElement>('[data-page="50"]')!;
  f.scroller.scrollTop = wrap().offsetTop + wrap().offsetHeight * 0.4;
  f.renderer.update(); await flush();
  const zoom = f.renderer.show(new Uint8Array([1]), 1.1); await flush();
  const replacement = f.renderer.show(new Uint8Array([2]), 1.2); c.resolve(); await replacement; await flush();
  expect((f.scroller.scrollTop - wrap().offsetTop) / wrap().offsetHeight).toBeCloseTo(0.4, 3);
  expect(c.rendered).toContain(50);
  f.renderer.goto(80); await flush();
  const target = f.scroller.scrollTop;
  b.resolve(); await zoom; await flush();
  expect(f.scroller.scrollTop).toBe(target);
  expect(b.destroy).toHaveBeenCalledOnce();
  expect(b.getPage).not.toHaveBeenCalled();
  expect(f.scroller.querySelectorAll('canvas').length).toBeLessThanOrEqual(PdfRenderer.MAX_CANVASES);
});

it('ten open/close cycles release every task and canvas', async () => {
  for (let n = 0; n < 10; n++) {
    const a = doc(); const f = fixture([a]);
    const show = f.renderer.show(new Uint8Array([n]), 1); a.resolve(); await show; await flush();
    f.renderer.close(); expect(a.destroy).toHaveBeenCalledOnce();
    expect(f.scroller.querySelectorAll('canvas')).toHaveLength(0);
  }
});
