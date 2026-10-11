import { ApiError, api, isDesktop, setBearer, setLocalMode } from './api.js';

export interface User {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
}

/** `local`: the desktop app is used without an account (local mode): nothing is sent to any server. */
export const auth = $state<{ user: User | null; ready: boolean; offline: boolean; local: boolean }>({ user: null, ready: false, offline: false, local: false });

const LOCAL_KEY = 'hivetex.localMode';
/** The person using the desktop app without an account. */
export const LOCAL_USER: User = { id: 'local', username: 'You', email: '', emailVerified: false, isAdmin: false };

function storeLocal(on: boolean) {
  try {
    if (on) localStorage.setItem(LOCAL_KEY, '1');
    else localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Desktop: continue without an account. Remembered, so the app opens in local mode next time. */
export function enterLocalMode() {
  storeLocal(true);
  setLocalMode(true);
  auth.user = LOCAL_USER;
  auth.local = true;
  auth.offline = false;
  auth.ready = true;
}

/** Leaves local mode (before signing in or registering): requests to the server are allowed again. */
export function leaveLocalMode() {
  storeLocal(false);
  setLocalMode(false);
  auth.local = false;
  if (auth.user?.id === LOCAL_USER.id) auth.user = null;
}

const CACHE_KEY = 'hivetex.user';

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
  let local = false;
  try {
    local = isDesktop && localStorage.getItem(LOCAL_KEY) === '1';
  } catch {
    local = false;
  }
  if (local) return enterLocalMode();
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
  storeLocal(false);
  setLocalMode(false);
  auth.local = false;
  if (r.token) setBearer(r.token);
  auth.user = r.user;
  auth.offline = false;
  cacheUser(r.user);
  return r.user;
}

/** Signing in from local mode: the server may be contacted for this request; if it fails, local mode stays locked down. */
async function fromLocal(req: () => Promise<{ user: User; token?: string }>) {
  setLocalMode(false);
  try {
    return await finish(await req());
  } catch (e) {
    if (auth.local) setLocalMode(true);
    throw e;
  }
}

const kind = () => (isDesktop ? 'desktop' : 'web');

export async function login(identifier: string, password: string) {
  return fromLocal(() => api('POST', '/auth/login', { identifier, password, kind: kind() }));
}

export async function register(username: string, email: string, password: string) {
  return fromLocal(() => api('POST', '/auth/register', { username, email, password, kind: kind() }));
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
