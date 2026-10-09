import { ApiError, api, isDesktop, setBearer } from './api.js';

export interface User {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
}

export const auth = $state<{ user: User | null; ready: boolean; offline: boolean }>({ user: null, ready: false, offline: false });

const CACHE_KEY = 'p2platex.user';

function cacheUser(u: User | null) {
  try {
    if (u) localStorage.setItem(CACHE_KEY, JSON.stringify(u));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Loads the session. When the server is unreachable, falls back to the cached user so local projects still open. */
export async function loadMe() {
  try {
    const r = await api<{ user: User }>('GET', '/auth/me');
    auth.user = r.user;
    auth.offline = false;
    cacheUser(r.user);
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) {
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        auth.user = raw ? (JSON.parse(raw) as User) : null;
      } catch {
        auth.user = null;
      }
      auth.offline = true;
    } else {
      auth.user = null;
      auth.offline = false;
    }
  } finally {
    auth.ready = true;
  }
}

async function finish(r: { user: User; token?: string }) {
  if (r.token) setBearer(r.token);
  auth.user = r.user;
  auth.offline = false;
  cacheUser(r.user);
  return r.user;
}

const kind = () => (isDesktop ? 'desktop' : 'web');

export async function login(identifier: string, password: string) {
  return finish(await api('POST', '/auth/login', { identifier, password, kind: kind() }));
}

export async function register(username: string, email: string, password: string) {
  return finish(await api('POST', '/auth/register', { username, email, password, kind: kind() }));
}

export async function logout() {
  try {
    await api('POST', '/auth/logout');
  } catch {
    /* ignore */
  }
  setBearer(null);
  auth.user = null;
  cacheUser(null);
}

export async function logoutAll() {
  await api('POST', '/auth/logout-all');
  setBearer(null);
  auth.user = null;
  cacheUser(null);
}
