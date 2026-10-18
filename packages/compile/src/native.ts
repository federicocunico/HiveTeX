import { sha256Hex } from '@hivetex/sync';
import type { EngineKind, TexEngine } from './capability.js';
import type { CompileEngine, CompileInput, CompileOutput } from './pipeline.js';

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface EngineInfo {
  flavor: string;
  supports: TexEngine[];
  has_latexmk: boolean;
  /** Whether the compiler's file reads are verified; if not (quick compiler), builds must stay on this device. */
  verified_reads?: boolean;
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
const CANCELLED: CompileOutput = { ok: false, log: '! Compilation cancelled' };

/**
 * Bridges to the Tauri `tex_compile` command (system TeX Live / MiKTeX / MacTeX). Only files whose
 * hash changed are sent; the Rust side keeps a persistent working directory so auxiliary files are
 * reused between runs.
 */
export class NativeEngine implements CompileEngine {
  readonly kind: EngineKind = 'native';
  supports: TexEngine[] = [];
  /** e.g. "texlive", "miktex", "tinytex (managed)", "tectonic (managed)". */
  flavor = '';
  /** Whether this distribution supports the verified external-file read guards. */
  verifiedReads = true;
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
    this.flavor = info?.flavor ?? '';
    this.verifiedReads = info?.verified_reads !== false;
    return !!info;
  }

  /** Aborting `signal` asks the desktop app to kill the build's process tree (`tex_cancel`); the build then settles. */
  async compile(input: CompileInput, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<CompileOutput> {
    if (opts.signal?.aborted) return CANCELLED;
    const id = `${this.project}:${crypto.randomUUID()}`;
    const cancel = () => void this.invoke('tex_cancel', { build: id }).catch(() => {});
    opts.signal?.addEventListener('abort', cancel, { once: true });
    try { return await this.run(input, opts, id); }
    finally { opts.signal?.removeEventListener('abort', cancel); }
  }

  private async run(input: CompileInput, opts: { timeoutMs: number; signal?: AbortSignal }, id: string): Promise<CompileOutput> {
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
    if (opts.signal?.aborted) return CANCELLED;
    let resp = await this.invoke<CompileResp>('tex_compile', { req: build(false), build: id });
    if (resp.need.length && !opts.signal?.aborted) resp = await this.invoke<CompileResp>('tex_compile', { req: build(true), build: id });
    // A cancelled build may not have written its inputs: the next one compares against what was confirmed before.
    if (opts.signal?.aborted) return CANCELLED;
    if (!resp.need.length) for (const p of prepared) this.sent.set(p.path, p.hash);
    return {
      ok: resp.ok,
      log: resp.log,
      ...(resp.pdf_b64 ? { pdf: fromB64(resp.pdf_b64) } : {}),
      ...(resp.synctex_b64 ? { synctex: fromB64(resp.synctex_b64) } : {}),
    };
  }
}
