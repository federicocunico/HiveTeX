import { describe, expect, it } from 'vitest';
import { COMPILE_MODE_KEY, compileTargets, policyFor, readCompileMode } from '../src/lib/compile-mode.js';

const store = (v: string | null) => ({ getItem: (k: string) => (k === COMPILE_MODE_KEY ? v : null) });

describe('compiler preference', () => {
  it('defaults to automatic and ignores unknown values', () => {
    expect(readCompileMode(store(null))).toBe('auto');
    expect(readCompileMode(store('weird'))).toBe('auto');
    expect(readCompileMode(store('peers'))).toBe('peers');
    expect(readCompileMode(store('local'))).toBe('local');
    expect(readCompileMode(undefined)).toBe('auto');
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
