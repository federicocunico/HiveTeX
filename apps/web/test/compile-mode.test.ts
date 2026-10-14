import { describe, expect, it } from 'vitest';
import { COMPILE_MODES, COMPILE_MODE_KEY, compileTargets, policyFor, readCompileMode } from '../src/lib/compile-mode.js';

const store = (v: string | null) => ({ getItem: (k: string) => (k === COMPILE_MODE_KEY ? v : null), setItem: () => {} });

describe('compiler preference', () => {
  it('defaults to this device (local) and ignores unknown values', () => {
    expect(readCompileMode(store(null))).toBe('local');
    expect(readCompileMode(store('weird'))).toBe('local');
    expect(readCompileMode(store('peers'))).toBe('peers');
    expect(readCompileMode(store('local'))).toBe('local');
    expect(readCompileMode(undefined)).toBe('local');
  });
  it('moves the old shared default to local once; a shared mode chosen afterwards stays (deprecated, still available)', () => {
    const items = new Map<string, string>([['hivetex.compileMode', 'auto']]);
    const s = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => void items.set(k, v) };
    expect(readCompileMode(s)).toBe('local');
    expect(items.get('hivetex.compileMode')).toBe('local');
    items.set('hivetex.compileMode', 'auto'); // chosen again in Account > Compiler
    expect(readCompileMode(s)).toBe('auto');
    expect(COMPILE_MODES.find((m) => m.id === 'auto')?.deprecated).toBe(true);
    expect(COMPILE_MODES[0]?.id).toBe('local');
  });
  it("automatic: loads a compiler, leads unless 'compile for others' is off, shows the leader's PDFs", () => {
    expect(policyFor('auto', true)).toEqual({ loadEngine: true, optOut: false, autoLocal: false, acceptRemote: true });
    expect(policyFor('auto', false).optOut).toBe(true);
  });
  it("use peers: never loads a compiler or leads, shows the leader's PDFs", () => {
    expect(policyFor('peers', true)).toEqual({ loadEngine: false, optOut: true, autoLocal: false, acceptRemote: true });
  });
  it("this device only: compiles here after edits, never leads, ignores others' PDFs", () => {
    expect(policyFor('local', true)).toEqual({ loadEngine: true, optOut: true, autoLocal: true, acceptRemote: false });
  });
});

describe('explicit compile request', () => {
  const base = { amLeader: false, leaderExists: false, autoLocal: false, hasEngine: true };
  it('a device showing only its own results builds here, even with a leader or co-authors around', () => {
    expect(compileTargets({ ...base, autoLocal: true, leaderExists: true })).toEqual({ runLeader: false, request: false, local: true });
    expect(compileTargets({ ...base, autoLocal: true, hasEngine: false }).local).toBe(false);
  });
  it('the leader runs its own build once (no extra local build)', () => {
    expect(compileTargets({ ...base, amLeader: true, leaderExists: true })).toEqual({ runLeader: true, request: false, local: false });
  });
  it('another device leads: ask it, do not build here', () => {
    expect(compileTargets({ ...base, leaderExists: true })).toEqual({ runLeader: false, request: true, local: false });
  });
  it('nobody leads: ask anyway and build here when this device has a compiler', () => {
    expect(compileTargets(base)).toEqual({ runLeader: false, request: true, local: true });
    expect(compileTargets({ ...base, hasEngine: false })).toEqual({ runLeader: false, request: true, local: false });
  });
});
