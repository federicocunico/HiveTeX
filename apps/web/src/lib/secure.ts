import { isDesktop } from './api.js';

/**
 * Desktop-only secret storage backed by the OS credential store (Rust `secret_*` commands).
 * On the web there is nothing to store: sessions use HttpOnly cookies and device keys are non-extractable.
 */
async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export const secure = {
  available: isDesktop,
  async get(key: string): Promise<string | null> {
    return isDesktop ? await call<string | null>('secret_get', { key }) : null;
  },
  async set(key: string, value: string): Promise<void> {
    if (isDesktop) await call('secret_set', { key, value });
  },
  async delete(key: string): Promise<void> {
    if (isDesktop) await call('secret_delete', { key });
  },
};
