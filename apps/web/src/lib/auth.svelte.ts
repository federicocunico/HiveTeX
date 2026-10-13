import { ApiError, api, isDesktop, sessionOrigin, setBearer, setLocalMode } from './api.js';

import { userCacheKey } from './remembered-session.js';
import { activateRuntimes, stopRuntimes } from './runtimes.js';
import { activateDesktopSeeds } from './seeds.js';

export interface User {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
}

/** `local`: the desktop app is used without an account (local mode): nothing is sent to any server. */
export const auth = $state<{ user: User | null; ready: boolean; offline: boolean; local: boolean }>({ user: null, ready: false, offline: false, local: false });

let authRevision = 0;
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
export async function enterLocalMode() {
  const revision = ++authRevision;
  await stopRuntimes();
  if (revision !== authRevision) return;
  storeLocal(true);
  setLocalMode(true);
  auth.user = LOCAL_USER;
  auth.local = true;
  auth.offline = false;
  auth.ready = true;
  activateRuntimes(LOCAL_USER.id);
  await activateDesktopSeeds(LOCAL_USER.id);
}

/** Leaves local mode (before signing in or registering): requests to the server are allowed again. */
export function leaveLocalMode() {
  authRevision++;
  storeLocal(false);
  setLocalMode(false);
  auth.local = false;
  if (auth.user?.id === LOCAL_USER.id) auth.user = null;
}

const cacheKey = () => isDesktop ? userCacheKey(sessionOrigin()) : 'hivetex.user';

function cacheUser(u: User | null) {
  try {
    if (u) localStorage.setItem(cacheKey(), JSON.stringify(u));
    else localStorage.removeItem(cacheKey());
  } catch {
    /* storage unavailable */
  }
}

/** Loads the session. When the server is unreachable, falls back to the cached user so local projects still open. */
export async function loadMe() {
  const origin = sessionOrigin();
  const revision = authRevision;
  let local = false;
  try {
    local = isDesktop && localStorage.getItem(LOCAL_KEY) === '1';
  } catch {
    local = false;
  }
  if (local) return enterLocalMode();
  try {
    const r = await api<{ user: User }>('GET', '/auth/me');
    if (origin !== sessionOrigin() || revision !== authRevision) return;
    auth.user = r.user;
    auth.offline = false;
    cacheUser(r.user);
  } catch (e) {
    if (origin !== sessionOrigin() || revision !== authRevision) return;
    if (e instanceof ApiError && e.status === 0) {
      try {
        const raw = localStorage.getItem(cacheKey());
        auth.user = raw ? (JSON.parse(raw) as User) : null;
      } catch {
        auth.user = null;
      }
      auth.offline = true;
    } else {
      auth.user = null;
      auth.offline = false;
      if (e instanceof ApiError && e.status === 401) cacheUser(null);
    }
  } finally {
    if (origin === sessionOrigin() && revision === authRevision && auth.user) {
      activateRuntimes(auth.user.id);
      await activateDesktopSeeds(auth.user.id).catch(() => { /* dashboard exposes native availability errors */ });
    }
    auth.ready = true;
  }
}

async function finish(r: { user: User; token?: string }, revision: number, origin: string) {
  await stopRuntimes();
  if (revision !== authRevision || origin !== sessionOrigin()) throw new ApiError(0, 'session_changed', 'Sign-in was cancelled. Please try again.');
  storeLocal(false);
  setLocalMode(false);
  auth.local = false;
  if (r.token) await setBearer(r.token);
  if (revision !== authRevision || origin !== sessionOrigin()) throw new ApiError(0, 'session_changed', 'Sign-in was cancelled. Please try again.');
  auth.user = r.user;
  auth.offline = false;
  cacheUser(r.user);
  activateRuntimes(r.user.id);
  await activateDesktopSeeds(r.user.id).catch(() => { /* dashboard exposes native availability errors */ });
  if (revision !== authRevision || origin !== sessionOrigin()) throw new ApiError(0, 'session_changed', 'Sign-in was cancelled. Please try again.');
  return r.user;
}

/** Signing in from local mode: the server may be contacted for this request; if it fails, local mode stays locked down. */
async function fromLocal(req: () => Promise<{ user: User; token?: string }>) {
  setLocalMode(false);
  const origin = sessionOrigin();
  const revision = ++authRevision;
  try {
    const result = await req();
    if (origin !== sessionOrigin() || revision !== authRevision) throw new ApiError(0, 'server_changed', 'The server changed. Please try again.');
    return await finish(result, revision, origin);
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
  authRevision++;
  // Capture the request's credential, then clear local authorization before waiting for the network.
  const revoking = api('POST', '/auth/logout').catch(() => {});
  auth.user = null;
  cacheUser(null);
  await Promise.all([setBearer(null), stopRuntimes(), revoking]);
}

export async function logoutAll() {
  authRevision++;
  const revoking = api('POST', '/auth/logout-all');
  auth.user = null;
  cacheUser(null);
  await Promise.all([setBearer(null), stopRuntimes(), revoking]);
}

/** An authoritative server rejection ends online authorization and its cached identity. */
export async function invalidateSession() {
  authRevision++;
  auth.user = null;
  auth.offline = false;
  cacheUser(null);
  await stopRuntimes();
}
