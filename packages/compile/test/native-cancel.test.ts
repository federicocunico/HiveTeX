import { describe, expect, it, vi } from 'vitest';
import { NativeEngine } from '../src/index.js';

const input = { files: [{ path: 'main.tex', kind: 'text' as const, text: 'x' }], main: 'main.tex', engine: 'pdflatex' as const, stateHash: 'h' };
const resp = (o: object = {}) => ({ ok: true, need: [], pdf_b64: null, synctex_b64: null, log: '', timed_out: false, ...o });

/** A Tauri bridge whose tex_compile runs until tex_cancel names its build (as the desktop app kills the process tree). */
function bridge(o: { needFirst?: boolean } = {}) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const running = new Map<string, () => void>();
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, ...(args ? { args } : {}) });
    if (cmd === 'tex_cancel') { running.get(String(args?.build))?.(); return undefined as T; }
    if (o.needFirst && calls.filter((c) => c.cmd === 'tex_compile').length === 1) return resp({ ok: false, need: ['main.tex'] }) as T;
    return new Promise<T>((resolve) => running.set(String(args?.build), () => resolve(resp({ ok: false, log: '! Compilation cancelled\n' }) as T)));
  };
  return { calls, running, invoke };
}

describe('native build cancellation', () => {
  it('names each build and cancels exactly that build when its signal aborts', async () => {
    const b = bridge();
    const engine = new NativeEngine(b.invoke, 'proj');
    const a = new AbortController();
    const build = engine.compile(input, { timeoutMs: 120_000, signal: a.signal });
    // inputs are hashed (crypto.subtle) before the request: wait for it, not for one tick
    await vi.waitFor(() => expect(b.calls).toHaveLength(1));
    const id = b.calls[0]?.args?.build;
    expect(typeof id).toBe('string');
    a.abort();
    const out = await build;
    expect(out.ok).toBe(false);
    expect(out.log).toContain('cancelled');
    expect(b.calls.map((c) => c.cmd)).toEqual(['tex_compile', 'tex_cancel']);
    expect(b.calls[1]?.args).toEqual({ build: id });
    // the next build is a different one: an old cancel cannot stop it
    const next = engine.compile(input, { timeoutMs: 120_000 });
    await vi.waitFor(() => expect(b.calls).toHaveLength(3));
    expect(b.calls[2]?.args?.build).not.toBe(id);
    b.running.get(String(b.calls[2]?.args?.build))?.();
    await next;
  });

  it('does not send the inputs again after a cancel, and does not start an aborted build', async () => {
    const b = bridge({ needFirst: true });
    const engine = new NativeEngine(b.invoke, 'proj');
    const a = new AbortController();
    a.abort();
    expect((await engine.compile(input, { timeoutMs: 1000, signal: a.signal })).log).toContain('cancelled');
    expect(b.calls).toEqual([]);
    const c = new AbortController();
    const build = engine.compile(input, { timeoutMs: 1000, signal: c.signal });
    // the first round asked for content; the second (with content) runs until cancelled
    await vi.waitFor(() => expect(b.calls.filter((x) => x.cmd === 'tex_compile')).toHaveLength(2));
    c.abort();
    expect((await build).ok).toBe(false);
  });
});
