import type { CompileEngine, CompileInput, CompileOutput } from '@hivetex/compile';
import { isDesktop, safeStorage } from './api.js';

/**
 * In-browser compilation with SwiftLaTeX (pdfTeX / XeTeX compiled to WebAssembly) in a dedicated worker.
 * Only package file *names* are requested from the TeX file server; project sources never leave the device.
 * Loaded lazily: nothing is downloaded until the first compile on this device.
 */
const BUNDLED_TEX = new URL(`${import.meta.env.BASE_URL}${import.meta.env.VITE_TEX_DISTRIBUTION}`, location.href).href;
export const texCacheName = (endpoint: string) => `hivetex-tex-v2:${endpoint}`;

export function customTexliveEndpoint(): string {
  const configured = safeStorage('texliveUrl') ?? (import.meta.env.VITE_TEXLIVE_URL as string | undefined);
  const url = configured?.trim().replace(/\/+$/, '');
  // Older Account versions persisted the public default when saving unrelated connection settings.
  // Migrate that default with the app; explicitly configured private/versioned servers remain overrides.
  return url && url !== 'https://texlive2.swiftlatex.com' ? `${url}/` : '';
}
export const texliveEndpoint = (): string => customTexliveEndpoint() || BUNDLED_TEX;

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
let cacheEndpoint = '';
/** Sets up the TeX file cache once per page (best effort: without it files are simply downloaded again). */
function setUpCache(): Promise<void> {
  if (cacheEndpoint !== texliveEndpoint()) {
    cacheEndpoint = texliveEndpoint();
    engineEndpoint = cacheEndpoint;
    cacheReady = null;
  }
  cacheReady ??= (async () => {
    try {
      if (isDesktop && cacheEndpoint !== BUNDLED_TEX) {
        const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
        await invoke('texcache_set_upstream', { url: texliveEndpoint() });
        await listen<TexFetch>('texcache://fetch', (e) => emitFetch(e.payload));
        engineEndpoint = navigator.userAgent.includes('Windows') ? 'http://texcache.localhost/' : 'texcache://localhost/';
      } else if (!isDesktop && 'serviceWorker' in navigator && window.isSecureContext) {
        navigator.serviceWorker.addEventListener('message', (e) => {
          const d = e.data as { type?: string } & TexFetch;
          if (d?.type === 'hivetex-tex') emitFetch({ file: d.file, state: d.state });
        });
        const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js?tex=${encodeURIComponent(texliveEndpoint())}`);
        await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 3000))]);
        // ready may refer to the previous registration during an endpoint change. Wait for this update to activate.
        const pending = registration.installing ?? registration.waiting;
        if (pending && pending.state !== 'activated') await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          pending.addEventListener('statechange', () => { if (pending.state === 'activated' || pending.state === 'redundant') { clearTimeout(timer); resolve(); } });
        });
      }
    } catch (e) {
      console.warn('TeX file cache unavailable', e);
      engineEndpoint = texliveEndpoint();
    }
  })();
  return cacheReady;
}

/** Empties the in-browser compiler's TeX file cache on this device. */
const liveRunners = new Set<WeakRef<Runner>>();
let activeBuilds = 0;
let clearingCache = false;

export async function clearTexCache(allCompilerCaches = false): Promise<void> {
  if (activeBuilds || clearingCache) throw new Error('Compiler activity is in progress. Wait for it to finish, then clear the cache.');
  clearingCache = true;
  try {
    if (isDesktop) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke(allCompilerCaches ? 'compiler_cache_clear' : 'texcache_clear');
    }
    if ('caches' in window) {
      for (const key of await caches.keys()) if (key.startsWith('hivetex-tex-')) await caches.delete(key);
    }
    for (const reference of liveRunners) {
      const runner = reference.deref();
      if (runner) runner.stop();
      else liveRunners.delete(reference);
    }
    try { sessionStorage.removeItem('hivetex.texserver'); } catch { /* storage unavailable */ }
  } finally { clearingCache = false; }
}

type EngineName = 'pdflatex' | 'xelatex';
type WorkerName = EngineName | 'dvipdfm';
const SCRIPT: Record<WorkerName, string> = { pdflatex: 'swiftlatexpdftex.js', xelatex: 'swiftlatexxetex.js', dvipdfm: 'swiftlatexdvipdfm.js' };
/** The engine's .wasm download has its own, longer limit: a slow first download is not a silent worker. */
const WASM_DOWNLOAD_MS = 5 * 60_000;
const wasmFiles = new Map<string, Promise<void>>();
const engineAsset = (name: WorkerName, endpoint: string, extension: 'js' | 'wasm') =>
  `${endpoint === BUNDLED_TEX ? endpoint : `${import.meta.env.BASE_URL}swiftlatex/`}${SCRIPT[name].replace(/\.js$/, `.${extension}`)}`;

/**
 * Downloads the engine's .wasm once per page before a worker starts, so the startup deadline measures the worker only;
 * the worker then loads it from the HTTP cache. A failed download is retried by the next start.
 */
export function prefetchWasm(name: WorkerName, endpoint = engineEndpoint): Promise<void> {
  const key = `${endpoint}:${name}`;
  let pending = wasmFiles.get(key);
  if (!pending) {
    pending = (async () => {
      const r = await fetch(engineAsset(name, endpoint, 'wasm'), { credentials: 'same-origin', signal: AbortSignal.timeout(WASM_DOWNLOAD_MS) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await r.arrayBuffer?.();
    })().catch((e: unknown) => {
      wasmFiles.delete(key);
      throw new Error(`The in-browser compiler could not be downloaded (${e instanceof Error ? e.message : String(e)}); retry when online.`);
    });
    wasmFiles.set(key, pending);
  }
  return pending;
}

export class Runner {
  private worker: Worker | null = null;
  private paths = '';
  /** Directories created in the current worker (its file system cannot create one twice). */
  private dirs = new Set<string>();
  private cancel: (() => void) | null = null;
  /** A stop invalidates continuations even after their awaited promise has already resolved. */
  private generation = 0;

  constructor(private name: WorkerName, private startupMs = 30_000, private prepare: (name: WorkerName) => Promise<void> = (name) => prefetchWasm(name, this.endpoint), private endpoint = engineEndpoint) { liveRunners.add(new WeakRef(this)); }

  /** Whether a worker is running. */
  get running() { return this.worker !== null; }

  private async start(): Promise<Worker> {
    const generation = this.generation;
    // The download is not part of the startup deadline; cancelling still settles it at once.
    await new Promise<void>((resolve, reject) => {
      this.cancel = () => reject(new Error('Compiler stopped'));
      this.prepare(this.name).then(resolve, reject);
    }).finally(() => { if (generation === this.generation) this.cancel = null; });
    if (generation !== this.generation) throw new Error('Compiler stopped');
    const w = new Worker(engineAsset(this.name, this.endpoint, 'js'));
    this.worker = w;
    this.dirs.clear();
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          w.onmessage = null;
          w.onerror = null;
          this.cancel = null;
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(new Error('Compiler startup timed out; retry to start a fresh worker.')), this.startupMs);
        this.cancel = () => finish(new Error('Compiler stopped'));
        w.onmessage = (ev) => finish(ev.data?.result === 'ok' ? undefined : new Error('Compiler failed to start'));
        w.onerror = () => finish(new Error('Compiler failed to load'));
      });
      if (generation !== this.generation) throw new Error('Compiler stopped');
      w.postMessage({ cmd: 'settexliveurl', url: this.endpoint });
    } catch (error) { if (this.worker === w) this.stop(); throw error; }
    return w;
  }

  stop() {
    this.generation++;
    this.cancel?.();
    this.cancel = null;
    this.worker?.terminate();
    this.worker = null;
    this.dirs.clear();
  }

  async compile(input: CompileInput, timeoutMs: number, signal?: AbortSignal, onBuildStart?: () => void): Promise<CompileOutput> {
    if (signal?.aborted) return { ok: false, log: '! Compilation cancelled' };
    const abort = () => this.stop();
    signal?.addEventListener('abort', abort, { once: true });
    try { return await this.build(input, timeoutMs, onBuildStart); }
    catch (error) { return { ok: false, log: `! ${error instanceof Error ? error.message : String(error)}` }; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  private async build(input: CompileInput, timeoutMs: number, onBuildStart?: () => void): Promise<CompileOutput> {
    const pathKey = input.files.map((f) => f.path).sort().join('\0');
    // The worker cannot delete files, so a changed file set gets a fresh worker.
    if (this.worker && pathKey !== this.paths) this.stop();
    const generation = this.generation;
    if (!this.worker) await this.start();
    if (generation !== this.generation) throw new Error('Compiler stopped');
    this.paths = pathKey;
    const w = this.worker as Worker;
    const dirs = new Set<string>();
    for (const f of input.files) {
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    const newDirs = [...dirs].filter((d) => !this.dirs.has(d)).sort((a, b) => a.length - b.length);
    // The worker answers every mkdir and writefile, in order, before it answers the build.
    const acks: Array<{ cmd: 'mkdir' | 'writefile'; path: string }> = [
      ...newDirs.map((path) => ({ cmd: 'mkdir' as const, path })),
      ...input.files.map((f) => ({ cmd: 'writefile' as const, path: f.path })),
    ];
    // The vendored worker runs BibTeX after each TeX pass. Its first PDF therefore cannot contain a new
    // bibliography. Keep auxiliary files in the same worker and complete the passes within one deadline.
    const minimumPasses = this.name !== 'dvipdfm' && input.files.some((f) => f.path.endsWith('.bib')) ? 3 : 1;
    const command = this.name === 'dvipdfm' ? 'compilepdf' : 'compilelatex';
    let pass = 1;
    onBuildStart?.();
    if (generation !== this.generation) throw new Error('Compiler stopped');
    return new Promise<CompileOutput>((resolve) => {
      const finish = (output: CompileOutput, discard = false) => {
        clearTimeout(timer);
        this.cancel = null;
        w.onmessage = null;
        w.onerror = null;
        if (discard) this.stop();
        resolve(output);
      };
      const timer = setTimeout(() => {
        finish({ ok: false, log: `! Compile timed out after ${Math.round(timeoutMs / 1000)} s` }, true);
      }, timeoutMs);
      this.cancel = () => finish({ ok: false, log: '! Compilation stopped' });
      w.onerror = () => finish({ ok: false, log: '! Compiler worker crashed; retry to start a fresh worker.' }, true);
      w.onmessage = (ev) => {
        const d = ev.data as { cmd?: string; result?: string; log?: string; pdf?: ArrayBuffer; status?: number };
        if (d.cmd === 'mkdir' || d.cmd === 'writefile') {
          const ack = acks.shift();
          // Never build partial input; this worker's files are unknown now, so the next build starts a fresh one.
          if (!ack || ack.cmd !== d.cmd || d.result !== 'ok') return finish({ ok: false, log: `! The compiler could not ${ack?.cmd === 'mkdir' ? 'create the folder' : 'write'} ${ack?.path ?? 'a project file'}; retry to start a fresh worker.` }, true);
          if (ack.cmd === 'mkdir') this.dirs.add(ack.path);
          return;
        }
        if (d.cmd !== 'compile') return;
        if (acks.length) return finish({ ok: false, log: `! The compiler did not confirm ${acks[0]?.path}; retry to start a fresh worker.` }, true);
        const pdf = d.result === 'ok' && d.pdf ? new Uint8Array(d.pdf) : undefined;
        const rerun = /Rerun to get cross-references right|Label\(s\) may have changed|There were undefined references|No file .+\.(?:toc|bbl)/i.test(d.log ?? '');
        if (pdf && d.status === 0 && (pass < minimumPasses || (rerun && pass < 5))) {
          pass++;
          w.postMessage({ cmd: command });
          return;
        }
        finish({ ok: !!pdf && d.status === 0, ...(pdf ? { pdf } : {}), log: d.log ?? '' });
      };
      try {
        for (const d of newDirs) w.postMessage({ cmd: 'mkdir', url: d });
        for (const f of input.files) w.postMessage({ cmd: 'writefile', url: f.path, src: f.kind === 'text' ? (f.text ?? '') : (f.bytes ?? new Uint8Array()) });
        w.postMessage({ cmd: 'setmainfile', url: input.main });
        w.postMessage({ cmd: command });
      } catch (error) { finish({ ok: false, log: `! Cannot send compiler input: ${String(error)}` }, true); }
    });
  }
}

/** A reachable server is remembered for 10 minutes; an unreachable one only briefly, so a later build tries again. */
const REACHABLE_TTL_MS = 10 * 60_000;
const UNREACHABLE_TTL_MS = 15_000;

/** Checks that the configured TeX file server answers; without it the in-browser engine cannot load packages. */
export async function texServerReachable(): Promise<boolean> {
  const key = 'hivetex.texserver';
  try {
    const cached = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { ok: boolean; at: number; url: string } | null;
    if (cached && cached.url === texliveEndpoint() && Date.now() - cached.at < (cached.ok ? REACHABLE_TTL_MS : UNREACHABLE_TTL_MS)) return cached.ok;
  } catch {
    /* ignore */
  }
  let ok = false;
  try {
    const endpoint = texliveEndpoint();
    const r = await fetch(`${endpoint}${endpoint === BUNDLED_TEX ? 'manifest.json' : 'pdftex/10/swiftlatexpdftex.fmt'}`, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
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

/** Engines this device can run now: every one with a reachable TeX file server, else those whose format is cached. */
async function availableEngines(): Promise<EngineName[]> {
  const reachable = await texServerReachable();
  const supports: EngineName[] = [];
  for (const name of ['pdflatex', 'xelatex'] as const) {
    if (reachable || await cachedFormat(name)) supports.push(name);
  }
  return supports;
}

export type WasmEngine = CompileEngine & { supports: EngineName[] };

/** The in-browser engine of one session: its workers end with `dispose` (the session closes). */
export async function loadWasmEngine(_project: string): Promise<WasmEngine | null> {
  if (safeStorage('hivetex.fakeEngine') === '1') return (await import('./fake-engine.js')).fakeEngine as WasmEngine;
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return null;
  await setUpCache();
  const endpoint = engineEndpoint;
  const supports = await availableEngines();
  if (!supports.length) return null;
  const runners: Partial<Record<WorkerName, Runner>> = {};
  let disposed = false;
  return {
    kind: 'wasm',
    supports,
    async refresh() {
      if (disposed || supports.length === 2) return;
      for (const name of await availableEngines()) if (!supports.includes(name)) supports.push(name);
    },
    dispose() {
      disposed = true;
      for (const runner of Object.values(runners)) runner?.stop();
    },
    async compile(input, opts) {
      if (disposed) return { ok: false, log: '! The project was closed' };
      if (clearingCache) return { ok: false, log: '! Compiler cache maintenance is active; try compiling again when it finishes.' };
      const name = (input.engine === 'xelatex' ? 'xelatex' : 'pdflatex') as EngineName;
      if (input.engine === 'lualatex') return { ok: false, log: '! LuaLaTeX is not available in the browser engine' };
      if (!supports.includes(name)) return { ok: false, log: '! This compiler format is not cached and the TeX package server is unavailable.' };
      runners[name] ??= new Runner(name, 30_000, name === 'xelatex' ? async () => { await Promise.all([prefetchWasm('xelatex', endpoint), prefetchWasm('dvipdfm', endpoint)]); } : undefined, endpoint);
      activeBuilds++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (name !== 'xelatex') return await (runners[name] as Runner).compile(input, opts.timeoutMs, opts.signal);
        // XeTeX emits XDV, not PDF. Both downloads use Runner's cancellable preparation; the single execution
        // deadline begins with the first TeX pass and also covers converter startup and execution.
        const controller = new AbortController();
        const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
        let deadline = 0;
        const xdv = await (runners[name] as Runner).compile(input, opts.timeoutMs, signal, () => {
          deadline = performance.now() + opts.timeoutMs;
          timer = setTimeout(() => controller.abort(), opts.timeoutMs);
        });
        if (controller.signal.aborted) return { ok: false, log: '! Compile timed out during XeTeX/PDF conversion' };
        if (!xdv.ok || !xdv.pdf) return xdv;
        if (opts.signal?.aborted || disposed) return { ok: false, log: '! Compilation stopped' };
        const remaining = deadline - performance.now();
        if (remaining <= 0) return { ok: false, log: '! Compile timed out before PDF conversion' };
        const main = input.main.replace(/\.[^.]+$/, '') + '.xdv';
        // The shared abort deadline bounds this attempt; do not retain a previous attempt's short budget.
        runners.dvipdfm ??= new Runner('dvipdfm', 30_000, undefined, endpoint);
        // Include original image/font assets; the generated XDV always wins a same-path collision.
        const files = [...input.files.filter(f => f.path !== main), { path: main, kind: 'binary' as const, bytes: xdv.pdf }];
        const pdf = await runners.dvipdfm.compile({ ...input, main, files }, remaining, signal);
        if (controller.signal.aborted) return { ok: false, log: '! Compile timed out during XeTeX/PDF conversion' };
        return { ...pdf, log: `${xdv.log}\n${pdf.log}` };
      } catch (error) { return { ok: false, log: `! ${error instanceof Error ? error.message : String(error)}` }; }
      finally { clearTimeout(timer); activeBuilds--; }
    },
  };
}

async function cachedFormat(name: EngineName): Promise<boolean> {
  const rel = name === 'pdflatex' ? 'pdftex/10/swiftlatexpdftex.fmt' : 'xetex/10/swiftlatexxetex.fmt';
  try {
    if (isDesktop && texliveEndpoint() !== BUNDLED_TEX) {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('texcache_contains', { rel });
    }
    if (!('caches' in window)) return false;
    const cache = await caches.open(texCacheName(texliveEndpoint()));
    if (texliveEndpoint() === BUNDLED_TEX) {
      const manifest = await cache.match(`${BUNDLED_TEX}manifest.json`);
      const data = await manifest?.json() as { files: Record<string, string> } | undefined;
      const hash = data?.files[name === 'pdflatex' ? 'swiftlatexpdftex.fmt' : 'swiftlatexxetex.fmt'];
      return !!hash && !!(await cache.match(`${BUNDLED_TEX}files/${hash}`))?.ok;
    }
    const hit = await cache.match(`${texliveEndpoint()}${rel}`);
    return !!hit?.ok && !hit.headers.get('x-hivetex-missing');
  } catch { return false; }
}
