import { describe, expect, it } from 'vitest';
import { COMPILE_MODE_KEY, policyFor, readCompileMode } from '../src/lib/compile-mode.js';

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
