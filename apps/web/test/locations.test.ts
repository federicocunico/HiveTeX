import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { allLocations, folderLabel, getLocation, migrateLegacyMirrors, removeLocation, setLocation } from '../src/lib/locations.js';

describe('per-device project locations', () => {
  it('stores, lists and removes folder locations; unknown projects live in the app', async () => {
    const f = new IDBFactory();
    expect(await getLocation('p1', f)).toEqual({ kind: 'app' });
    await setLocation('p1', { kind: 'folder', label: 'paper', desktopPath: 'C:/work/paper' }, f);
    expect(await getLocation('p1', f)).toEqual({ kind: 'folder', label: 'paper', desktopPath: 'C:/work/paper' });
    expect(Object.keys(await allLocations(f))).toEqual(['p1']);
    await setLocation('p1', { kind: 'app' }, f);
    expect(await getLocation('p1', f)).toEqual({ kind: 'app' });
    await setLocation('p2', { kind: 'folder', label: 'x' }, f);
    await removeLocation('p2', f);
    expect(await allLocations(f)).toEqual({});
  });

  it('migrates the old localStorage mirror entries once', async () => {
    const f = new IDBFactory();
    const data = new Map([
      ['p2platex.mirror.abc', 'C:\\Users\\me\\thesis'],
      ['other', 'x'],
    ]);
    const storage = {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      removeItem: (k: string) => void data.delete(k),
    };
    expect(await migrateLegacyMirrors(storage, f)).toBe(1);
    expect(await getLocation('abc', f)).toEqual({ kind: 'folder', label: 'thesis', desktopPath: 'C:\\Users\\me\\thesis' });
    expect(data.has('p2platex.mirror.abc')).toBe(false);
    expect(await migrateLegacyMirrors(storage, f)).toBe(0);
    expect(folderLabel('/home/me/paper/')).toBe('paper');
  });
});
