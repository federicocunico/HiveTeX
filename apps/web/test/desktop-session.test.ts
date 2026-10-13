// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionKey, userCacheKey } from '../src/lib/remembered-session.js';
const { secure, values } = vi.hoisted(() => {
  const values = new Map<string, string>();
  return { values, secure: { get: vi.fn(async (k: string) => values.get(k) ?? null), set: vi.fn(async (k: string, v: string) => { values.set(k, v); }), delete: vi.fn(async (k: string) => { values.delete(k); }) } };
});
vi.mock('../src/lib/secure.js', () => ({ secure }));
const A = 'https://a.example';
const B = 'https://b.example';
const user = { id: 'account-a', username: 'alice', email: 'alice@example.test', emailVerified: true, isAdmin: false };
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  values.clear();
  localStorage.clear();
  localStorage.setItem('serverUrl', A);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ user, token: 'issued-token' })));
});
describe('desktop sign-in lifecycle', () => {
  it('persists login before completing and restores it before account loading', async () => {
    const api = await import('../src/lib/api.js');
    const { login, auth } = await import('../src/lib/auth.svelte.js');
    await login('alice', 'password');
    expect(values.get(sessionKey(A))).toBe('issued-token');
    expect(auth.user?.id).toBe(user.id);
    vi.resetModules();
    const restarted = await import('../src/lib/api.js');
    await restarted.initBearer();
    await (await import('../src/lib/auth.svelte.js')).loadMe();
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: 'Bearer issued-token' });
    expect(api.isDesktop).toBe(true);
  });
  it('reports failed persistence while keeping the successful current session, and retries', async () => {
    secure.set.mockRejectedValueOnce(new Error('locked'));
    const api = await import('../src/lib/api.js');
    const { login, auth } = await import('../src/lib/auth.svelte.js');
    await login('alice', 'password');
    expect(auth.user?.id).toBe(user.id);
    const { sessionNotice } = await import('../src/lib/session-notice.svelte.js');
    expect(sessionNotice.message).toContain('could not be remembered');
    await api.api('GET', '/auth/me');
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: 'Bearer issued-token' });
    await sessionNotice.retry?.();
    expect(values.get(sessionKey(A))).toBe('issued-token');
    expect(sessionNotice.message).toBe('');
  });
  it('cannot send A credentials or cached user to B, including switching back', async () => {
    values.set(sessionKey(A), 'token-a');
    localStorage.setItem(userCacheKey(A), JSON.stringify(user));
    const api = await import('../src/lib/api.js');
    await api.initBearer();
    api.setServerUrl(B);
    await api.api('GET', '/auth/me');
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty('Authorization');
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    const account = await import('../src/lib/auth.svelte.js');
    await account.loadMe();
    expect(account.auth.user).toBeNull();
    api.setServerUrl(A);
    await api.initBearer();
    await api.api('GET', '/auth/me');
    expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).toMatchObject({ Authorization: 'Bearer token-a' });
  });
  it('uses the effective development proxy origin for remembered credentials', async () => {
    localStorage.removeItem('serverUrl');
    const api = await import('../src/lib/api.js');
    expect(api.sessionOrigin()).toBe('http://localhost:3000');
    await api.setBearer('dev-token');
    expect(values.get(sessionKey('http://localhost:3000'))).toBe('dev-token');
    expect(values.get(sessionKey(A))).toBeUndefined();
  });
  it('forgets an authoritative rejection but retains credentials for an outage', async () => {
    values.set(sessionKey(A), 'saved-token');
    localStorage.setItem(userCacheKey(A), JSON.stringify(user));
    const api = await import('../src/lib/api.js');
    await api.initBearer();
    const account = await import('../src/lib/auth.svelte.js');
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    await account.loadMe();
    expect(account.auth.user?.id).toBe(user.id);
    expect(account.auth.offline).toBe(true);
    expect(values.get(sessionKey(A))).toBe('saved-token');
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: 'unauthenticated', message: 'Sign in required' } }, { status: 401 }));
    await account.loadMe();
    expect(account.auth.user).toBeNull();
    expect(values.has(sessionKey(A))).toBe(false);
    expect(localStorage.getItem(userCacheKey(A))).toBeNull();
  });
  it('lets a locked-store retry restore the account without deleting the unread session', async () => {
    values.set(sessionKey(A), 'saved-token');
    secure.get.mockRejectedValueOnce(new Error('locked'));
    const api = await import('../src/lib/api.js');
    await api.initBearer();
    const { sessionNotice } = await import('../src/lib/session-notice.svelte.js');
    expect(sessionNotice.message).toContain('could not be read');
    expect(secure.delete).not.toHaveBeenCalled();
    await sessionNotice.retry?.();
    expect((await import('../src/lib/auth.svelte.js')).auth.user?.id).toBe(user.id);
    expect(sessionNotice.message).toBe('');
  });
  it('retains local mode and makes no restoration request when used without an account', async () => {
    localStorage.setItem('hivetex.localMode', '1');
    const { loadMe, auth } = await import('../src/lib/auth.svelte.js');
    await loadMe();
    expect(auth.local).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('clears local authorization immediately while server sign-out is pending', async () => {
  const api = await import('../src/lib/api.js');
  const account = await import('../src/lib/auth.svelte.js');
  await account.login('alice', 'password');
  let resolve!: (r: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(r => { resolve = r; }));
  const signingOut = account.logout();
  expect(account.auth.user).toBeNull();
  await api.api('GET', '/auth/me');
  expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty('Authorization');
  resolve(Response.json({ ok: true }));
  await signingOut;
  expect(values.has(sessionKey(A))).toBe(false);
});

it('does not resurrect account state when logout overtakes a credential write', async () => {
  const account = await import('../src/lib/auth.svelte.js');
  let release!: () => void;
  secure.set.mockImplementationOnce(async (key, token) => { await new Promise<void>(r => { release = r; }); values.set(key, token); });
  const login = account.login('alice', 'password');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const logout = account.logout();
  release();
  await expect(login).rejects.toMatchObject({ code: 'session_changed' });
  await logout;
  expect(account.auth.user).toBeNull();
  expect(values.has(sessionKey(A))).toBe(false);
});

it('does not apply A account state to B when the server changes during a credential write', async () => {
  const api = await import('../src/lib/api.js');
  const account = await import('../src/lib/auth.svelte.js');
  let release!: () => void;
  secure.set.mockImplementationOnce(async (key, token) => { await new Promise<void>(r => { release = r; }); values.set(key, token); });
  const login = account.login('alice', 'password');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  api.setServerUrl(B);
  release();
  await expect(login).rejects.toMatchObject({ code: 'session_changed' });
  expect(account.auth.user).toBeNull();
  expect(localStorage.getItem(userCacheKey(B))).toBeNull();
  await api.api('GET', '/auth/me');
  expect(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty('Authorization');
  expect(values.get(sessionKey(A))).toBe('issued-token');
});
