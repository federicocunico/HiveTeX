/// <reference types="vite/client" />

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Web: same origin as the page. Desktop: absolute URL of the hosted control plane (configurable). */
export function apiBase(): string {
  const stored = safeStorage('serverUrl');
  return (stored ?? import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
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

export function setBearer(token: string | null) {
  bearer = token;
  if (isDesktop) {
    void import('./secure.js').then(({ secure }) => (token ? secure.set('session-token', token) : secure.delete('session-token'))).catch(() => {});
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'p2platex' };
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
  if (!res.ok) throw new ApiError(res.status, json.error?.code ?? 'error', json.error?.message ?? res.statusText);
  return json as T;
}
