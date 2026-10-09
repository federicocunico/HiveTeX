import { open as openEnvelope } from '@p2platex/crypto';
import { api, isDesktop } from './api.js';
import { localKeys } from './keys.js';
import { secure } from './secure.js';

/**
 * GitHub tokens live only on this device: the OS credential store on desktop, sessionStorage in the browser
 * (so they vanish when the tab closes). The control plane only ever sees a sealed hand-off during connect.
 */
interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

const KEY = 'github-tokens';

async function load(): Promise<Tokens | null> {
  try {
    const raw = isDesktop ? await secure.get(KEY) : sessionStorage.getItem(`p2platex.${KEY}`);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

async function save(t: Tokens | null) {
  try {
    if (isDesktop) {
      if (t) await secure.set(KEY, JSON.stringify(t));
      else await secure.delete(KEY);
    } else if (t) sessionStorage.setItem(`p2platex.${KEY}`, JSON.stringify(t));
    else sessionStorage.removeItem(`p2platex.${KEY}`);
  } catch {
    /* storage unavailable: the user will be asked to reconnect */
  }
}

/** A valid access token, refreshed through the control plane when it is about to expire; null if not connected. */
export async function getGithubToken(): Promise<string | null> {
  const t = await load();
  if (!t) return null;
  if (!t.expires_at || t.expires_at - Date.now() > 60_000) return t.access_token;
  if (!t.refresh_token) return null;
  try {
    const r = await api<{ access_token: string; refresh_token?: string; expires_in?: number }>('POST', '/github/refresh', { refreshToken: t.refresh_token });
    const next: Tokens = {
      access_token: r.access_token,
      ...(r.refresh_token ? { refresh_token: r.refresh_token } : {}),
      ...(r.expires_in ? { expires_at: Date.now() + r.expires_in * 1000 } : {}),
    };
    await save(next);
    return next.access_token;
  } catch {
    await save(null);
    return null;
  }
}

export async function githubLink(): Promise<{ login: string; id: number } | null> {
  try {
    return (await api<{ link: { login: string; id: number } | null }>('GET', '/github/link')).link;
  } catch {
    return null;
  }
}

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Starts the GitHub App authorization in the user's browser and waits for the sealed token hand-off. */
export async function connectGithub(userId: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  const keys = (await localKeys(userId)).keys;
  const handoff = b64u(crypto.getRandomValues(new Uint8Array(24)));
  // Open the window synchronously (inside the click handler) so popup blockers allow it.
  const popup = isDesktop ? null : window.open('', '_blank');
  const { url } = await api<{ url: string }>('POST', '/github/start', { handoff, pub: keys.xPub });
  if (isDesktop) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else if (popup) popup.location.href = url;
  else window.location.href = url;

  const end = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 1500));
    const h = await api<{ ready: boolean; serverPub?: string; env?: string }>('GET', `/github/handoff/${handoff}`).catch(() => ({ ready: false }) as { ready: false });
    if (h.ready && 'env' in h && h.env && h.serverPub) {
      const plain = await openEnvelope(keys, h.serverPub, Uint8Array.from(atob(h.env), (c) => c.charCodeAt(0)), `gh-handoff|${handoff}`);
      const tok = JSON.parse(new TextDecoder().decode(plain)) as { access_token: string; refresh_token?: string; expires_in?: number };
      await save({
        access_token: tok.access_token,
        ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
        ...(tok.expires_in ? { expires_at: Date.now() + tok.expires_in * 1000 } : {}),
      });
      return;
    }
  }
  throw new Error('GitHub authorization timed out');
}

export async function disconnectGithub() {
  await save(null);
  await api('DELETE', '/github/link').catch(() => {});
}
