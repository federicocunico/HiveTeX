import { sha256Hex } from '@hivetex/sync';
import type { EngineKind, TexEngine } from './capability.js';
import type { CompileEngine, CompileInput, CompileOutput } from './pipeline.js';

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface EngineInfo {
  flavor: string;
  supports: TexEngine[];
  has_latexmk: boolean;
}

interface CompileResp {
  ok: boolean;
  need: string[];
  pdf_b64: string | null;
  synctex_b64: string | null;
  log: string;
  timed_out: boolean;
}

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Bridges to the Tauri `tex_compile` command (system TeX Live / MiKTeX / MacTeX). Only files whose
 * hash changed are sent; the Rust side keeps a persistent working directory so auxiliary files are
 * reused between runs.
 */
export class NativeEngine implements CompileEngine {
  readonly kind: EngineKind = 'native';
  supports: TexEngine[] = [];
  private sent = new Map<string, string>();

  constructor(
    private invoke: Invoke,
    private project: string,
    private limits: { memoryMb: number } = { memoryMb: 2048 },
  ) {}

  /** Detects installed engines; returns false if no TeX distribution is available. */
  async init(): Promise<boolean> {
    const info = await this.invoke<EngineInfo | null>('tex_detect');
    this.supports = info?.supports ?? [];
    return !!info;
  }

  async compile(input: CompileInput, opts: { timeoutMs: number }): Promise<CompileOutput> {
    const enc = new TextEncoder();
    const prepared = await Promise.all(
      input.files.map(async (f) => {
        const bytes = f.kind === 'text' ? enc.encode(f.text ?? '') : (f.bytes ?? new Uint8Array());
        return { path: f.path, hash: await sha256Hex(bytes), bytes };
      }),
    );
    const build = (forceAll: boolean) => ({
      project: this.project,
      files: prepared.map((p) => ({
        path: p.path,
        hash: p.hash,
        content_b64: forceAll || this.sent.get(p.path) !== p.hash ? toB64(p.bytes) : null,
      })),
      main: input.main,
      engine: input.engine,
      timeout_ms: opts.timeoutMs,
      memory_mb: this.limits.memoryMb,
    });
    let resp = await this.invoke<CompileResp>('tex_compile', { req: build(false) });
    if (resp.need.length) resp = await this.invoke<CompileResp>('tex_compile', { req: build(true) });
    if (!resp.need.length) for (const p of prepared) this.sent.set(p.path, p.hash);
    return {
      ok: resp.ok,
      log: resp.log,
      ...(resp.pdf_b64 ? { pdf: fromB64(resp.pdf_b64) } : {}),
      ...(resp.synctex_b64 ? { synctex: fromB64(resp.synctex_b64) } : {}),
    };
  }
}
