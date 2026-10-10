import type { CompileEngine, CompileInput, CompileOutput } from '@hivetex/compile';
import { isDesktop, safeStorage } from './api.js';

/**
 * In-browser compilation with SwiftLaTeX (pdfTeX / XeTeX compiled to WebAssembly) in a dedicated worker.
 * Only package file *names* are requested from the TeX file server; project sources never leave the device.
 * Loaded lazily: nothing is downloaded until the first compile on this device.
 */
const DEFAULT_TEXLIVE = 'https://texlive2.swiftlatex.com/';

export function texliveEndpoint(): string {
  return safeStorage('texliveUrl') ?? (import.meta.env.VITE_TEXLIVE_URL as string | undefined) ?? DEFAULT_TEXLIVE;
}

/** Where the compiler worker loads TeX files from: on the desktop, the app's disk cache (texcache://), which downloads
 * each file from the TeX file server once; on the web, the server itself (with the service worker cache in Chromium). */
let engineEndpoint = texliveEndpoint();

/** A TeX file the compiler is fetching (for the status bar): 'start', then 'done' or 'failed'. */
export type TexFetch = { file: string; state: 'start' | 'done' | 'failed' };
const fetchListeners = new Set<(f: TexFetch) => void>();
export function onTexFetch(cb: (f: TexFetch) => void): () => void {
  fetchListeners.add(cb);
  return () => fetchListeners.delete(cb);
}
const emitFetch = (f: TexFetch) => {
  for (const cb of fetchListeners) cb(f);
};

let cacheReady: Promise<void> | null = null;
/** Sets up the TeX file cache once per page (best effort: without it files are simply downloaded again). */
function setUpCache(): Promise<void> {
  cacheReady ??= (async () => {
    try {
      if (isDesktop) {
        const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
        await invoke('texcache_set_upstream', { url: texliveEndpoint() });
        await listen<TexFetch>('texcache://fetch', (e) => emitFetch(e.payload));
        engineEndpoint = navigator.userAgent.includes('Windows') ? 'http://texcache.localhost/' : 'texcache://localhost/';
      } else if ('serviceWorker' in navigator && window.isSecureContext) {
        navigator.serviceWorker.addEventListener('message', (e) => {
          const d = e.data as { type?: string } & TexFetch;
          if (d?.type === 'hivetex-tex') emitFetch({ file: d.file, state: d.state });
        });
        await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js?tex=${encodeURIComponent(texliveEndpoint())}`);
        await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 3000))]);
      }
    } catch (e) {
      console.warn('TeX file cache unavailable', e);
      engineEndpoint = texliveEndpoint();
    }
  })();
  return cacheReady;
}

/** Empties the in-browser compiler's TeX file cache on this device. */
export async function clearTexCache(): Promise<void> {
  if (isDesktop) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('texcache_clear');
  } else if ('caches' in window) await caches.delete('hivetex-tex-v1');
}

type EngineName = 'pdflatex' | 'xelatex';
const SCRIPT: Record<EngineName, string> = { pdflatex: 'swiftlatexpdftex.js', xelatex: 'swiftlatexxetex.js' };

class Runner {
  private worker: Worker | null = null;
  private paths = '';

  constructor(private name: EngineName) {}

  private async start(): Promise<Worker> {
    const w = new Worker(`${import.meta.env.BASE_URL}swiftlatex/${SCRIPT[this.name]}`);
    await new Promise<void>((resolve, reject) => {
      w.onmessage = (ev) => (ev.data?.result === 'ok' ? resolve() : reject(new Error('engine failed to start')));
      w.onerror = () => reject(new Error('engine failed to load'));
    });
    w.postMessage({ cmd: 'settexliveurl', url: engineEndpoint });
    return w;
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
  }

  async compile(input: CompileInput, timeoutMs: number): Promise<CompileOutput> {
    const pathKey = input.files.map((f) => f.path).sort().join('\0');
    // The worker cannot delete files, so a changed file set gets a fresh worker.
    if (this.worker && pathKey !== this.paths) this.stop();
    this.worker ??= await this.start();
    this.paths = pathKey;
    const w = this.worker;
    const dirs = new Set<string>();
    for (const f of input.files) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const d of [...dirs].sort((a, b) => a.length - b.length)) w.postMessage({ cmd: 'mkdir', url: d });
    for (const f of input.files) {
      w.postMessage({ cmd: 'writefile', url: f.path, src: f.kind === 'text' ? (f.text ?? '') : (f.bytes ?? new Uint8Array()) });
    }
    w.postMessage({ cmd: 'setmainfile', url: input.main });
    return new Promise<CompileOutput>((resolve) => {
      const timer = setTimeout(() => {
        this.stop();
        resolve({ ok: false, log: `! Compile timed out after ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs);
      w.onmessage = (ev) => {
        const d = ev.data as { cmd?: string; result?: string; log?: string; pdf?: ArrayBuffer; status?: number };
        if (d.cmd !== 'compile') return;
        clearTimeout(timer);
        const pdf = d.result === 'ok' && d.pdf ? new Uint8Array(d.pdf) : undefined;
        resolve({ ok: !!pdf && d.status === 0, ...(pdf ? { pdf } : {}), log: d.log ?? '' });
      };
      w.postMessage({ cmd: 'compilelatex' });
    });
  }
}

/** Checks that the configured TeX file server answers; without it the in-browser engine cannot load packages. */
export async function texServerReachable(): Promise<boolean> {
  const key = 'hivetex.texserver';
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { ok: boolean; at: number; url: string } | null;
    if (cached && cached.url === texliveEndpoint() && Date.now() - cached.at < 10 * 60_000) return cached.ok;
  } catch {
    /* ignore */
  }
  let ok = false;
  try {
    const r = await fetch(`${texliveEndpoint()}pdftex/10/swiftlatexpdftex.fmt`, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
    ok = r.ok;
  } catch {
    ok = false;
  }
  try {
    sessionStorage.setItem(key, JSON.stringify({ ok, at: Date.now(), url: texliveEndpoint() }));
  } catch {
    /* ignore */
  }
  return ok;
}

export async function loadWasmEngine(_project: string): Promise<(CompileEngine & { supports: EngineName[] }) | null> {
  if (safeStorage('hivetex.fakeEngine') === '1') return (await import('./fake-engine.js')).fakeEngine as CompileEngine & { supports: EngineName[] };
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return null;
  if (!(await texServerReachable())) return null;
  await setUpCache();
  const runners: Partial<Record<EngineName, Runner>> = {};
  return {
    kind: 'wasm',
    supports: ['pdflatex', 'xelatex'],
    async compile(input, opts) {
      const name = (input.engine === 'xelatex' ? 'xelatex' : 'pdflatex') as EngineName;
      if (input.engine === 'lualatex') return { ok: false, log: '! LuaLaTeX is not available in the browser engine' };
      runners[name] ??= new Runner(name);
      return (runners[name] as Runner).compile(input, opts.timeoutMs);
    },
  };
}
