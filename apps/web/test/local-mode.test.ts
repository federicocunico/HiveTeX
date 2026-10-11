// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setLocalMode } from '../src/lib/api.js';

describe('local mode', () => {
  afterEach(() => {
    setLocalMode(false);
    vi.restoreAllMocks();
  });

  it('refuses every request without touching the network, as if offline', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    setLocalMode(true);
    const err = await api('GET', '/auth/me').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('local_mode');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
