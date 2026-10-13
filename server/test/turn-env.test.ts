import { describe, expect, it } from 'vitest';
import { combineTurn, staticTurn, turnFromEnv } from '../src/signal/turn.js';

const ids = (r: { iceServers: Array<{ urls: string | string[] }> }) => r.iceServers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));

describe('relay configuration from the environment', () => {
  it('has no relay when nothing is configured', () => {
    expect(turnFromEnv({})).toBeUndefined();
    expect(turnFromEnv({ TURN_USERNAME: 'u' })).toBeUndefined(); // half an account is no account
    expect(turnFromEnv({ CF_TURN_KEY_ID: 'k' })).toBeUndefined();
  });

  it('a fixed account defaults to the ExpressTURN free server over UDP and TCP', async () => {
    const t = turnFromEnv({ TURN_USERNAME: 'user1', TURN_CREDENTIAL: 'secret1' });
    const r = await (t as NonNullable<typeof t>).mint(3600);
    expect(ids(r)).toEqual(['turn:free.expressturn.com:3478?transport=udp', 'turn:free.expressturn.com:3478?transport=tcp']);
    expect(r.iceServers[0]).toMatchObject({ username: 'user1', credential: 'secret1' });
  });

  it('takes another server or an explicit URL list', async () => {
    const a = await (turnFromEnv({ TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c', TURN_SERVER: 'relay.example.org:3478' }) as NonNullable<ReturnType<typeof turnFromEnv>>).mint(1);
    expect(ids(a)[0]).toBe('turn:relay.example.org:3478?transport=udp');
    const b = await (turnFromEnv({ TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c', TURN_URLS: 'turn:a.example:80?transport=tcp, turns:a.example:443?transport=tcp' }) as NonNullable<ReturnType<typeof turnFromEnv>>).mint(1);
    expect(ids(b)).toEqual(['turn:a.example:80?transport=tcp', 'turns:a.example:443?transport=tcp']);
  });

  it('Cloudflare and a fixed account together give every server that worked', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ iceServers: { urls: ['turn:cf.example:3478'], username: 'x', credential: 'y' } }))) as unknown as typeof fetch;
    const t = turnFromEnv({ CF_TURN_KEY_ID: 'k', CF_TURN_API_TOKEN: 't', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' }, fetchFn) as NonNullable<ReturnType<typeof turnFromEnv>>;
    const all = ids(await t.mint(3600));
    expect(all).toContain('turn:cf.example:3478');
    expect(all).toContain('turn:free.expressturn.com:3478?transport=udp');
  });

  it('one failing provider does not take the other down; all failing does', async () => {
    const bad = { mint: async () => { throw new Error('down'); } };
    const good = staticTurn({ urls: ['turn:g.example:3478'], username: 'u', credential: 'c' });
    expect(ids(await combineTurn([bad, good]).mint(1))).toEqual(['turn:g.example:3478']);
    await expect(combineTurn([bad, bad]).mint(1)).rejects.toThrow(/no relay provider/);
  });
});
