// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RememberedSession, sessionKey, userCacheKey } from '../src/lib/remembered-session.js';
const A = 'https://a.example';
const B = 'https://b.example';
beforeEach(() => localStorage.clear());
function fixture() {
  const values = new Map<string, string>();
  const secure = { get: vi.fn(async (k: string) => values.get(k) ?? null), set: vi.fn(async (k: string, v: string) => { values.set(k, v); }), delete: vi.fn(async (k: string) => { values.delete(k); }) };
  return { values, secure, store: new RememberedSession(secure, localStorage) };
}
describe('remembered desktop credentials', () => {
  it('awaits a save, restores after restart and isolates different servers', async () => {
    const { secure, store } = fixture();
    await store.save(A, 'token-a');
    await store.save(B, 'token-b');
    const restarted = new RememberedSession(secure, localStorage);
    expect(await restarted.load(A)).toMatchObject({ ok: true, token: 'token-a' });
    expect(await restarted.load(B)).toMatchObject({ ok: true, token: 'token-b' });
    expect(sessionKey(A + '/anything')).toBe(sessionKey(A));
    expect(userCacheKey(A)).not.toBe(userCacheKey(B));
  });
  it('reports save failure, suppresses old credentials, and permits retry', async () => {
    const { secure, store, values } = fixture();
    values.set(sessionKey(A), 'old-token');
    secure.set.mockRejectedValueOnce(new Error('locked'));
    expect(await store.save(A, 'new-token')).toMatchObject({ ok: false, action: 'save' });
    expect(await new RememberedSession(secure, localStorage).load(A)).toMatchObject({ ok: true, token: null });
    expect(await store.save(A, 'new-token')).toMatchObject({ ok: true });
    expect(await store.load(A)).toMatchObject({ token: 'new-token' });
  });
  it('reports an unavailable read without deleting the credential', async () => {
    const { secure, store, values } = fixture();
    values.set(sessionKey(A), 'saved');
    secure.get.mockRejectedValueOnce(new Error('locked'));
    expect(await store.load(A)).toMatchObject({ ok: false, action: 'read' });
    expect(secure.delete).not.toHaveBeenCalled();
    expect(await store.load(A)).toMatchObject({ token: 'saved' });
  });
  it('does not restore a delayed login after logout, even if deletion fails', async () => {
    const { store, secure, values } = fixture();
    let release!: () => void;
    secure.set.mockImplementationOnce(async (key, token) => { await new Promise<void>(r => { release = r; }); values.set(key, token); });
    const save = store.save(A, 'late-token');
    await Promise.resolve();
    const forget = store.forget(A);
    secure.delete.mockRejectedValue(new Error('locked'));
    release();
    await save;
    expect(await forget).toMatchObject({ ok: false, action: 'delete' });
    expect(await new RememberedSession(secure, localStorage).load(A)).toMatchObject({ token: null });
  });
  it('never attributes an old token to whichever server is selected', async () => {
    const { values, store, secure } = fixture();
    values.set('session-token', 'unattributed');
    localStorage.setItem('hivetex.user', '{"id":"old"}');
    expect(await store.load(B)).toMatchObject({ ok: true, token: null, legacy: true });
    expect(secure.set).not.toHaveBeenCalled();
    expect(localStorage.getItem(userCacheKey(B))).toBeNull();
    await store.save(B, 'new');
    expect(values.has('session-token')).toBe(false);
    expect(localStorage.getItem('hivetex.user')).toBeNull();
  });
  it('migrates an explicitly attributed old credential and its user only to that origin', async () => {
    const { values, store } = fixture();
    values.set('session-token', 'old-token');
    localStorage.setItem('hivetex.session-origin', A);
    localStorage.setItem('hivetex.user', '{"id":"old"}');
    expect(await store.load(B)).toMatchObject({ token: null, legacy: true });
    expect(await store.load(A)).toMatchObject({ token: 'old-token' });
    expect(localStorage.getItem(userCacheKey(A))).toBe('{"id":"old"}');
    expect(localStorage.getItem(userCacheKey(B))).toBeNull();
  });
});
