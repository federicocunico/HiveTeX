import type { CompileEngine, CompileInput, CompileOutput, TexEngine } from '@hivetex/compile';
import { apiBase, safeStorage } from './api.js';

/**
 * The HiveTeX desktop app as a compile helper for the web app (design D5): while it runs, a browser on the same
 * computer can compile there (TeX Live, TinyTeX or the quick compiler) instead of in the browser. The helper listens
 * on loopback only; compiling needs a token obtained by pairing, which the user confirms in the desktop app.
 */
const PORTS = [47812, 47813, 47814, 47815];
const TOKEN_KEY = 'hivetex.helper';

export interface HelperStatus {
  port: number;
  /** e.g. "texlive", "tectonic (managed)"; null when the desktop app has no compiler yet. */
  compiler: string | null;
  supports: TexEngine[];
  /** False for the quick compiler: its builds stay on this device. */
  verifiedReads: boolean;
}

function ports(): number[] {
  // UI tests point the web app at a stand-in helper.
  const custom = safeStorage('hivetex.helperPorts');
  return custom ? custom.split(',').map(Number).filter((n) => n > 0 && n < 65536) : PORTS;
}

const base = (port: number) => `http://127.0.0.1:${port}`;

/** Finds a running desktop app (short timeout: the web app must not wait when there is none). */
export async function probeHelper(timeoutMs = 300): Promise<HelperStatus | null> {
  const tries = ports().map(async (port) => {
    const res = await fetch(`${base(port)}/status`, { signal: AbortSignal.timeout(timeoutMs) });
    const s = (await res.json()) as { app?: string; compiler?: string | null; supports?: TexEngine[]; verifiedReads?: boolean };
    if (!res.ok || s.app !== 'hivetex') throw new Error('not a HiveTeX helper');
    return { port, compiler: s.compiler ?? null, supports: s.supports ?? [], verifiedReads: s.verifiedReads === true };
  });
  try {
    return await Promise.any(tries);
  } catch {
    return null;
  }
}

interface Stored {
  port: number;
  token: string;
}

export function helperToken(): Stored | null {
  try {
    const s = JSON.parse(safeStorage(TOKEN_KEY) ?? 'null') as Stored | null;
    return s && typeof s.token === 'string' && typeof s.port === 'number' ? s : null;
  } catch {
    return null;
  }
}

export function forgetHelper() {
  safeStorage(TOKEN_KEY, null);
}

/** Asks the desktop app for permission (the user confirms there). Resolves to whether it was allowed. */
export async function pairHelper(port: number, username: string, server: string): Promise<boolean> {
  const res = await fetch(`${base(port)}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, server }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return false;
  const { token } = (await res.json()) as { token: string };
  safeStorage(TOKEN_KEY, JSON.stringify({ port, token }));
  return true;
}

export type PairResult = 'paired' | 'not-found' | 'no-compiler' | 'denied';

/** Finds the desktop app on this computer and pairs with it (on the user's request: browsers may ask first). */
export async function pairWithDesktop(username: string): Promise<PairResult> {
  const status = await probeHelper(2000);
  if (!status) return 'not-found';
  if (!status.compiler) return 'no-compiler';
  return (await pairHelper(status.port, username, apiBase()).catch(() => false)) ? 'paired' : 'denied';
}

export const PAIR_MESSAGES: Record<Exclude<PairResult, 'paired'>, string> = {
  'not-found': 'The HiveTeX desktop app is not running on this computer (or your browser blocked access to it). Start it and try again.',
  'no-compiler': 'The desktop app has no compiler yet. Open a project there once (it sets one up), then try again.',
  denied: 'The desktop app did not allow it (denied, or no answer within a minute).',
};

const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class HelperEngine implements CompileEngine {
  readonly kind = 'native' as const;
  supports: TexEngine[];
  flavor: string;
  verifiedReads: boolean;

  constructor(
    status: HelperStatus,
    private token: string,
    private project: string,
  ) {
    this.supports = status.supports;
    this.flavor = status.compiler ?? '';
    this.verifiedReads = status.verifiedReads;
    this.port = status.port;
  }

  private port: number;

  async compile(input: CompileInput, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<CompileOutput> {
    const enc = new TextEncoder();
    const files = input.files.map((f) => ({ path: f.path, b64: toB64(f.kind === 'text' ? enc.encode(f.text ?? '') : (f.bytes ?? new Uint8Array())) }));
    let res: Response;
    try {
      res = await fetch(`${base(this.port)}/compile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ main: input.main, engine: input.engine, project: this.project, files }),
        signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs + 30_000)]) : AbortSignal.timeout(opts.timeoutMs + 30_000),
      });
    } catch {
      return { ok: false, log: '! The HiveTeX desktop app did not answer. Is it still running?\n' };
    }
    if (res.status === 401) {
      forgetHelper();
      return { ok: false, log: '! The desktop app no longer allows this browser to compile there. Pair again in Account > Compiler.\n' };
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; log?: string; error?: string; pdfB64?: string | null; synctexB64?: string | null };
    if (!res.ok) return { ok: false, log: `! The desktop app refused the compile: ${body.error ?? res.status}\n` };
    return {
      ok: body.ok === true,
      log: body.log ?? '',
      ...(body.pdfB64 ? { pdf: fromB64(body.pdfB64) } : {}),
      ...(body.synctexB64 ? { synctex: fromB64(body.synctexB64) } : {}),
    };
  }
}
