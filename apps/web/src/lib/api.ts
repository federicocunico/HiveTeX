/// <reference types="vite/client" />

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The server desktop builds use unless the build or the user chooses another one. */
export const DEFAULT_SERVER = 'https://hivetex.vercel.app';

/**
 * Which control plane to talk to ('' = the page's own origin):
 * web: always its own origin; desktop: the user's choice, else (under `make dev`) the dev server's proxy, else the
 * build's server (forks / on-premise builds), else the built-in default.
 */
export function resolveServer(o: { desktop: boolean; stored: string | null; dev: boolean; buildDefault: string | undefined }): string {
  if (!o.desktop) return '';
  if (o.stored) return o.stored.replace(/\/$/, '');
  if (o.dev) return '';
  return (o.buildDefault || DEFAULT_SERVER).replace(/\/$/, '');
}

/** The server this build falls back to when the user has not chosen one ('' under `make dev`: the dev proxy). */
export function defaultServer(): string {
  return resolveServer({ desktop: isDesktop, stored: null, dev: import.meta.env.DEV, buildDefault: import.meta.env.VITE_API_BASE });
}

/** Web: same origin as the page. Desktop: absolute URL of the control plane (see resolveServer). */
export function apiBase(): string {
  return resolveServer({ desktop: isDesktop, stored: safeStorage('serverUrl'), dev: import.meta.env.DEV, buildDefault: import.meta.env.VITE_API_BASE });
}

/** Desktop: forgets the user's choice, so the build's default server is used again (after a reload). */
export function useDefaultServer() {
  safeStorage('serverUrl', null);
}

/** Human-readable server for the settings ('' means the dev proxy or the page's own origin). */
export function serverLabel(base = apiBase()): string {
  if (base) return base;
  return import.meta.env.DEV ? `${import.meta.env.VITE_DEV_PROXY_TARGET || 'local'} (through the dev server)` : location.origin;
}

export function wsBase(): string {
  const base = apiBase() || location.origin;
  return base.replace(/^http/, 'ws');
}

/**
 * Validates a server address typed by the user and returns its origin: `https://` only (plain `http://` is allowed for
 * `localhost` during development). Throws a readable error otherwise.
 */
export function parseServerUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim().includes('://') ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new Error('Enter a server address like https://your-app.vercel.app');
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The server address must start with https://');
  if (!u.hostname) throw new Error('Enter a server address like https://your-app.vercel.app');
  return u.origin;
}

/** Desktop: remembers the server this device talks to (takes effect after a reload). */
export function setServerUrl(input: string): string {
  const origin = parseServerUrl(input);
  safeStorage('serverUrl', origin);
  return origin;
}

export function safeStorage(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return value;
  } catch {
    return null;
  }
}

let bearer: string | null = null;

/** Desktop: loads the session token from the OS credential store before the app starts. */
export async function initBearer() {
  if (!isDesktop) return;
  const { secure } = await import('./secure.js');
  bearer = await secure.get('session-token').catch(() => null);
}

export async function setBearer(token: string | null) {
  bearer = token;
  if (isDesktop) {
    const { secure } = await import('./secure.js');
    await (token ? secure.set('session-token', token) : secure.delete('session-token'));
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The server's `Retry-After` (rate limits), in milliseconds. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Desktop local mode (no account): no request may reach any server (local-mode spec). */
let localMode = false;
export function setLocalMode(on: boolean) {
  localMode = on;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  // Behaves like "no network": every caller already falls back to working on this device.
  if (localMode) throw new ApiError(0, 'local_mode', 'Not signed in: this computer works in local mode.');
  const headers: Record<string, string> = { 'X-Requested-With': 'hivetex' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/api${path}`, {
      method,
      headers,
      credentials: isDesktop ? 'omit' : 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server (you can keep working offline).');
  }
  let json: { error?: { code: string; message: string } } & Record<string, unknown> = {};
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const retry = Number(res.headers.get('Retry-After'));
    throw new ApiError(res.status, json.error?.code ?? 'error', json.error?.message ?? res.statusText, Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined);
  }
  return json as T;
}
