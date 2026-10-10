import type { CompileEngine, CompileInput, CompileOutput } from '@hivetex/compile';
import { safeStorage } from './api.js';

/**
 * In-browser compilation with SwiftLaTeX (pdfTeX / XeTeX compiled to WebAssembly) in a dedicated worker.
 * Only package file *names* are requested from the TeX file server; project sources never leave the device.
 * Loaded lazily: nothing is downloaded until the first compile on this device.
 */
const DEFAULT_TEXLIVE = 'https://texlive2.swiftlatex.com/';

export function texliveEndpoint(): string {
  return safeStorage('texliveUrl') ?? (import.meta.env.VITE_TEXLIVE_URL as string | undefined) ?? DEFAULT_TEXLIVE;
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
    w.postMessage({ cmd: 'settexliveurl', url: texliveEndpoint() });
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
