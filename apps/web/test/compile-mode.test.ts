import { describe, expect, it } from 'vitest';
import { COMPILE_MODE_KEY, compileMigrationPending, dismissCompileMigrationNotice, readCompileMode } from '../src/lib/compile-mode.js';

function preferences(mode: string | null) {
  const values = new Map<string, string>(mode === null ? [] : [[COMPILE_MODE_KEY, mode]]);
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('local-only compiler preference', () => {
  it.each(['auto', 'peers'])('migrates %s permanently to local and explains the change until dismissed', (old) => {
    const storage = preferences(old);
    expect(readCompileMode(storage)).toBe('local');
    expect(storage.values.get(COMPILE_MODE_KEY)).toBe('local');
    // A session that reads the notice and closes before the member sees it does not consume it.
    expect(compileMigrationPending(storage)).toBe(true);
    expect(compileMigrationPending(storage)).toBe(true);
    expect(readCompileMode(storage)).toBe('local');
    expect(compileMigrationPending(storage)).toBe(true);
    dismissCompileMigrationNotice(storage);
    expect(compileMigrationPending(storage)).toBe(false);
    expect(readCompileMode(storage)).toBe('local');
    expect(compileMigrationPending(storage)).toBe(false);
  });
  it.each([null, 'local', 'unknown'])('keeps local builds without a migration notice for %s', (old) => {
    const storage = preferences(old);
    expect(readCompileMode(storage)).toBe('local');
    expect(compileMigrationPending(storage)).toBe(false);
    dismissCompileMigrationNotice(storage);
    expect(storage.values.has('hivetex.compileMigrationNotice')).toBe(false);
  });
  it('remains local when storage is unavailable', () => {
    const storage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readCompileMode(storage)).toBe('local');
    expect(compileMigrationPending(storage)).toBe(false);
    expect(() => dismissCompileMigrationNotice(storage)).not.toThrow();
  });
});
